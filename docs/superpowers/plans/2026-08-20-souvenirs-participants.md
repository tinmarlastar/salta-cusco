# Souvenirs des participants — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre aux participants du raid de poster notes, photos et vidéos sur chaque étape depuis le terrain, avec un réseau capricieux, sans créer de compte.

**Architecture:** Un Worker Cloudflare sert d'intermédiaire entre le site statique (GitHub Pages) et le stockage : R2 pour les fichiers, D1 pour les notes et métadonnées. Côté navigateur, un module réseau et une file d'attente IndexedDB garantissent qu'un envoi raté en zone blanche se renvoie tout seul. Le site reste statique et continue de fonctionner si le Worker est éteint.

**Tech Stack:** Cloudflare Workers, R2, D1 (SQLite), Wrangler ; JavaScript modules ES sans framework ; `node --test` (intégré à Node 20) pour les fonctions pures du Worker.

**Spec:** `docs/superpowers/specs/2026-08-20-souvenirs-participants-design.md`

## Global Constraints

- **Tout est en français** : interface, messages d'erreur, commentaires, noms de variables et de fonctions. C'est la convention du projet (`CLAUDE.md`), l'enfreindre casse l'homogénéité.
- **Node 20+** requis (Wrangler l'exige). Disponible : v20.17.0.
- **Aucune dépendance ajoutée au site publié.** Le site ne charge ni CDN ni bibliothèque. Wrangler est un outil de développement, jamais servi au navigateur.
- **Les secrets ne sont jamais dans le dépôt.** Mots de passe posés via `wrangler secret put`.
- **Plafonds** : notes 2000 caractères ; photos redimensionnées à 1600 px de large, JPEG qualité 0.82 ; vidéos 60 Mo maximum.
- **Style CSS** : réutiliser les variables existantes (`--nuit`, `--nuit-2`, `--nuit-3`, `--sel`, `--poussiere`, `--soufre`, `--colorada`, `--mono`, `--display`, `--transition`). Ne pas introduire de nouvelle couleur.
- **Le site doit rester utilisable Worker éteint.** Toute panne du service se dégrade en message sobre dans le seul bloc « souvenirs ».

---

### Task 1: Squelette du Worker, base D1 et lecture d'une étape

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/schema.sql`
- Create: `worker/index.js`
- Create: `worker/package.json`
- Create: `worker/.gitignore`

**Interfaces:**
- Consumes: rien.
- Produces: le Worker répond `GET /api/etape/:jour` → `{ "contributions": [] }`, et gère le pré-vol CORS. Les liaisons `env.DB` (D1) et `env.MEDIAS` (R2) sont disponibles pour les tâches suivantes.

- [ ] **Step 1: Créer le manifeste du Worker**

`worker/wrangler.toml` :

```toml
name = "souvenirs-salta-cusco"
main = "index.js"
compatibility_date = "2024-09-23"

# Les identifiants sont renseignés au déploiement (tâche 10) : ils sont propres
# au compte Cloudflare et n'ont pas de valeur par défaut utile.
[[d1_databases]]
binding = "DB"
database_name = "souvenirs"
database_id = "à-renseigner-au-deploiement"

[[r2_buckets]]
binding = "MEDIAS"
bucket_name = "souvenirs-medias"

[vars]
# Origines autorisées à appeler le service, séparées par des virgules.
ORIGINES_AUTORISEES = "https://tinmarlastar.github.io,http://localhost:8123,http://127.0.0.1:8123"
```

- [ ] **Step 2: Créer le schéma de la base**

`worker/schema.sql` :

```sql
CREATE TABLE IF NOT EXISTS contributions (
  id               TEXT PRIMARY KEY,
  jour             INTEGER NOT NULL,
  auteur           TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('note', 'media')),
  texte            TEXT NOT NULL DEFAULT '',
  media_cle        TEXT,
  media_genre      TEXT,
  media_octets     INTEGER,
  cree_le          TEXT NOT NULL,
  modifie_le       TEXT,
  jeton_hache      TEXT NOT NULL,
  cle_idempotence  TEXT NOT NULL UNIQUE
);

-- Lister une étape dans l'ordre chronologique sans trier après coup :
-- l'identifiant préfixe l'horodatage, donc l'index suffit.
CREATE INDEX IF NOT EXISTS idx_contributions_jour ON contributions (jour, id);
```

- [ ] **Step 3: Créer le point d'entrée du Worker**

`worker/index.js` :

```js
/* Service des souvenirs : notes, photos et vidéos postées par les participants.

   Le site reste statique ; seul le bloc « souvenirs » appelle ce service. */

const JSON_ENTETES = { 'Content-Type': 'application/json; charset=utf-8' };

/** En-têtes CORS pour l'origine appelante, si elle est autorisée. */
function entetesCors(requete, env) {
  const origine = requete.headers.get('Origin') || '';
  const autorisees = (env.ORIGINES_AUTORISEES || '').split(',').map((o) => o.trim());
  if (!autorisees.includes(origine)) return {};
  return {
    'Access-Control-Allow-Origin': origine,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Mot-De-Passe, X-Jeton, X-Idempotence',
    'Access-Control-Max-Age': '86400',
  };
}

function repondre(donnees, { statut = 200, cors = {} } = {}) {
  return new Response(JSON.stringify(donnees), {
    status: statut,
    headers: { ...JSON_ENTETES, ...cors },
  });
}

function erreur(message, statut, cors) {
  return repondre({ erreur: message }, { statut, cors });
}

/** Transforme une ligne de la base en objet public, sans le jeton. */
function versPublic(ligne) {
  return {
    id: ligne.id,
    jour: ligne.jour,
    auteur: ligne.auteur,
    type: ligne.type,
    texte: ligne.texte,
    media: ligne.media_cle
      ? { cle: ligne.media_cle, genre: ligne.media_genre, octets: ligne.media_octets }
      : null,
    creeLe: ligne.cree_le,
    modifieLe: ligne.modifie_le,
  };
}

async function listerEtape(jour, env, cors) {
  const { results } = await env.DB
    .prepare('SELECT * FROM contributions WHERE jour = ? ORDER BY id ASC')
    .bind(jour)
    .all();
  return repondre({ contributions: results.map(versPublic) }, { cors });
}

export default {
  async fetch(requete, env) {
    const cors = entetesCors(requete, env);
    const url = new URL(requete.url);
    const chemin = url.pathname;

    if (requete.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const etape = chemin.match(/^\/api\/etape\/(\d{1,2})$/);
    if (etape && requete.method === 'GET') {
      return listerEtape(Number(etape[1]), env, cors);
    }

    return erreur('Route inconnue', 404, cors);
  },
};
```

- [ ] **Step 4: Déclarer le paquet et ignorer les fichiers locaux**

`worker/package.json` :

```json
{
  "name": "souvenirs-salta-cusco",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --local --port 8787",
    "test": "node --test test/",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3.78.0"
  }
}
```

`worker/.gitignore` :

```
node_modules/
.wrangler/
```

- [ ] **Step 5: Installer Wrangler et préparer la base locale**

```bash
cd worker && npm install
npx wrangler d1 execute souvenirs --local --file=schema.sql
```

Attendu : `npm install` termine sans erreur ; la commande D1 affiche l'exécution des deux instructions du schéma.

- [ ] **Step 6: Lancer le Worker et vérifier la lecture**

Dans un terminal :

```bash
cd worker && npx wrangler dev --local --port 8787
```

Dans un autre :

```bash
curl -s http://127.0.0.1:8787/api/etape/7
```

Attendu : `{"contributions":[]}`

- [ ] **Step 7: Vérifier le pré-vol CORS**

```bash
curl -s -i -X OPTIONS http://127.0.0.1:8787/api/etape/7 -H "Origin: http://127.0.0.1:8123" | head -8
```

Attendu : statut `204` et un en-tête `Access-Control-Allow-Origin: http://127.0.0.1:8123`.

Puis, avec une origine non autorisée :

```bash
curl -s -i -X OPTIONS http://127.0.0.1:8787/api/etape/7 -H "Origin: https://exemple-malveillant.test" | head -8
```

Attendu : statut `204` **sans** en-tête `Access-Control-Allow-Origin`.

- [ ] **Step 8: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add worker/
git commit -m "Worker des souvenirs : squelette, schema D1, lecture d'une etape"
```

---

### Task 2: Utilitaires d'autorisation et d'identifiants

**Files:**
- Create: `worker/lib/securite.js`
- Create: `worker/test/securite.test.js`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `creerId(maintenant?: number): string` — identifiant trié chronologiquement.
  - `creerJeton(): string` — secret aléatoire de 32 caractères hexadécimaux.
  - `hacherJeton(jeton: string): Promise<string>` — SHA-256 en hexadécimal.
  - `memeSecret(a: string, b: string): boolean` — comparaison en temps constant.

- [ ] **Step 1: Écrire les tests qui échouent**

`worker/test/securite.test.js` :

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { creerId, creerJeton, hacherJeton, memeSecret } from '../lib/securite.js';

test('creerId se trie chronologiquement comme une chaîne', () => {
  const tot = creerId(1_000_000_000_000);
  const tard = creerId(1_900_000_000_000);
  assert.ok(tot < tard, `${tot} devrait précéder ${tard}`);
});

test('creerId reste unique au même instant', () => {
  const instant = 1_700_000_000_000;
  const identifiants = new Set(Array.from({ length: 500 }, () => creerId(instant)));
  assert.equal(identifiants.size, 500);
});

test('creerJeton produit un secret de 32 caractères hexadécimaux', () => {
  const jeton = creerJeton();
  assert.match(jeton, /^[0-9a-f]{32}$/);
  assert.notEqual(jeton, creerJeton());
});

test('hacherJeton est stable et ne renvoie pas le jeton en clair', async () => {
  const empreinte = await hacherJeton('secret-de-test');
  assert.equal(empreinte, await hacherJeton('secret-de-test'));
  assert.match(empreinte, /^[0-9a-f]{64}$/);
  assert.ok(!empreinte.includes('secret'));
});

test('hacherJeton distingue deux jetons différents', async () => {
  assert.notEqual(await hacherJeton('a'), await hacherJeton('b'));
});

test('memeSecret compare correctement', () => {
  assert.equal(memeSecret('motdepasse', 'motdepasse'), true);
  assert.equal(memeSecret('motdepasse', 'motdepassX'), false);
  assert.equal(memeSecret('court', 'beaucoup-plus-long'), false);
});

test('memeSecret refuse les valeurs absentes', () => {
  assert.equal(memeSecret('', ''), false);
  assert.equal(memeSecret(undefined, 'x'), false);
  assert.equal(memeSecret('x', null), false);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
cd worker && node --test test/securite.test.js
```

Attendu : ÉCHEC — `Cannot find module '../lib/securite.js'`.

- [ ] **Step 3: Écrire l'implémentation**

`worker/lib/securite.js` :

```js
/* Identifiants et comparaisons de secrets.

   Ces fonctions sont pures et sans dépendance : elles tournent aussi bien dans
   le Worker que sous `node --test`. */

// Largeur fixe pour que l'horodatage en base 36 se trie comme une chaîne
// jusqu'en l'an 5138. Sans cette largeur constante, « 9 » passerait après « 10 ».
const LARGEUR_TEMPS = 9;

/** Identifiant trié par le temps : horodatage base 36 puis tirage aléatoire. */
export function creerId(maintenant = Date.now()) {
  const temps = maintenant.toString(36).padStart(LARGEUR_TEMPS, '0');
  const alea = crypto.getRandomValues(new Uint8Array(8));
  const suffixe = [...alea].map((octet) => octet.toString(16).padStart(2, '0')).join('');
  return `${temps}${suffixe}`;
}

/** Secret d'auteur, renvoyé une seule fois au créateur d'une contribution. */
export function creerJeton() {
  const alea = crypto.getRandomValues(new Uint8Array(16));
  return [...alea].map((octet) => octet.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hexadécimal : c'est ce qu'on stocke, jamais le jeton en clair. */
export async function hacherJeton(jeton) {
  const donnees = new TextEncoder().encode(jeton);
  const empreinte = await crypto.subtle.digest('SHA-256', donnees);
  return [...new Uint8Array(empreinte)].map((o) => o.toString(16).padStart(2, '0')).join('');
}

/** Comparaison en temps constant : la durée ne doit pas trahir le secret. */
export function memeSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let ecart = 0;
  for (let i = 0; i < ea.length; i += 1) ecart |= ea[i] ^ eb[i];
  return ecart === 0;
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

```bash
cd worker && node --test test/securite.test.js
```

Attendu : SUCCÈS — 7 tests passés.

- [ ] **Step 5: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add worker/lib/securite.js worker/test/securite.test.js
git commit -m "Worker : identifiants tries par le temps et comparaison de secrets"
```

---

### Task 3: Poster une note

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: `creerId`, `creerJeton`, `hacherJeton`, `memeSecret` de `worker/lib/securite.js` ; `env.DB`.
- Produces: `POST /api/etape/:jour` accepte `{ auteur, texte }` avec les en-têtes `X-Mot-De-Passe` et `X-Idempotence`, et renvoie `{ contribution, jeton }`. Le secret `MOT_DE_PASSE_GROUPE` devient nécessaire.

- [ ] **Step 1: Ajouter l'import et les constantes en tête de `worker/index.js`**

Juste après le commentaire d'en-tête, avant `const JSON_ENTETES` :

```js
import { creerId, creerJeton, hacherJeton, memeSecret } from './lib/securite.js';

const TEXTE_MAX = 2000;
const AUTEUR_MAX = 40;
```

- [ ] **Step 2: Ajouter la vérification du mot de passe et la création de note**

Dans `worker/index.js`, juste avant `export default` :

```js
/** Vrai si la requête porte le mot de passe de groupe. */
function groupeAutorise(requete, env) {
  return memeSecret(requete.headers.get('X-Mot-De-Passe'), env.MOT_DE_PASSE_GROUPE);
}

/** Nettoie une chaîne venue du client : type, espaces superflus, longueur. */
function assainir(valeur, longueurMax) {
  if (typeof valeur !== 'string') return '';
  return valeur.trim().slice(0, longueurMax);
}

/** Insère une contribution ; renvoie l'existante si la clé a déjà servi. */
async function enregistrer(ligne, env) {
  try {
    await env.DB.prepare(
      `INSERT INTO contributions
         (id, jour, auteur, type, texte, media_cle, media_genre, media_octets,
          cree_le, modifie_le, jeton_hache, cle_idempotence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(
      ligne.id, ligne.jour, ligne.auteur, ligne.type, ligne.texte,
      ligne.media_cle, ligne.media_genre, ligne.media_octets,
      ligne.cree_le, ligne.jeton_hache, ligne.cle_idempotence,
    ).run();
    return { ligne, deja: false };
  } catch (souci) {
    // Clé d'idempotence déjà vue : un renvoi après une réponse perdue en route.
    // On rend l'existante plutôt que de créer un doublon.
    if (!String(souci).includes('UNIQUE')) throw souci;
    const existante = await env.DB
      .prepare('SELECT * FROM contributions WHERE cle_idempotence = ?')
      .bind(ligne.cle_idempotence)
      .first();
    return { ligne: existante, deja: true };
  }
}

async function creerNote(jour, requete, env, cors) {
  if (!groupeAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  const idempotence = assainir(requete.headers.get('X-Idempotence'), 80);
  if (!idempotence) return erreur('En-tête X-Idempotence manquant', 400, cors);

  const corps = await requete.json().catch(() => ({}));
  const auteur = assainir(corps.auteur, AUTEUR_MAX);
  const texte = assainir(corps.texte, TEXTE_MAX);
  if (!auteur) return erreur('Un prénom est nécessaire', 400, cors);
  if (!texte) return erreur('La note est vide', 400, cors);

  const jeton = creerJeton();
  const { ligne, deja } = await enregistrer({
    id: creerId(),
    jour,
    auteur,
    type: 'note',
    texte,
    media_cle: null,
    media_genre: null,
    media_octets: null,
    cree_le: new Date().toISOString(),
    jeton_hache: await hacherJeton(jeton),
    cle_idempotence: idempotence,
  }, env);

  // Sur un renvoi, l'entrée existe déjà et son jeton d'origine est perdu :
  // seul le premier envoi reçoit un jeton exploitable.
  return repondre(
    { contribution: versPublic(ligne), jeton: deja ? null : jeton },
    { statut: deja ? 200 : 201, cors },
  );
}
```

- [ ] **Step 3: Brancher la route**

Dans `export default`, remplacer le bloc `if (etape && requete.method === 'GET')` par :

```js
    if (etape) {
      const jour = Number(etape[1]);
      if (requete.method === 'GET') return listerEtape(jour, env, cors);
      if (requete.method === 'POST') return creerNote(jour, requete, env, cors);
    }
```

- [ ] **Step 4: Poser le mot de passe local**

Créer `worker/.dev.vars` (déjà ignoré par `.gitignore` ? sinon l'ajouter) :

```
MOT_DE_PASSE_GROUPE=<mot-de-passe-de-groupe-local>
MOT_DE_PASSE_ADMIN=<mot-de-passe-admin-local>
```

Ajouter `.dev.vars` à `worker/.gitignore` :

```bash
cd worker && printf '.dev.vars\n' >> .gitignore && cat .gitignore
```

Attendu : le fichier contient `node_modules/`, `.wrangler/` et `.dev.vars`.

- [ ] **Step 5: Vérifier le refus sans mot de passe**

Relancer `npx wrangler dev --local --port 8787`, puis :

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8787/api/etape/7 -H "X-Idempotence: test-1" -H "Content-Type: application/json" -d '{"auteur":"Martin","texte":"Essai"}'
```

Attendu : `401`

- [ ] **Step 6: Vérifier la création et l'idempotence**

```bash
curl -s -X POST http://127.0.0.1:8787/api/etape/7 -H "X-Mot-De-Passe: <mot-de-passe-de-groupe-local>" -H "X-Idempotence: test-1" -H "Content-Type: application/json" -d '{"auteur":"Martin","texte":"Le salar est immense"}'
```

Attendu : un objet avec `"contribution"` et un `"jeton"` de 32 caractères hexadécimaux.

Rejouer **exactement la même commande** :

Attendu : la même `contribution` (même `id`), et `"jeton":null`.

```bash
curl -s http://127.0.0.1:8787/api/etape/7
```

Attendu : **une seule** contribution dans la liste, et **aucun champ `jeton`**.

- [ ] **Step 7: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add worker/index.js worker/.gitignore
git commit -m "Worker : poster une note, avec mot de passe de groupe et idempotence"
```

---

### Task 4: Poster et servir un média

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: tout ce que produit la tâche 3 ; `env.MEDIAS` (R2).
- Produces: `POST /api/etape/:jour/media` (multipart : champs `auteur`, `texte`, `fichier`) et `GET /media/<cle>` qui sert le fichier.

- [ ] **Step 1: Ajouter les constantes des médias**

Sous `const AUTEUR_MAX = 40;` dans `worker/index.js` :

```js
const VIDEO_OCTETS_MAX = 60 * 1024 * 1024; // 60 Mo : au-delà, l'envoi en altitude n'aboutit pas
const IMAGE_OCTETS_MAX = 12 * 1024 * 1024; // le navigateur compresse déjà ; cette marge couvre les cas non compressés

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};
```

- [ ] **Step 2: Ajouter la création de média**

Dans `worker/index.js`, après `creerNote` :

```js
async function creerMedia(jour, requete, env, cors) {
  if (!groupeAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  const idempotence = assainir(requete.headers.get('X-Idempotence'), 80);
  if (!idempotence) return erreur('En-tête X-Idempotence manquant', 400, cors);

  const formulaire = await requete.formData().catch(() => null);
  if (!formulaire) return erreur('Envoi illisible', 400, cors);

  const auteur = assainir(formulaire.get('auteur'), AUTEUR_MAX);
  const texte = assainir(formulaire.get('texte'), TEXTE_MAX);
  const fichier = formulaire.get('fichier');
  if (!auteur) return erreur('Un prénom est nécessaire', 400, cors);
  if (!fichier || typeof fichier.arrayBuffer !== 'function') {
    return erreur('Aucun fichier reçu', 400, cors);
  }

  const genre = fichier.type.startsWith('video/') ? 'video' : 'image';
  const plafond = genre === 'video' ? VIDEO_OCTETS_MAX : IMAGE_OCTETS_MAX;
  if (fichier.size > plafond) {
    const mo = Math.round(plafond / (1024 * 1024));
    return erreur(
      genre === 'video'
        ? `Vidéo trop lourde (maximum ${mo} Mo). Raccourcissez le clip ou baissez la qualité.`
        : `Image trop lourde (maximum ${mo} Mo).`,
      413, cors,
    );
  }

  const extension = EXTENSIONS[fichier.type] || (genre === 'video' ? 'mp4' : 'jpg');
  const id = creerId();
  const cle = `medias/${jour}/${id}.${extension}`;

  await env.MEDIAS.put(cle, fichier.stream(), {
    httpMetadata: { contentType: fichier.type || 'application/octet-stream' },
  });

  const jeton = creerJeton();
  const { ligne, deja } = await enregistrer({
    id,
    jour,
    auteur,
    type: 'media',
    texte,
    media_cle: cle,
    media_genre: genre,
    media_octets: fichier.size,
    cree_le: new Date().toISOString(),
    jeton_hache: await hacherJeton(jeton),
    cle_idempotence: idempotence,
  }, env);

  // Renvoi d'un média déjà enregistré : le fichier qu'on vient d'écrire est un
  // orphelin, on le retire pour ne pas encombrer le stockage.
  if (deja && ligne.media_cle !== cle) await env.MEDIAS.delete(cle);

  return repondre(
    { contribution: versPublic(ligne), jeton: deja ? null : jeton },
    { statut: deja ? 200 : 201, cors },
  );
}

async function servirMedia(cle, env, cors) {
  const objet = await env.MEDIAS.get(cle);
  if (!objet) return erreur('Média introuvable', 404, cors);
  const entetes = new Headers(cors);
  objet.writeHttpMetadata(entetes);
  entetes.set('etag', objet.httpEtag);
  // Les fichiers ne changent jamais : le navigateur peut les garder longtemps.
  entetes.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(objet.body, { headers: entetes });
}
```

- [ ] **Step 3: Brancher les deux routes**

Dans `export default`, remplacer le bloc `if (etape) { … }` par :

```js
    if (etape) {
      const jour = Number(etape[1]);
      if (requete.method === 'GET') return listerEtape(jour, env, cors);
      if (requete.method === 'POST') return creerNote(jour, requete, env, cors);
    }

    const media = chemin.match(/^\/api\/etape\/(\d{1,2})\/media$/);
    if (media && requete.method === 'POST') {
      return creerMedia(Number(media[1]), requete, env, cors);
    }

    if (chemin.startsWith('/media/') && requete.method === 'GET') {
      return servirMedia(decodeURIComponent(chemin.slice('/media/'.length)), env, cors);
    }
```

Le motif de `etape` (`/^\/api\/etape\/(\d{1,2})$/`) se termine par `$` : il ne capte donc pas `/api/etape/7/media`, qui tombe bien sur le motif suivant.

- [ ] **Step 4: Vérifier l'envoi d'une image**

Relancer le Worker, puis, depuis la racine du projet :

```bash
curl -s -X POST http://127.0.0.1:8787/api/etape/7/media -H "X-Mot-De-Passe: <mot-de-passe-de-groupe-local>" -H "X-Idempotence: media-1" -F "auteur=Martin" -F "texte=Isla Incahuasi" -F "fichier=@img/etapes/j07-salar-uyuni.jpg;type=image/jpeg"
```

Attendu : `201` avec une `contribution` dont `media.genre` vaut `"image"` et `media.cle` commence par `medias/7/`.

- [ ] **Step 5: Vérifier que le fichier se sert**

Reprendre la valeur de `media.cle` de la réponse précédente :

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" "http://127.0.0.1:8787/media/medias/7/<coller-la-cle>.jpg"
```

Attendu : `200 image/jpeg` et une taille non nulle.

- [ ] **Step 6: Vérifier le refus d'une vidéo trop lourde**

```bash
head -c 70000000 /dev/urandom > /tmp/trop-lourd.mp4
curl -s -X POST http://127.0.0.1:8787/api/etape/7/media -H "X-Mot-De-Passe: <mot-de-passe-de-groupe-local>" -H "X-Idempotence: media-lourd" -F "auteur=Martin" -F "fichier=@/tmp/trop-lourd.mp4;type=video/mp4" | head -c 200
rm -f /tmp/trop-lourd.mp4
```

Attendu : un message d'erreur mentionnant « Vidéo trop lourde (maximum 60 Mo) ».

- [ ] **Step 7: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add worker/index.js
git commit -m "Worker : poster une photo ou une video, et les servir depuis R2"
```

---

### Task 5: Modifier et supprimer une contribution

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Consumes: tout ce que produisent les tâches 3 et 4.
- Produces: `PATCH /api/contribution/:id` (en-tête `X-Jeton`, corps `{ texte }`) et `DELETE /api/contribution/:id` (en-tête `X-Jeton` **ou** `X-Mot-De-Passe` admin). Le secret `MOT_DE_PASSE_ADMIN` devient nécessaire.

- [ ] **Step 1: Ajouter les deux poignées**

Dans `worker/index.js`, après `servirMedia` :

```js
/** Vrai si la requête porte le mot de passe d'administration. */
function adminAutorise(requete, env) {
  return memeSecret(requete.headers.get('X-Mot-De-Passe'), env.MOT_DE_PASSE_ADMIN);
}

/** Vrai si le jeton présenté est bien celui de cette contribution. */
async function auteurAutorise(requete, ligne) {
  const jeton = requete.headers.get('X-Jeton');
  if (!jeton) return false;
  return memeSecret(await hacherJeton(jeton), ligne.jeton_hache);
}

async function modifier(id, requete, env, cors) {
  const ligne = await env.DB
    .prepare('SELECT * FROM contributions WHERE id = ?').bind(id).first();
  if (!ligne) return erreur('Contribution introuvable', 404, cors);
  if (!await auteurAutorise(requete, ligne)) {
    return erreur("Seul l'auteur peut modifier cette contribution", 403, cors);
  }

  const corps = await requete.json().catch(() => ({}));
  const texte = assainir(corps.texte, TEXTE_MAX);
  // Une note vide n'a pas de sens ; la légende d'un média, si.
  if (!texte && ligne.type === 'note') return erreur('La note est vide', 400, cors);

  const modifieLe = new Date().toISOString();
  await env.DB
    .prepare('UPDATE contributions SET texte = ?, modifie_le = ? WHERE id = ?')
    .bind(texte, modifieLe, id)
    .run();

  return repondre(
    { contribution: versPublic({ ...ligne, texte, modifie_le: modifieLe }) },
    { cors },
  );
}

async function supprimer(id, requete, env, cors) {
  const ligne = await env.DB
    .prepare('SELECT * FROM contributions WHERE id = ?').bind(id).first();
  if (!ligne) return erreur('Contribution introuvable', 404, cors);

  const permis = adminAutorise(requete, env) || await auteurAutorise(requete, ligne);
  if (!permis) return erreur('Suppression non autorisée', 403, cors);

  if (ligne.media_cle) await env.MEDIAS.delete(ligne.media_cle);
  await env.DB.prepare('DELETE FROM contributions WHERE id = ?').bind(id).run();
  return repondre({ supprime: id }, { cors });
}

/** Liste toutes les contributions, pour la page de modération. */
async function listerTout(requete, env, cors) {
  if (!adminAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);
  const { results } = await env.DB
    .prepare('SELECT * FROM contributions ORDER BY id DESC').all();
  return repondre({ contributions: results.map(versPublic) }, { cors });
}
```

- [ ] **Step 2: Brancher les routes**

Dans `export default`, juste avant `return erreur('Route inconnue', 404, cors);` :

```js
    const contribution = chemin.match(/^\/api\/contribution\/([0-9a-z]+)$/);
    if (contribution) {
      const id = contribution[1];
      if (requete.method === 'PATCH') return modifier(id, requete, env, cors);
      if (requete.method === 'DELETE') return supprimer(id, requete, env, cors);
    }

    if (chemin === '/api/tout' && requete.method === 'GET') {
      return listerTout(requete, env, cors);
    }
```

- [ ] **Step 3: Vérifier la modification par l'auteur**

Relancer le Worker. Créer une note et garder son `id` et son `jeton` :

```bash
curl -s -X POST http://127.0.0.1:8787/api/etape/9 -H "X-Mot-De-Passe: <mot-de-passe-de-groupe-local>" -H "X-Idempotence: modif-1" -H "Content-Type: application/json" -d '{"auteur":"Martin","texte":"Version initiale"}'
```

Puis, avec les valeurs obtenues :

```bash
curl -s -X PATCH "http://127.0.0.1:8787/api/contribution/<id>" -H "X-Jeton: <jeton>" -H "Content-Type: application/json" -d '{"texte":"Version corrigée"}'
```

Attendu : la contribution renvoyée porte `"texte":"Version corrigée"` et un `modifieLe` non vide.

- [ ] **Step 4: Vérifier qu'un mauvais jeton est refusé**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH "http://127.0.0.1:8787/api/contribution/<id>" -H "X-Jeton: 00000000000000000000000000000000" -H "Content-Type: application/json" -d '{"texte":"Tentative"}'
```

Attendu : `403`

- [ ] **Step 5: Vérifier la suppression par l'administration**

```bash
curl -s -X DELETE "http://127.0.0.1:8787/api/contribution/<id>" -H "X-Mot-De-Passe: <mot-de-passe-admin-local>"
curl -s http://127.0.0.1:8787/api/etape/9
```

Attendu : `{"supprime":"<id>"}` puis une liste vide pour l'étape 9.

- [ ] **Step 6: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add worker/index.js
git commit -m "Worker : modification par l'auteur, suppression par l'auteur ou l'admin"
```

---

### Task 6: Module réseau du navigateur

**Files:**
- Create: `data/config.json`
- Create: `js/souvenirs.js`
- Modify: `.gitignore` (aucun changement attendu ; vérifier seulement)

**Interfaces:**
- Consumes: les routes du Worker (tâches 3-5).
- Produces, exportés par `js/souvenirs.js` :
  - `chargerConfig(): Promise<{serviceUrl: string|null}>`
  - `listerEtape(jour: number): Promise<Array<Contribution>>`
  - `envoyerNote({jour, auteur, texte, motDePasse, idempotence}): Promise<{contribution, jeton}>`
  - `envoyerMedia({jour, auteur, texte, fichier, motDePasse, idempotence}): Promise<{contribution, jeton}>`
  - `modifierContribution({id, texte, jeton}): Promise<{contribution}>`
  - `supprimerContribution({id, jeton, motDePasse}): Promise<void>`
  - `listerTout(motDePasse: string): Promise<Array<Contribution>>` — utilisé par la page de modération (tâche 9).
  - `compresserImage(fichier: File): Promise<File>`
  - `verifierVideo(fichier: File): string|null` — message de refus si la vidéo dépasse 60 Mo, sinon `null`.
  - `urlMedia(cle: string): string`
  - `creerCleIdempotence(): string`
  - `ErreurReseau` — panne réseau : un renvoi ultérieur a du sens.
  - `ErreurService` — refus explicite du service (mot de passe, taille) : ne pas renvoyer.

- [ ] **Step 1: Créer le fichier de configuration**

`data/config.json` :

```json
{
  "serviceUrl": "http://127.0.0.1:8787"
}
```

- [ ] **Step 2: Écrire le module réseau**

`js/souvenirs.js` :

```js
/* Accès au service des souvenirs.

   Ce module ne touche jamais au DOM : il ne fait que parler au Worker et
   préparer les fichiers. La vue est dans souvenirs-vue.js, la file d'attente
   dans souvenirs-file.js. */

const IMAGE_LARGEUR_MAX = 1600;
const IMAGE_QUALITE = 0.82;
const VIDEO_OCTETS_MAX = 60 * 1024 * 1024;

/** Panne réseau ou service indisponible : un renvoi plus tard a du sens. */
export class ErreurReseau extends Error {}

/** Refus explicite du service (mot de passe, fichier trop lourd) : ne pas renvoyer. */
export class ErreurService extends Error {
  constructor(message, statut) {
    super(message);
    this.statut = statut;
  }
}

let config = null;

export async function chargerConfig() {
  if (config) return config;
  try {
    const reponse = await fetch('data/config.json');
    config = reponse.ok ? await reponse.json() : { serviceUrl: null };
  } catch {
    config = { serviceUrl: null };
  }
  return config;
}

async function base() {
  const { serviceUrl } = await chargerConfig();
  if (!serviceUrl) throw new ErreurReseau('Service non configuré');
  return serviceUrl.replace(/\/$/, '');
}

export function urlMedia(cle) {
  const racine = config?.serviceUrl?.replace(/\/$/, '') || '';
  return `${racine}/media/${cle}`;
}

export function creerCleIdempotence() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Appelle le service et distingue panne réseau et refus explicite. */
async function appeler(chemin, options = {}) {
  const racine = await base();
  let reponse;
  try {
    reponse = await fetch(`${racine}${chemin}`, options);
  } catch (souci) {
    throw new ErreurReseau(souci.message);
  }
  // 5xx : le service est mal en point, un renvoi plus tard peut passer.
  if (reponse.status >= 500) throw new ErreurReseau(`Service en erreur (${reponse.status})`);
  const donnees = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    throw new ErreurService(donnees.erreur || `Erreur ${reponse.status}`, reponse.status);
  }
  return donnees;
}

export async function listerEtape(jour) {
  const donnees = await appeler(`/api/etape/${jour}`);
  return donnees.contributions || [];
}

export async function envoyerNote({ jour, auteur, texte, motDePasse, idempotence }) {
  return appeler(`/api/etape/${jour}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mot-De-Passe': motDePasse,
      'X-Idempotence': idempotence,
    },
    body: JSON.stringify({ auteur, texte }),
  });
}

export async function envoyerMedia({ jour, auteur, texte, fichier, motDePasse, idempotence }) {
  const formulaire = new FormData();
  formulaire.set('auteur', auteur);
  formulaire.set('texte', texte || '');
  formulaire.set('fichier', fichier, fichier.name || 'souvenir');
  return appeler(`/api/etape/${jour}/media`, {
    method: 'POST',
    headers: { 'X-Mot-De-Passe': motDePasse, 'X-Idempotence': idempotence },
    body: formulaire,
  });
}

export async function modifierContribution({ id, texte, jeton }) {
  return appeler(`/api/contribution/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Jeton': jeton },
    body: JSON.stringify({ texte }),
  });
}

export async function supprimerContribution({ id, jeton, motDePasse }) {
  const entetes = {};
  if (jeton) entetes['X-Jeton'] = jeton;
  if (motDePasse) entetes['X-Mot-De-Passe'] = motDePasse;
  await appeler(`/api/contribution/${id}`, { method: 'DELETE', headers: entetes });
}

export async function listerTout(motDePasse) {
  const donnees = await appeler('/api/tout', { headers: { 'X-Mot-De-Passe': motDePasse } });
  return donnees.contributions || [];
}

/** Vérifie la taille d'une vidéo avant tout envoi. */
export function verifierVideo(fichier) {
  if (fichier.size <= VIDEO_OCTETS_MAX) return null;
  const mo = Math.round(fichier.size / (1024 * 1024));
  return `Vidéo de ${mo} Mo, maximum 60 Mo. Raccourcissez le clip ou baissez la qualité dans les réglages de la caméra.`;
}

/** Redimensionne et recompresse une photo avant l'envoi.

    Un cliché de téléphone de 4 à 8 Mo tombe à quelques centaines de Ko : c'est
    ce qui rend l'envoi possible avec le réseau des Andes. */
export async function compresserImage(fichier) {
  // imageOrientation respecte l'EXIF : sans cela, les photos prises à la
  // verticale repartiraient couchées.
  const bitmap = await createImageBitmap(fichier, { imageOrientation: 'from-image' });
  const ratio = Math.min(1, IMAGE_LARGEUR_MAX / bitmap.width);
  const toile = document.createElement('canvas');
  toile.width = Math.round(bitmap.width * ratio);
  toile.height = Math.round(bitmap.height * ratio);
  toile.getContext('2d').drawImage(bitmap, 0, 0, toile.width, toile.height);
  bitmap.close();

  const blob = await new Promise((resoudre) => {
    toile.toBlob(resoudre, 'image/jpeg', IMAGE_QUALITE);
  });
  if (!blob) return fichier; // le navigateur a refusé : mieux vaut l'original que rien
  return new File([blob], 'souvenir.jpg', { type: 'image/jpeg' });
}
```

- [ ] **Step 3: Vérifier la syntaxe**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
cp js/souvenirs.js /tmp/v-souvenirs.mjs && node --check /tmp/v-souvenirs.mjs && echo OK && rm -f /tmp/v-souvenirs.mjs
```

Attendu : `OK`

- [ ] **Step 4: Vérifier depuis le navigateur**

Lancer le Worker (`cd worker && npx wrangler dev --local --port 8787`) et le site
(`python3 -m http.server 8123`), ouvrir <http://127.0.0.1:8123>, puis dans la console :

```js
const m = await import('./js/souvenirs.js');
await m.chargerConfig();
await m.envoyerNote({ jour: 3, auteur: 'Test', texte: 'Depuis le navigateur',
  motDePasse: '<mot-de-passe-de-groupe-local>', idempotence: m.creerCleIdempotence() });
await m.listerEtape(3);
```

Attendu : l'envoi renvoie un objet avec `jeton`, et `listerEtape` renvoie un tableau d'un élément. Aucune erreur CORS dans la console.

- [ ] **Step 5: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add js/souvenirs.js data/config.json
git commit -m "Client : module d'acces au service des souvenirs"
```

---

### Task 7: File d'attente locale

**Files:**
- Create: `js/souvenirs-file.js`

**Interfaces:**
- Consumes: `envoyerNote`, `envoyerMedia`, `creerCleIdempotence`, `ErreurReseau`, `ErreurService` de `js/souvenirs.js`.
- Produces, exportés par `js/souvenirs-file.js` :
  - `mettreEnFile(entree): Promise<string>` — range un envoi et renvoie son identifiant local.
  - `listerFile(jour: number): Promise<Array>` — les envois en attente pour une étape.
  - `viderEntree(idLocal: string): Promise<void>`
  - `demarrerRenvoi({surChangement}): void` — arme les déclencheurs de renvoi automatique.
  - `renvoyerMaintenant(): Promise<void>`

- [ ] **Step 1: Écrire le module**

`js/souvenirs-file.js` :

```js
/* File d'attente des envois qui n'ont pas abouti.

   C'est la réponse au réseau des Andes : rien ne se perd quand ça ne passe pas.
   IndexedDB, et non localStorage, parce qu'elle seule stocke les fichiers
   binaires tels quels. */

import {
  envoyerNote, envoyerMedia, ErreurReseau, ErreurService,
} from './souvenirs.js';

const BASE = 'souvenirs-salta-cusco';
const MAGASIN = 'attente';

const ATTENTE_MIN = 2000;       // premier réessai après 2 s
const ATTENTE_MAX = 5 * 60_000; // plafonné à 5 min : en zone blanche, insister vide la batterie
const PERIODE = 2 * 60_000;     // relance périodique tant que l'onglet est ouvert

let signaler = () => {};
let enCours = false;

function ouvrir() {
  return new Promise((resoudre, rejeter) => {
    const requete = indexedDB.open(BASE, 1);
    requete.onupgradeneeded = () => {
      const base = requete.result;
      if (!base.objectStoreNames.contains(MAGASIN)) {
        base.createObjectStore(MAGASIN, { keyPath: 'idLocal' });
      }
    };
    requete.onsuccess = () => resoudre(requete.result);
    requete.onerror = () => rejeter(requete.error);
  });
}

async function transaction(mode, action) {
  const base = await ouvrir();
  return new Promise((resoudre, rejeter) => {
    const tx = base.transaction(MAGASIN, mode);
    const resultat = action(tx.objectStore(MAGASIN));
    tx.oncomplete = () => resoudre(resultat?.result ?? resultat);
    tx.onerror = () => rejeter(tx.error);
  });
}

export async function mettreEnFile(entree) {
  const idLocal = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const enregistrement = {
    ...entree,
    idLocal,
    tentatives: 0,
    prochaineTentative: 0,
    dernierSouci: null,
  };
  await transaction('readwrite', (magasin) => magasin.put(enregistrement));
  signaler();
  return idLocal;
}

export async function listerFile(jour) {
  const toutes = await transaction('readonly', (magasin) => magasin.getAll());
  return (toutes || []).filter((e) => e.jour === jour);
}

export async function viderEntree(idLocal) {
  await transaction('readwrite', (magasin) => magasin.delete(idLocal));
  signaler();
}

/** Réessaie tous les envois dont l'heure est venue. */
export async function renvoyerMaintenant() {
  if (enCours) return;
  enCours = true;
  try {
    const toutes = (await transaction('readonly', (magasin) => magasin.getAll())) || [];
    for (const entree of toutes) {
      if (Date.now() < entree.prochaineTentative) continue;
      try {
        if (entree.type === 'media') {
          await envoyerMedia(entree);
        } else {
          await envoyerNote(entree);
        }
        await transaction('readwrite', (magasin) => magasin.delete(entree.idLocal));
        signaler();
      } catch (souci) {
        // Refus explicite (mot de passe faux, fichier trop lourd) : réessayer
        // ne servirait à rien, on garde l'entrée avec son motif pour que
        // l'auteur voie ce qui bloque.
        const definitif = souci instanceof ErreurService;
        const tentatives = entree.tentatives + 1;
        const attente = Math.min(ATTENTE_MIN * 2 ** tentatives, ATTENTE_MAX);
        await transaction('readwrite', (magasin) => magasin.put({
          ...entree,
          tentatives,
          prochaineTentative: definitif ? Number.MAX_SAFE_INTEGER : Date.now() + attente,
          dernierSouci: souci.message,
          bloque: definitif,
        }));
        signaler();
        if (!(souci instanceof ErreurReseau) && !definitif) throw souci;
      }
    }
  } finally {
    enCours = false;
  }
}

/** Arme les trois déclencheurs de renvoi : réseau retrouvé, onglet revu, minuterie. */
export function demarrerRenvoi({ surChangement } = {}) {
  if (surChangement) signaler = surChangement;
  addEventListener('online', renvoyerMaintenant);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renvoyerMaintenant();
  });
  setInterval(renvoyerMaintenant, PERIODE);
  renvoyerMaintenant();
}
```

- [ ] **Step 2: Vérifier la syntaxe**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
cp js/souvenirs-file.js /tmp/v-file.mjs && node --check /tmp/v-file.mjs && echo OK && rm -f /tmp/v-file.mjs
```

Attendu : `OK`

- [ ] **Step 3: Vérifier le comportement hors ligne dans le navigateur**

Site et Worker lancés, ouvrir <http://127.0.0.1:8123>, puis dans la console :

```js
const f = await import('./js/souvenirs-file.js');
const s = await import('./js/souvenirs.js');
await s.chargerConfig();
await f.mettreEnFile({ type: 'note', jour: 5, auteur: 'Test', texte: 'Hors ligne',
  motDePasse: '<mot-de-passe-de-groupe-local>', idempotence: s.creerCleIdempotence() });
(await f.listerFile(5)).length;
```

Attendu : `1`

Arrêter le Worker (Ctrl-C), puis :

```js
await f.renvoyerMaintenant();
(await f.listerFile(5))[0].tentatives;
```

Attendu : `1` — l'entrée est toujours là, avec une tentative comptée.

Relancer le Worker, puis :

```js
(await f.listerFile(5))[0].prochaineTentative = 0;
await f.renvoyerMaintenant();
(await f.listerFile(5)).length;
```

Attendu : `0` — l'envoi est passé et l'entrée a quitté la file.

```js
(await s.listerEtape(5)).length;
```

Attendu : `1` — et **une seule**, malgré les deux tentatives (l'idempotence a joué).

- [ ] **Step 4: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add js/souvenirs-file.js
git commit -m "Client : file d'attente IndexedDB avec renvoi automatique espace"
```

---

### Task 8: Bloc « Souvenirs » dans le panneau d'étape

**Files:**
- Create: `js/souvenirs-vue.js`
- Modify: `css/style.css`
- Modify: `js/app.js`

**Interfaces:**
- Consumes: tout `js/souvenirs.js` et `js/souvenirs-file.js`.
- Produces: `monterSouvenirs(conteneur: HTMLElement, jour: number): void`, appelée par `app.js` après le rendu d'une fiche d'étape.

- [ ] **Step 1: Écrire la vue**

`js/souvenirs-vue.js` :

```js
/* Bloc « Souvenirs des compagnons » sous le récit de chaque étape.

   Ce module possède le DOM du bloc ; il ne parle au réseau qu'à travers
   souvenirs.js et souvenirs-file.js. */

import {
  listerEtape, modifierContribution, supprimerContribution,
  compresserImage, verifierVideo, urlMedia, creerCleIdempotence, ErreurService,
} from './souvenirs.js';
import { mettreEnFile, listerFile, viderEntree, demarrerRenvoi } from './souvenirs-file.js';

const CLE_AUTEUR = 'souvenirs.auteur';
const CLE_MOT_DE_PASSE = 'souvenirs.motDePasse';
const CLE_JETONS = 'souvenirs.jetons';

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const jetons = () => JSON.parse(localStorage.getItem(CLE_JETONS) || '{}');

function retenirJeton(id, jeton) {
  if (!jeton) return;
  const tous = jetons();
  tous[id] = jeton;
  localStorage.setItem(CLE_JETONS, JSON.stringify(tous));
}

function oublierJeton(id) {
  const tous = jetons();
  delete tous[id];
  localStorage.setItem(CLE_JETONS, JSON.stringify(tous));
}

const dateCourte = (iso) => new Date(iso).toLocaleDateString('fr-FR', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

function gabaritContribution(contribution) {
  const sien = Boolean(jetons()[contribution.id]);
  const media = contribution.media;
  const corpsMedia = !media ? '' : media.genre === 'video'
    ? `<video class="souvenir__media" src="${echapper(urlMedia(media.cle))}" controls preload="metadata"></video>`
    : `<img class="souvenir__media" src="${echapper(urlMedia(media.cle))}" alt="" loading="lazy">`;

  return `<article class="souvenir" data-id="${echapper(contribution.id)}">
    <p class="souvenir__entete">
      <b>${echapper(contribution.auteur)}</b>
      <time>${echapper(dateCourte(contribution.creeLe))}</time>
      ${contribution.modifieLe ? '<em>modifié</em>' : ''}
    </p>
    ${corpsMedia}
    ${contribution.texte ? `<p class="souvenir__texte">${echapper(contribution.texte)}</p>` : ''}
    ${sien ? `<p class="souvenir__actions">
      <button type="button" data-action="modifier">Modifier</button>
      <button type="button" data-action="supprimer">Supprimer</button>
    </p>` : ''}
  </article>`;
}

function gabaritEnAttente(entree) {
  const motif = entree.bloque
    ? `Bloqué : ${echapper(entree.dernierSouci)}`
    : 'En attente de réseau';
  return `<article class="souvenir est-en-attente" data-local="${echapper(entree.idLocal)}">
    <p class="souvenir__entete"><b>${echapper(entree.auteur)}</b> <time>${motif}</time></p>
    ${entree.texte ? `<p class="souvenir__texte">${echapper(entree.texte)}</p>` : ''}
    <p class="souvenir__actions"><button type="button" data-action="abandonner">Abandonner</button></p>
  </article>`;
}

function gabaritFormulaire() {
  const auteur = localStorage.getItem(CLE_AUTEUR) || '';
  const motDePasse = localStorage.getItem(CLE_MOT_DE_PASSE) || '';
  return `<form class="souvenir-form">
    ${auteur && motDePasse ? '' : `
      <input class="souvenir-form__champ" name="auteur" placeholder="Votre prénom"
             value="${echapper(auteur)}" maxlength="40" required>
      <input class="souvenir-form__champ" name="motDePasse" type="password"
             placeholder="Mot de passe du groupe" value="${echapper(motDePasse)}" required>`}
    <textarea class="souvenir-form__champ" name="texte" rows="2" maxlength="2000"
              placeholder="Une note, un souvenir…"></textarea>
    <p class="souvenir-form__pied">
      <label class="souvenir-form__fichier">
        Photo ou vidéo<input type="file" name="fichier" accept="image/*,video/*" hidden>
      </label>
      <span class="souvenir-form__choisi"></span>
      <button type="submit">Publier</button>
    </p>
    <p class="souvenir-form__souci" hidden></p>
  </form>`;
}

export function monterSouvenirs(conteneur, jour) {
  conteneur.innerHTML = `<p class="sous-titre">Souvenirs des compagnons</p>
    <div class="souvenirs__liste">Chargement…</div>
    ${gabaritFormulaire()}`;

  const liste = conteneur.querySelector('.souvenirs__liste');
  const formulaire = conteneur.querySelector('.souvenir-form');
  const souci = conteneur.querySelector('.souvenir-form__souci');
  const champFichier = formulaire.querySelector('[name="fichier"]');
  const nomChoisi = conteneur.querySelector('.souvenir-form__choisi');

  async function rafraichir() {
    const attente = await listerFile(jour);
    let publiees = [];
    try {
      publiees = await listerEtape(jour);
    } catch {
      liste.innerHTML = attente.length
        ? attente.map(gabaritEnAttente).join('')
        : '<p class="souvenirs__vide">Les souvenirs ne se chargent pas pour le moment.</p>';
      return;
    }
    liste.innerHTML = publiees.length || attente.length
      ? publiees.map(gabaritContribution).join('') + attente.map(gabaritEnAttente).join('')
      : '<p class="souvenirs__vide">Aucun souvenir pour cette étape. Soyez le premier.</p>';
  }

  champFichier.addEventListener('change', () => {
    const fichier = champFichier.files[0];
    nomChoisi.textContent = fichier ? fichier.name : '';
  });

  formulaire.addEventListener('submit', async (evenement) => {
    evenement.preventDefault();
    souci.hidden = true;

    const donnees = new FormData(formulaire);
    const auteur = (donnees.get('auteur') || localStorage.getItem(CLE_AUTEUR) || '').trim();
    const motDePasse = donnees.get('motDePasse') || localStorage.getItem(CLE_MOT_DE_PASSE) || '';
    const texte = (donnees.get('texte') || '').trim();
    let fichier = champFichier.files[0] || null;

    if (!auteur || !motDePasse) {
      souci.textContent = 'Indiquez votre prénom et le mot de passe du groupe.';
      souci.hidden = false;
      return;
    }
    if (!texte && !fichier) {
      souci.textContent = 'Écrivez une note ou choisissez une photo.';
      souci.hidden = false;
      return;
    }

    if (fichier && fichier.type.startsWith('video/')) {
      const refus = verifierVideo(fichier);
      if (refus) { souci.textContent = refus; souci.hidden = false; return; }
    }
    if (fichier && fichier.type.startsWith('image/')) {
      try {
        fichier = await compresserImage(fichier);
      } catch {
        // La compression a échoué : on envoie l'original plutôt que rien.
      }
    }

    localStorage.setItem(CLE_AUTEUR, auteur);
    localStorage.setItem(CLE_MOT_DE_PASSE, motDePasse);

    const entree = {
      type: fichier ? 'media' : 'note',
      jour, auteur, texte, fichier, motDePasse,
      idempotence: creerCleIdempotence(),
    };

    formulaire.reset();
    nomChoisi.textContent = '';

    // On passe systématiquement par la file : c'est elle qui tente l'envoi et
    // qui garde le souvenir si le réseau manque.
    await mettreEnFile(entree);
    await rafraichir();
  });

  liste.addEventListener('click', async (evenement) => {
    const bouton = evenement.target.closest('button[data-action]');
    if (!bouton) return;
    const carte = bouton.closest('[data-id], [data-local]');
    const action = bouton.dataset.action;

    if (action === 'abandonner') {
      await viderEntree(carte.dataset.local);
      await rafraichir();
      return;
    }

    const id = carte.dataset.id;
    const jeton = jetons()[id];
    if (!jeton) return;

    if (action === 'supprimer') {
      if (!confirm('Supprimer ce souvenir ?')) return;
      try {
        await supprimerContribution({ id, jeton });
        oublierJeton(id);
      } catch (probleme) {
        alert(probleme instanceof ErreurService ? probleme.message : 'Suppression impossible pour le moment.');
      }
      await rafraichir();
      return;
    }

    if (action === 'modifier') {
      const actuel = carte.querySelector('.souvenir__texte')?.textContent || '';
      const nouveau = prompt('Modifier le texte :', actuel);
      if (nouveau === null) return;
      try {
        await modifierContribution({ id, texte: nouveau.trim(), jeton });
      } catch (probleme) {
        alert(probleme instanceof ErreurService ? probleme.message : 'Modification impossible pour le moment.');
      }
      await rafraichir();
    }
  });

  demarrerRenvoi({ surChangement: rafraichir });
  rafraichir();
}

export { retenirJeton };
```

- [ ] **Step 2: Retenir le jeton au retour d'un envoi réussi**

Dans `js/souvenirs-file.js`, remplacer le bloc de succès de `renvoyerMaintenant` :

```js
        if (entree.type === 'media') {
          await envoyerMedia(entree);
        } else {
          await envoyerNote(entree);
        }
        await transaction('readwrite', (magasin) => magasin.delete(entree.idLocal));
        signaler();
```

par :

```js
        const resultat = entree.type === 'media'
          ? await envoyerMedia(entree)
          : await envoyerNote(entree);
        // Le jeton n'est renvoyé qu'une fois : c'est ici qu'on le capte, sinon
        // l'auteur perdrait la main sur son propre souvenir.
        if (resultat?.jeton && resultat?.contribution) {
          surJeton(resultat.contribution.id, resultat.jeton);
        }
        await transaction('readwrite', (magasin) => magasin.delete(entree.idLocal));
        signaler();
```

Toujours dans `js/souvenirs-file.js`, ajouter sous `let signaler = () => {};` :

```js
let surJeton = () => {};
```

et, dans `demarrerRenvoi`, sous `if (surChangement) signaler = surChangement;` :

```js
  if (memoriserJeton) surJeton = memoriserJeton;
```

en changeant la signature en :

```js
export function demarrerRenvoi({ surChangement, memoriserJeton } = {}) {
```

- [ ] **Step 3: Passer la mémorisation depuis la vue**

Dans `js/souvenirs-vue.js`, remplacer :

```js
  demarrerRenvoi({ surChangement: rafraichir });
```

par :

```js
  demarrerRenvoi({ surChangement: rafraichir, memoriserJeton: retenirJeton });
```

- [ ] **Step 4: Ajouter le style**

À la fin de `css/style.css`, avant la section `/* --------- mobile */`, insérer :

```css
/* ------------------------------------------------------------- souvenirs */

.souvenirs { margin: 1.5rem 0 0; }

.souvenirs__vide, .souvenirs__liste { font-size: .875rem; color: var(--poussiere); }

.souvenir {
  padding: .625rem 0;
  border-top: 1px solid var(--nuit-3);
}

.souvenir__entete {
  display: flex;
  align-items: baseline;
  gap: .5rem;
  margin: 0 0 .375rem;
  font-family: var(--mono);
  font-size: .625rem;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--poussiere);
}
.souvenir__entete b { color: var(--sel); font-weight: 500; }
.souvenir__entete em { font-style: normal; color: var(--soufre); }

.souvenir__media {
  display: block;
  width: 100%;
  height: auto;
  margin-bottom: .375rem;
  background: var(--nuit-2);
}

.souvenir__texte {
  margin: 0;
  font-size: .875rem;
  line-height: 1.55;
  color: #cdd3de;
}

.souvenir__actions { display: flex; gap: .5rem; margin: .375rem 0 0; }

.souvenir__actions button {
  padding: .1875rem .5rem;
  border: 1px solid var(--nuit-3);
  background: none;
  color: var(--poussiere);
  font-family: var(--mono);
  font-size: .5625rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: color var(--transition), border-color var(--transition);
}
.souvenir__actions button:hover { border-color: var(--soufre); color: var(--soufre); }

.souvenir.est-en-attente { opacity: .6; border-left: 2px solid var(--soufre); padding-left: .625rem; }

/* Formulaire */

.souvenir-form { margin: 1rem 0 0; }

.souvenir-form__champ {
  display: block;
  width: 100%;
  margin-bottom: .375rem;
  padding: .4375rem .5rem;
  border: 1px solid var(--nuit-3);
  background: var(--nuit-2);
  color: var(--sel);
  font-family: var(--display);
  font-size: .875rem;
  resize: vertical;
}
.souvenir-form__champ::placeholder { color: var(--poussiere); }
.souvenir-form__champ:focus { border-color: var(--soufre); outline: none; }

.souvenir-form__pied { display: flex; align-items: center; gap: .5rem; margin: 0; }

.souvenir-form__fichier,
.souvenir-form__pied button {
  padding: .375rem .625rem;
  border: 1px solid var(--nuit-3);
  background: var(--nuit-2);
  color: var(--sel);
  font-family: var(--mono);
  font-size: .625rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color var(--transition);
}
.souvenir-form__fichier:hover,
.souvenir-form__pied button:hover { border-color: var(--soufre); }

.souvenir-form__pied button { margin-left: auto; background: var(--soufre); color: var(--nuit); border-color: var(--soufre); }

.souvenir-form__choisi {
  overflow: hidden;
  font-family: var(--mono);
  font-size: .5625rem;
  color: var(--poussiere);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.souvenir-form__souci {
  margin: .375rem 0 0;
  font-size: .8125rem;
  color: var(--colorada);
}
.souvenir-form__souci[hidden] { display: none; }
```

- [ ] **Step 5: Brancher dans `js/app.js`**

Ajouter l'import sous les deux existants :

```js
import { monterSouvenirs } from './souvenirs-vue.js';
```

Dans `gabaritFiche`, juste avant la `<div class="navigation">`, ajouter le conteneur :

```js
    <div class="souvenirs" id="souvenirs-etape"></div>

```

Dans `afficherPanneau`, à l'intérieur du `if (etape) { … }`, après le bloc `dessinerProfilEtape`, ajouter :

```js
    const bloc = elements.panneau.querySelector('#souvenirs-etape');
    if (bloc) monterSouvenirs(bloc, etape.jour);
```

- [ ] **Step 6: Vérifier la syntaxe**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
for f in js/app.js js/souvenirs-vue.js js/souvenirs-file.js; do
  cp "$f" "/tmp/v-$(basename $f .js).mjs" && node --check "/tmp/v-$(basename $f .js).mjs" && echo "$f OK"
done; rm -f /tmp/v-*.mjs```

Attendu : les trois fichiers affichent `OK`.

- [ ] **Step 7: Vérifier le bloc dans le navigateur**

Worker et site lancés, ouvrir <http://127.0.0.1:8123/#j7>. Dans le panneau, sous le récit :

Attendu : le titre « Souvenirs des compagnons », la liste (ou « Aucun souvenir pour cette étape »), et le formulaire avec prénom, mot de passe, texte, bouton fichier et « Publier ».

Publier une note avec le mot de passe `<mot-de-passe-de-groupe-local>`.

Attendu : elle apparaît dans la liste avec le prénom et l'heure, et les boutons « Modifier » et « Supprimer » sont visibles **sur cette note**.

Recharger la page : le prénom et le mot de passe ne sont plus demandés.

- [ ] **Step 8: Vérifier que les boutons n'apparaissent pas ailleurs**

Ouvrir la même étape dans une fenêtre de navigation privée.

Attendu : la note est visible, **sans** les boutons « Modifier » et « Supprimer ».

- [ ] **Step 9: Vérifier la dégradation quand le service est éteint**

Arrêter le Worker, recharger <http://127.0.0.1:8123/#j7>.

Attendu : la carte, le profil et la fiche fonctionnent normalement ; seul le bloc souvenirs affiche « Les souvenirs ne se chargent pas pour le moment. » Aucune erreur bloquante dans la console.

- [ ] **Step 10: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add js/souvenirs-vue.js js/souvenirs-file.js js/app.js css/style.css
git commit -m "Souvenirs : bloc dans le panneau d'etape, formulaire et actions d'auteur"
```

---

### Task 9: Page de modération

**Files:**
- Create: `js/admin.js`
- Create: `admin.html`
- Modify: `css/style.css`

**Interfaces:**
- Consumes: `listerTout`, `supprimerContribution`, `urlMedia`, `chargerConfig` de `js/souvenirs.js`.
- Produces: une page `admin.html` autonome, listant toutes les contributions avec un bouton de suppression.

- [ ] **Step 1: Créer la page**

`admin.html` :

```html
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Modération des souvenirs</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="css/style.css">
</head>
<body class="page-admin">
<header class="bandeau">
  <div class="bandeau__identite">
    <p class="eyebrow">Salta → Cusco</p>
    <h1 class="bandeau__titre">Modération</h1>
  </div>
  <p style="margin:0 0 0 auto"><a class="bouton-accueil" href="index.html">← Le site</a></p>
</header>

<main class="admin" id="admin"></main>

<script type="module" src="js/admin.js"></script>
</body>
</html>
```

- [ ] **Step 2: Écrire le script**

`js/admin.js` :

```js
/* Page de modération : liste tout, permet de supprimer n'importe quelle entrée.

   Le mot de passe d'administration est distinct de celui du groupe et n'est
   gardé que pour la durée de l'onglet. */

import {
  chargerConfig, listerTout, supprimerContribution, urlMedia, ErreurService,
} from './souvenirs.js';

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const racine = document.getElementById('admin');
let motDePasse = sessionStorage.getItem('souvenirs.admin') || '';

function demander() {
  racine.innerHTML = `<form class="souvenir-form" style="max-width:22rem">
    <input class="souvenir-form__champ" type="password" name="motDePasse"
           placeholder="Mot de passe de modération" required>
    <p class="souvenir-form__pied"><button type="submit">Ouvrir</button></p>
    <p class="souvenir-form__souci" hidden></p>
  </form>`;
  const formulaire = racine.querySelector('form');
  formulaire.addEventListener('submit', (evenement) => {
    evenement.preventDefault();
    motDePasse = new FormData(formulaire).get('motDePasse');
    sessionStorage.setItem('souvenirs.admin', motDePasse);
    afficher();
  });
}

function gabarit(contribution) {
  const media = contribution.media;
  const apercu = !media ? '' : media.genre === 'video'
    ? `<video class="souvenir__media" src="${echapper(urlMedia(media.cle))}" controls preload="metadata"></video>`
    : `<img class="souvenir__media" src="${echapper(urlMedia(media.cle))}" alt="" loading="lazy">`;
  return `<article class="souvenir" data-id="${echapper(contribution.id)}">
    <p class="souvenir__entete">
      <b>${echapper(contribution.auteur)}</b>
      <time>J${contribution.jour} · ${echapper(new Date(contribution.creeLe).toLocaleString('fr-FR'))}</time>
    </p>
    ${apercu}
    ${contribution.texte ? `<p class="souvenir__texte">${echapper(contribution.texte)}</p>` : ''}
    <p class="souvenir__actions"><button type="button" data-action="supprimer">Supprimer</button></p>
  </article>`;
}

async function afficher() {
  racine.innerHTML = '<p class="souvenirs__vide">Chargement…</p>';
  let contributions;
  try {
    contributions = await listerTout(motDePasse);
  } catch (souci) {
    sessionStorage.removeItem('souvenirs.admin');
    motDePasse = '';
    demander();
    const souciTexte = racine.querySelector('.souvenir-form__souci');
    souciTexte.textContent = souci instanceof ErreurService
      ? 'Mot de passe refusé.'
      : 'Le service ne répond pas.';
    souciTexte.hidden = false;
    return;
  }

  racine.innerHTML = contributions.length
    ? `<p class="sous-titre">${contributions.length} contribution(s)</p>${contributions.map(gabarit).join('')}`
    : '<p class="souvenirs__vide">Aucune contribution pour le moment.</p>';

  racine.addEventListener('click', async (evenement) => {
    const bouton = evenement.target.closest('button[data-action="supprimer"]');
    if (!bouton) return;
    const id = bouton.closest('[data-id]').dataset.id;
    if (!confirm('Supprimer définitivement cette contribution ?')) return;
    try {
      await supprimerContribution({ id, motDePasse });
    } catch {
      alert('Suppression impossible pour le moment.');
    }
    afficher();
  }, { once: true });
}

await chargerConfig();
if (motDePasse) afficher(); else demander();
```

- [ ] **Step 3: Ajouter le style de la page**

À la suite du bloc souvenirs dans `css/style.css` :

```css
.page-admin { display: block; overflow: auto; }
.admin { max-width: 42rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
```

- [ ] **Step 4: Vérifier la syntaxe**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
cp js/admin.js /tmp/v-admin.mjs && node --check /tmp/v-admin.mjs && echo OK && rm -f /tmp/v-admin.mjs
```

Attendu : `OK`

- [ ] **Step 5: Vérifier la page**

Worker et site lancés, ouvrir <http://127.0.0.1:8123/admin.html>.

Attendu : un champ mot de passe. Saisir un mauvais mot de passe → « Mot de passe refusé. » Saisir `<mot-de-passe-admin-local>` → la liste de toutes les contributions, toutes étapes confondues.

Supprimer une entrée, puis revenir au site sur l'étape concernée.

Attendu : elle a disparu du site aussi.

- [ ] **Step 6: Commit**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add admin.html js/admin.js css/style.css
git commit -m "Souvenirs : page de moderation protegee par mot de passe"
```

---

### Task 10: Déploiement et documentation

**Files:**
- Modify: `data/config.json`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: le service en ligne, le site publié qui l'utilise, et la marche à suivre écrite.

- [ ] **Step 1: Créer les ressources Cloudflare**

```bash
cd worker
npx wrangler login
npx wrangler d1 create souvenirs
npx wrangler r2 bucket create souvenirs-medias
```

Attendu : `d1 create` affiche un bloc `[[d1_databases]]` contenant un `database_id`. **Copier cet identifiant** dans `worker/wrangler.toml`, à la place de `à-renseigner-au-deploiement`.

- [ ] **Step 2: Appliquer le schéma en production**

```bash
cd worker && npx wrangler d1 execute souvenirs --remote --file=schema.sql
```

Attendu : les deux instructions du schéma s'exécutent sans erreur.

- [ ] **Step 3: Poser les deux mots de passe**

```bash
cd worker
npx wrangler secret put MOT_DE_PASSE_GROUPE
npx wrangler secret put MOT_DE_PASSE_ADMIN
```

Choisir un mot de passe de groupe simple à dire de vive voix, et un mot de passe d'administration différent et plus long. Ils ne doivent **jamais** être écrits dans le dépôt.

- [ ] **Step 4: Déployer**

```bash
cd worker && npx wrangler deploy
```

Attendu : une adresse du type `https://souvenirs-salta-cusco.<compte>.workers.dev`.

- [ ] **Step 5: Pointer le site sur le service en ligne**

Remplacer le contenu de `data/config.json` par l'adresse obtenue :

```json
{
  "serviceUrl": "https://souvenirs-salta-cusco.<compte>.workers.dev"
}
```

- [ ] **Step 6: Vérifier depuis le site publié**

```bash
curl -s "https://souvenirs-salta-cusco.<compte>.workers.dev/api/etape/7"
```

Attendu : `{"contributions":[]}`

- [ ] **Step 7: Documenter dans le README**

Ajouter à la fin de `README.md` :

```markdown
## Souvenirs des compagnons

Chaque étape porte un bloc où les participants laissent des notes, photos et
vidéos. Le site reste statique : ce bloc parle à un petit service Cloudflare
(dossier `worker/`), qui range les fichiers dans R2 et les notes dans D1.

**Pour poster**, il faut le mot de passe du groupe — donné de vive voix avant le
départ. Il n'est demandé qu'une fois par téléphone.

**Si le réseau manque** (et il manquera, dans le Sud Lipez comme sur le salar),
l'envoi est gardé sur le téléphone avec la mention « en attente de réseau », et
repart tout seul dès que ça capte. Rien ne se perd.

**Chacun peut modifier ou supprimer ses propres souvenirs** : les boutons
n'apparaissent que sur le téléphone qui les a publiés. Changer d'appareil ou
vider son navigateur fait perdre cette main — la modération, elle, reste
valable sur tout.

**Modération** : `admin.html`, avec le mot de passe d'administration. Permet de
supprimer n'importe quelle contribution.

### Redéployer le service

```bash
cd worker && npx wrangler deploy
```

Les deux mots de passe sont des secrets Cloudflare, jamais dans le dépôt :

```bash
cd worker && npx wrangler secret put MOT_DE_PASSE_GROUPE
```

L'adresse du service est dans `data/config.json` — c'est le seul endroit à
changer si le Worker déménage.

### Développer en local

```bash
cd worker && npm install && npx wrangler d1 execute souvenirs --local --file=schema.sql
cd worker && npx wrangler dev --local --port 8787
```

Les mots de passe locaux vont dans `worker/.dev.vars` (ignoré par git). Pointer
temporairement `data/config.json` sur `http://127.0.0.1:8787`, sans committer ce
changement.

Tests des fonctions d'autorisation :

```bash
cd worker && node --test test/
```
```

- [ ] **Step 8: Vérifier que rien de secret n'est committé**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git status --porcelain
grep -rn "MOT_DE_PASSE" --include="*.toml" --include="*.json" --include="*.js" . | grep -v node_modules | grep -v "env.MOT_DE_PASSE" | grep -v "X-Mot-De-Passe"
```

Attendu : aucune valeur de mot de passe en clair ; `.dev.vars` absent de `git status` (ignoré).

- [ ] **Step 9: Commit et publication**

```bash
cd "/Users/martin/Documents/Claude/Vintage Rides"
git add -A
git commit -m "Souvenirs : configuration du service deploye et documentation"
git push origin main
```

Attendu : le workflow GitHub Pages republie le site. Vérifier ensuite sur
<https://tinmarlastar.github.io/salta-cusco/#j7> que le bloc souvenirs se charge
et qu'une note peut être postée.

---

## Vérification finale

Une fois les dix tâches faites, dérouler la recette de la spec :

1. Poster une note, une photo, une vidéo depuis un téléphone.
2. Modifier puis supprimer sa propre note ; vérifier depuis un autre navigateur
   que les boutons n'y apparaissent pas.
3. Mode avion : poster, vérifier « en attente de réseau ». Rétablir : vérifier
   le renvoi automatique et l'**absence de doublon**.
4. Mauvais mot de passe refusé ; `admin.html` supprime n'importe quelle entrée.
5. Worker éteint : le reste du site fonctionne normalement.
