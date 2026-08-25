# Position automatique des motards, et modules d'administration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un mode automatique (date de départ + décalage) à la position des motards déjà existante, et réorganiser `admin.html` en deux modules — « Où en sont les motos » et « Modération » — choisis depuis un menu à gauche.

**Architecture:** Le calcul J+X reste entièrement dans le worker Cloudflare : `GET /api/position` renvoie toujours `{ jour, majLe }` (plus, en plus, `mode`/`depart`/`decalage` pour l'admin) — le site public (`js/app.js`, `js/carte.js`, `js/profil.js`, `index.html`) n'est touché nulle part. La table `reglages` (clé/valeur, déjà là) gagne trois clés au lieu d'une, sans migration. La journée automatique se calcule dans un module pur et testable (`worker/lib/position.js`), sur le même patron que `worker/lib/securite.js`.

**Tech Stack:** Cloudflare Worker (JS module, D1), `node --test` pour les tests worker, HTML/CSS/JS vanilla côté site (aucun framework), Wrangler pour le développement local.

**Spec:** `docs/superpowers/specs/2026-08-25-position-motards-admin-design.md`

## Global Constraints

- Aucune migration de schéma : `reglages(cle, valeur, maj_le)` existe déjà et reste inchangée.
- `GET /api/position` garde `{ jour, majLe }` pour compatibilité avec le site public ; les champs `mode`/`depart`/`decalage` s'ajoutent, ils ne remplacent rien.
- Le calcul de la journée automatique se fait dans le worker, jamais dans le navigateur.
- Changement de fuseau au minuit de Paris (`Europe/Paris`), via `Intl.DateTimeFormat` — aucune bibliothèque de dates.
- Décalage borné à ±30 jours ; date de départ au format `AAAA-MM-JJ`.
- Rétrocompatibilité : une base qui n'a que `position_jour` (sans `position_mode`) se lit comme mode manuel.
- `js/app.js`, `js/carte.js`, `js/profil.js`, `index.html`, `worker/schema.sql` ne sont modifiés par aucune tâche de ce plan.
- Style du dépôt : commentaires en français qui expliquent le *pourquoi*, pas le *quoi* ; noms de fonctions et de variables en français, comme le reste du code touché.

---

## Task 1: Calcul pur de la position automatique

**Files:**
- Create: `worker/lib/position.js`
- Test: `worker/test/position.test.js`

**Interfaces:**
- Produces: `dateParisDuJour(maintenant?: Date): string` (« AAAA-MM-JJ ») ; `joursEntre(depart: string, arrivee: string): number` ; `calculerPositionAuto({ depart: string, decalage?: number, maintenant?: Date }): number | null` — utilisées par la Task 2.

- [ ] **Step 1: Écrire les tests, qui échouent faute de module**

Créer `worker/test/position.test.js` :

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dateParisDuJour, joursEntre, calculerPositionAuto } from '../lib/position.js';

test('dateParisDuJour formate en AAAA-MM-JJ', () => {
  assert.match(dateParisDuJour(new Date('2026-09-01T10:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});

test('joursEntre compte les jours calendaires entre deux dates', () => {
  assert.equal(joursEntre('2026-09-01', '2026-09-01'), 0);
  assert.equal(joursEntre('2026-09-01', '2026-09-08'), 7);
  assert.equal(joursEntre('2026-09-01', '2026-08-31'), -1);
});

test('calculerPositionAuto place J1 le jour du départ', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-09-01T10:00:00Z'),
  });
  assert.equal(jour, 1);
});

test('calculerPositionAuto avance d\'une journée par jour écoulé', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-09-08T10:00:00Z'),
  });
  assert.equal(jour, 8);
});

test('calculerPositionAuto renvoie null avant le départ', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-08-31T10:00:00Z'),
  });
  assert.equal(jour, null);
});

test('calculerPositionAuto plafonne à 15 une fois le voyage fini', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-09-25T10:00:00Z'),
  });
  assert.equal(jour, 15);
});

test('calculerPositionAuto applique un décalage positif', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', decalage: 2, maintenant: new Date('2026-09-01T10:00:00Z'),
  });
  assert.equal(jour, 3);
});

test('calculerPositionAuto applique un décalage négatif, jusqu\'à repasser sous J1', () => {
  assert.equal(calculerPositionAuto({
    depart: '2026-09-01', decalage: -1, maintenant: new Date('2026-09-01T10:00:00Z'),
  }), null);
  assert.equal(calculerPositionAuto({
    depart: '2026-09-01', decalage: -1, maintenant: new Date('2026-09-02T10:00:00Z'),
  }), 1);
});
```

- [ ] **Step 2: Lancer les tests, vérifier qu'ils échouent**

Run: `cd worker && node --test test/position.test.js`
Expected: FAIL — `Cannot find module '../lib/position.js'`

- [ ] **Step 3: Écrire `worker/lib/position.js`**

```js
/* Calcul de la position automatique des motards : à partir d'une date de
   départ et d'un décalage, quelle journée du voyage (1 à 15) montrer.

   Fonctions pures, sans accès réseau ni base — testables directement, comme
   lib/securite.js. À tenir en phase avec `JOURS` dans worker/index.js si le
   voyage change un jour de longueur. */

const JOURS_VOYAGE = 15;

/** La date du jour à Paris, au format AAAA-MM-JJ.

    Le voyage traverse plusieurs fuseaux (Argentine à -3, Pérou à -5) :
    aucun n'est plus « juste » qu'un autre pour dire quand on change de
    journée. Paris est le fuseau de ceux qui suivent le voyage.
    `Intl.DateTimeFormat` gère l'heure d'été sans bibliothèque, et le
    calendrier canadien (`en-CA`) produit directement AAAA-MM-JJ. */
export function dateParisDuJour(maintenant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(maintenant);
}

function versInstant(aaaaMmJj) {
  const [annee, mois, jour] = aaaaMmJj.split('-').map(Number);
  return Date.UTC(annee, mois - 1, jour); // `mois - 1` : Date.UTC compte les mois à partir de 0
}

/** Jours entiers entre deux dates AAAA-MM-JJ (positif si `arrivee` suit `depart`). */
export function joursEntre(depart, arrivee) {
  const MS_PAR_JOUR = 24 * 60 * 60 * 1000;
  return Math.round((versInstant(arrivee) - versInstant(depart)) / MS_PAR_JOUR);
}

/** La journée à montrer (1 à 15), ou `null` avant le départ.

    `depart` : date AAAA-MM-JJ. `decalage` : jours d'avance (positif) ou de
    retard (négatif) — un décalage négatif peut repousser sous J1 même après
    le départ. `maintenant` : injectable pour les tests, sinon l'instant
    présent. Au-delà du quinzième jour, plafonne à 15 : le voyage est fini,
    les motos restent à Cusco plutôt que de disparaître. */
export function calculerPositionAuto({ depart, decalage = 0, maintenant = new Date() }) {
  const aujourdhui = dateParisDuJour(maintenant);
  const ecoules = joursEntre(depart, aujourdhui);
  const jour = ecoules + 1 + decalage;
  if (jour < 1) return null;
  if (jour > JOURS_VOYAGE) return JOURS_VOYAGE;
  return jour;
}
```

- [ ] **Step 4: Lancer les tests, vérifier qu'ils passent**

Run: `cd worker && node --test test/position.test.js`
Expected: PASS — 8 tests, 0 échec.

- [ ] **Step 5: Lancer toute la suite du worker, vérifier l'absence de régression**

Run: `cd worker && npm test`
Expected: PASS — les tests existants (`securite.test.js`, `souvenirs-file.test.js`) plus les 8 nouveaux, tous verts.

- [ ] **Step 6: Commit**

```bash
git add worker/lib/position.js worker/test/position.test.js
git commit -m "Calcul pur de la position automatique des motards"
```

---

## Task 2: Le worker lit et écrit les deux modes

**Files:**
- Modify: `worker/index.js:1-10` (import), `worker/index.js:589-631` (`CLE_POSITION`, `lirePosition`, `ecrirePosition`)

**Interfaces:**
- Consumes: `calculerPositionAuto({ depart, decalage, maintenant? })` de la Task 1.
- Produces: `GET /api/position` → `{ jour, majLe, mode, depart, decalage }` ; `PUT /api/position` accepte `{ mode: 'manuel', jour }`, `{ mode: 'auto', depart, decalage }`, `{ mode: null }` — consommé par la Task 3.

- [ ] **Step 1: Ajouter l'import**

Dans `worker/index.js`, après la ligne 5 (`import { creerId, creerJeton, hacherJeton, memeSecret } from './lib/securite.js';`) :

```js
import { calculerPositionAuto } from './lib/position.js';
```

- [ ] **Step 2: Remplacer `CLE_POSITION` par les quatre clés**

Remplacer (ligne 589) :

```js
const CLE_POSITION = 'position_jour';
```

par :

```js
const CLES_POSITION = {
  mode: 'position_mode',
  jour: 'position_jour',
  depart: 'position_depart',
  decalage: 'position_decalage',
};
```

- [ ] **Step 3: Réécrire `lirePosition`**

Remplacer la fonction `lirePosition` (lignes 591-605) par :

```js
/** Position des motos, journée déjà calculée. Ouverte en lecture, comme les
    souvenirs : c'est ce que les proches viennent voir. `mode`, `depart` et
    `decalage` accompagnent la réponse pour la modération, qui en a besoin
    pour réafficher le formulaire tel qu'il a été laissé — rien de sensible,
    le site public les ignore (voir `lirePosition` dans souvenirs.js, qui ne
    garde que `jour` et `majLe`). */
async function lirePosition(env, cors) {
  const { results } = await env.DB
    .prepare('SELECT cle, valeur, maj_le FROM reglages WHERE cle IN (?1, ?2, ?3, ?4)')
    .bind(CLES_POSITION.mode, CLES_POSITION.jour, CLES_POSITION.depart, CLES_POSITION.decalage)
    .all();
  const parCle = new Map(results.map((l) => [l.cle, l]));

  // Une base d'avant ce réglage n'a que `position_jour`, jamais
  // `position_mode` : un mode absent avec une journée posée se lit comme
  // manuel, sans migration à écrire.
  const mode = parCle.get(CLES_POSITION.mode)?.valeur
    ?? (parCle.get(CLES_POSITION.jour) ? 'manuel' : null);

  const jourManuel = Number(parCle.get(CLES_POSITION.jour)?.valeur);
  const depart = parCle.get(CLES_POSITION.depart)?.valeur ?? null;
  const decalage = Number(parCle.get(CLES_POSITION.decalage)?.valeur ?? 0);

  let jour = null;
  if (mode === 'manuel' && Number.isInteger(jourManuel)) jour = jourManuel;
  if (mode === 'auto' && depart) jour = calculerPositionAuto({ depart, decalage });

  const majLe = parCle.get(CLES_POSITION.mode)?.maj_le
    ?? parCle.get(CLES_POSITION.jour)?.maj_le
    ?? null;

  return repondre({ jour, majLe, mode, depart, decalage }, { cors });
}
```

- [ ] **Step 4: Réécrire `ecrirePosition`**

Remplacer la fonction `ecrirePosition` (lignes 607-631) par :

```js
async function poserReglage(env, cle, valeur, majLe) {
  await env.DB.prepare(
    `INSERT INTO reglages (cle, valeur, maj_le) VALUES (?1, ?2, ?3)
       ON CONFLICT(cle) DO UPDATE SET valeur = ?2, maj_le = ?3`,
  ).bind(cle, valeur, majLe).run();
}

async function ecrirePosition(requete, env, cors) {
  if (!await adminAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  const corps = await requete.json().catch(() => ({}));
  const majLe = new Date().toISOString();

  // `mode: null` efface tout : retour à « pas encore partis ». C'est un état
  // légitime, pas une donnée manquante, d'où la suppression des lignes
  // plutôt qu'une valeur convenue qu'il faudrait ensuite reconnaître partout.
  if (corps.mode === null) {
    await env.DB.prepare('DELETE FROM reglages WHERE cle IN (?1, ?2, ?3, ?4)').bind(
      CLES_POSITION.mode, CLES_POSITION.jour, CLES_POSITION.depart, CLES_POSITION.decalage,
    ).run();
    return repondre({ jour: null, majLe: null, mode: null, depart: null, decalage: 0 }, { cors });
  }

  if (corps.mode === 'manuel') {
    const jour = Number(corps.jour);
    if (!Number.isInteger(jour) || jour < 1 || jour > JOURS) {
      return erreur(`Journée attendue entre 1 et ${JOURS}`, 400, cors);
    }
    await poserReglage(env, CLES_POSITION.mode, 'manuel', majLe);
    await poserReglage(env, CLES_POSITION.jour, String(jour), majLe);
    return repondre({ jour, majLe, mode: 'manuel', depart: null, decalage: 0 }, { cors });
  }

  if (corps.mode === 'auto') {
    const depart = corps.depart;
    if (typeof depart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(depart)) {
      return erreur('Date de départ attendue au format AAAA-MM-JJ', 400, cors);
    }
    const decalage = corps.decalage === undefined ? 0 : Number(corps.decalage);
    if (!Number.isInteger(decalage) || decalage < -30 || decalage > 30) {
      return erreur('Décalage attendu entre -30 et 30 jours', 400, cors);
    }
    await poserReglage(env, CLES_POSITION.mode, 'auto', majLe);
    await poserReglage(env, CLES_POSITION.depart, depart, majLe);
    await poserReglage(env, CLES_POSITION.decalage, String(decalage), majLe);
    const jour = calculerPositionAuto({ depart, decalage });
    return repondre({ jour, majLe, mode: 'auto', depart, decalage }, { cors });
  }

  return erreur('Réglage de position invalide', 400, cors);
}
```

Remarque : `poserReglage` et `ecrirePosition` remplacent l'unique `ecrirePosition` d'avant — les deux fonctions vont ensemble, `poserReglage` n'étant utile qu'ici.

- [ ] **Step 5: Lancer la suite de tests du worker**

Run: `cd worker && npm test`
Expected: PASS — aucun test n'exerçait `lirePosition`/`ecrirePosition` avant (ce sont des fonctions qui touchent `env.DB`, pas testées unitairement dans ce dépôt, voir `README.md`), donc rien de nouveau ne casse ; les tests de la Task 1 et les tests existants passent toujours.

- [ ] **Step 6: Vérification manuelle bout en bout**

Dans un terminal :

```bash
cd worker
npx wrangler d1 execute souvenirs --local --file=schema.sql
npx wrangler dev --local --port 8787
```

Dans un second terminal (adapter `MOT` au mot de passe de `worker/.dev.vars`) :

```bash
MOT=le-mot-de-passe-admin-local

# Lecture initiale : rien de posé
curl -s http://localhost:8787/api/position
# Attendu : {"jour":null,"majLe":null,"mode":null,"depart":null,"decalage":0}

# Écriture refusée sans mot de passe
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -d '{"mode":"manuel","jour":7}'
# Attendu : 401, {"erreur":"Mot de passe incorrect"}

# Mode manuel
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" -d '{"mode":"manuel","jour":7}'
curl -s http://localhost:8787/api/position
# Attendu : jour 7, mode "manuel"

# Mode automatique, départ aujourd'hui : J1 attendu
AUJOURDHUI=$(date +%F)
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" \
  -d "{\"mode\":\"auto\",\"depart\":\"$AUJOURDHUI\",\"decalage\":0}"
curl -s http://localhost:8787/api/position
# Attendu : jour 1, mode "auto", depart == $AUJOURDHUI

# Repasser en manuel garde la date de départ posée (relire après un aller-retour)
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" -d '{"mode":"manuel","jour":3}'
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" \
  -d "{\"mode\":\"auto\",\"depart\":\"$AUJOURDHUI\",\"decalage\":2}"
curl -s http://localhost:8787/api/position
# Attendu : jour 3 (J1 + décalage 2)

# Rejets
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" -d '{"mode":"manuel","jour":0}'
# Attendu : 400
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" -d '{"mode":"auto","depart":"pas-une-date"}'
# Attendu : 400
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" -d '{"mode":"auto","depart":"'"$AUJOURDHUI"'","decalage":99}'
# Attendu : 400

# Effacement
curl -s -X PUT http://localhost:8787/api/position \
  -H 'Content-Type: application/json' -H "X-Mot-De-Passe: $MOT" -d '{"mode":null}'
curl -s http://localhost:8787/api/position
# Attendu : {"jour":null,"majLe":null,"mode":null,"depart":null,"decalage":0}
```

- [ ] **Step 7: Rétrocompatibilité — vérifier la lecture d'une donnée d'avant ce changement**

```bash
# Simule une base d'avant cette fonctionnalité : seul position_jour existe.
npx wrangler d1 execute souvenirs --local --command \
  "INSERT INTO reglages (cle, valeur, maj_le) VALUES ('position_jour', '5', '2026-08-01T00:00:00.000Z')"
curl -s http://localhost:8787/api/position
# Attendu : {"jour":5,"majLe":"2026-08-01T00:00:00.000Z","mode":"manuel","depart":null,"decalage":0}
npx wrangler d1 execute souvenirs --local --command "DELETE FROM reglages"
```

- [ ] **Step 8: Arrêter `wrangler dev`, commit**

```bash
git add worker/index.js
git commit -m "Le worker calcule la position automatique et garde le mode manuel"
```

---

## Task 3: Le client parle des deux modes

**Files:**
- Modify: `js/souvenirs.js:205-223` (`lirePosition`, `ecrirePosition`)

**Interfaces:**
- Consumes: `GET`/`PUT /api/position` de la Task 2.
- Produces: `lirePosition(): Promise<{ jour, majLe }>` (inchangée, utilisée par le site public) ; `lireReglagesPosition(): Promise<{ jour, majLe, mode, depart, decalage }>` et `ecrirePosition({ mode, jour?, depart?, decalage?, motDePasse }): Promise<{...}>` — utilisées par la Task 5.

- [ ] **Step 1: Ajouter `lireReglagesPosition` et réécrire `ecrirePosition`**

Dans `js/souvenirs.js`, `lirePosition` (lignes 205-211) ne change pas. Juste après, remplacer `ecrirePosition` (lignes 213-223) par :

```js
/** Réglages complets de la position — mode, date de départ, décalage — en
    plus de la journée déjà calculée. Réservée à la modération : le site
    public n'a besoin que de `lirePosition`, ci-dessus, qui ne garde que
    `jour` et `majLe`. */
export async function lireReglagesPosition() {
  const donnees = await appeler('/api/position');
  return {
    jour: donnees.jour ?? null,
    majLe: donnees.majLe ?? null,
    mode: donnees.mode ?? null,
    depart: donnees.depart ?? null,
    decalage: donnees.decalage ?? 0,
  };
}

/** Dit où en sont les motos.

    `mode: 'manuel'` pose une journée choisie à la main ; `mode: 'auto'` pose
    une date de départ et un décalage, et laisse le service recalculer la
    journée à chaque lecture ; `mode: null` efface tout, retour à « pas
    encore partis ». Réservée à l'administration : la position parle au nom
    du groupe, elle n'est pas une contribution parmi d'autres. */
export async function ecrirePosition({ mode, jour, depart, decalage, motDePasse }) {
  const corps = mode === 'manuel' ? { mode, jour }
    : mode === 'auto' ? { mode, depart, decalage }
    : { mode: null };
  return appeler('/api/position', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Mot-De-Passe': motDePasse },
    body: JSON.stringify(corps),
  });
}
```

- [ ] **Step 2: Vérifier qu'aucun fichier hors admin n'utilisait l'ancienne signature de `ecrirePosition`**

Run: `grep -rn "ecrirePosition" js/ --include=*.js`
Expected: seuls `js/souvenirs.js` (la définition) et `js/admin.js` (l'appelant, réécrit en Task 5) apparaissent. `js/app.js`, `js/carte.js`, `js/profil.js` n'apparaissent pas.

- [ ] **Step 3: Commit**

```bash
git add js/souvenirs.js
git commit -m "Le client sait lire et écrire les deux modes de position"
```

---

## Task 4: Styles du menu d'administration et du choix de mode

**Files:**
- Modify: `css/style.css:1374-1413` (`.page-admin`, `.admin`, ajouts après `.admin-position__note`)

**Interfaces:**
- Produces: classes `.admin-mise-en-page`, `.admin-nav`, `.admin-nav__bouton`, `.admin-contenu`, `.position-mode`, `.position-mode__bouton` — utilisées par la Task 5.

- [ ] **Step 1: Élargir `.admin` et ajouter les styles**

Remplacer (ligne 1374-1375) :

```css
.page-admin { display: block; overflow: auto; }
.admin { max-width: 42rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
```

par :

```css
.page-admin { display: block; overflow: auto; }
.admin { max-width: 58rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }

/* Le menu à gauche et le module actif, côte à côte — repris des onglets
   Étape/Souvenirs du site public (voir .onglets plus haut), en colonne
   plutôt qu'en ligne. */
.admin-mise-en-page { display: flex; gap: 2.5rem; align-items: flex-start; }

.admin-nav {
  display: flex;
  flex: 0 0 12rem;
  flex-direction: column;
  gap: .25rem;
  position: sticky;
  top: 1.5rem;
}
.admin-nav__bouton {
  padding: .5rem .625rem;
  border: 0;
  border-left: 2px solid transparent;
  background: none;
  color: var(--poussiere);
  font-family: var(--mono);
  font-size: .6875rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  text-align: left;
  cursor: pointer;
  transition: color var(--transition), border-color var(--transition);
}
.admin-nav__bouton:hover { color: var(--sel); }
.admin-nav__bouton[aria-pressed="true"] { color: var(--soufre); border-left-color: var(--soufre); }

.admin-contenu { flex: 1 1 0; min-width: 0; }

/* Manuel/Automatique : même motif que les fonds de carte (.fonds__bouton) —
   un groupe de boutons soudés, celui du mode affiché rempli de l'accent. */
.position-mode {
  display: flex;
  gap: 1px;
  width: fit-content;
  margin-bottom: 1rem;
  background: var(--nuit-3);
  border: 1px solid var(--nuit-3);
}
.position-mode__bouton {
  padding: .4375rem .75rem;
  border: 0;
  background: var(--nuit);
  color: var(--poussiere);
  font-family: var(--mono);
  font-size: .6875rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: color var(--transition), background var(--transition);
}
.position-mode__bouton:hover { color: var(--sel); }
.position-mode__bouton[aria-pressed="true"] { background: var(--soufre); color: var(--sur-accent); }
```

- [ ] **Step 2: Menu en barre horizontale sous 40rem**

Dans le bloc `@media (max-width: 40rem)` déjà présent (autour de la ligne 1363, celui qui règle les flèches de la visionneuse), ajouter à la suite :

```css
  .admin-mise-en-page { flex-direction: column; gap: 1rem; }
  .admin-nav {
    flex-direction: row;
    gap: 0;
    position: static;
    border-bottom: 1px solid var(--nuit-3);
  }
  .admin-nav__bouton {
    flex: 1 1 0;
    border-left: 0;
    border-bottom: 2px solid transparent;
    text-align: center;
  }
  .admin-nav__bouton[aria-pressed="true"] { border-left-color: transparent; border-bottom-color: var(--soufre); }
```

- [ ] **Step 3: Vérification visuelle**

Ces classes n'ont pas encore de HTML à styler (Task 5 les pose) : rien à vérifier à l'écran ici. Vérifier seulement que le fichier reste un CSS valide.

Run: `cd "$(git rev-parse --show-toplevel)" && node -e "require('fs').readFileSync('css/style.css','utf8')" && python3 -c "print('lecture ok')"`
Expected: `lecture ok` (aucune erreur de lecture — un vrai lint CSS n'existe pas dans ce dépôt ; la vérification visuelle réelle vient avec la Task 5).

- [ ] **Step 4: Commit**

```bash
git add css/style.css
git commit -m "Styles du menu d'administration et du choix de mode"
```

---

## Task 5: L'admin a deux modules, et le mode automatique

**Files:**
- Modify: `js/admin.js` (réécriture complète, 258 lignes actuelles)

**Interfaces:**
- Consumes: `chargerConfig, listerTout, supprimerContribution, lireReglagesPosition, ecrirePosition, ErreurService` de `js/souvenirs.js` (Task 3) ; `gabaritGalerie, brancherVisionneuse` de `js/souvenirs-vue.js` (inchangés) ; classes CSS de la Task 4.

- [ ] **Step 1: Réécrire `js/admin.js` en entier**

```js
/* Page de modération : liste tout, permet de supprimer n'importe quelle
   entrée, et pilote où en sont les motos.

   Deux modules, un menu à gauche pour passer de l'un à l'autre — même
   principe que les onglets Étape/Souvenirs du site public, transposé à
   l'admin.

   Le mot de passe d'administration est distinct de celui du groupe et n'est
   gardé que pour la durée de l'onglet — sessionStorage, jamais localStorage,
   et jamais écrit dans le dépôt. */

import {
  chargerConfig, listerTout, supprimerContribution,
  lireReglagesPosition, ecrirePosition, ErreurService,
} from './souvenirs.js';
import { gabaritGalerie, brancherVisionneuse } from './souvenirs-vue.js';

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const racine = document.getElementById('admin');
let motDePasse = sessionStorage.getItem('souvenirs.admin') || '';

// Quel module afficher : « position » par défaut, le geste le plus courant
// une fois le voyage commencé.
let ongletAdmin = 'position';

// Journée choisie dans le menu de modération ; `null` signifie « toutes ».
// Gardée hors de `afficher()`, qui redessine tout après chaque suppression :
// sans cela, on serait renvoyé à la liste complète juste après avoir
// supprimé, et il faudrait retrouver sa journée à chaque fois.
let jourChoisi = null;

// Où en sont les motos, telle que le service la donne — mode compris. Relue
// à chaque affichage : cette page peut être ouverte sur deux téléphones à la
// fois, et c'est la valeur du service qui fait foi, jamais celle gardée ici.
let position = { jour: null, majLe: null, mode: null, depart: null, decalage: 0 };

// Bascule Manuel/Automatique choisie à l'écran, tant qu'elle n'a pas encore
// été enregistrée — passer sur « Automatique » n'écrit rien tant qu'aucune
// date n'est posée (voir plus bas). `null` : suivre `position.mode` tel
// quel. Remise à zéro à chaque rendu complet : un mode Automatique choisi
// puis abandonné sans date ne doit pas survivre à un changement de module.
let modeAffiche = null;

/** Titres des étapes, pour nommer les journées des deux menus. */
let titresEtapes = new Map();

async function chargerTitres() {
  try {
    const donnees = await fetch('data/etapes.json').then((r) => r.json());
    for (const etape of donnees.etapes || []) titresEtapes.set(etape.jour, etape.titre);
  } catch {
    titresEtapes = new Map();
  }
}

const dateLisible = (iso) => new Date(iso).toLocaleDateString('fr-FR', {
  day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});

/** Menu des journées du module Modération, avec le nombre de contributions
    de chacune.

    Toutes les journées du voyage y figurent, y compris celles restées
    vides : en modération, savoir qu'un jour n'a rien reçu est une
    information, pas un trou à masquer. */
function gabaritMenuModeration(contributions) {
  const parJour = new Map();
  for (const c of contributions) parJour.set(c.jour, (parJour.get(c.jour) || 0) + 1);

  const jours = [...new Set([...titresEtapes.keys(), ...parJour.keys()])].sort((a, b) => a - b);

  const options = jours.map((jour) => {
    const nombre = parJour.get(jour) || 0;
    const titre = titresEtapes.get(jour);
    const libelle = titre ? `J${jour} · ${titre}` : `J${jour}`;
    const choisie = jourChoisi === jour ? ' selected' : '';
    return `<option value="${jour}"${choisie}>${echapper(libelle)} — ${nombre}</option>`;
  }).join('');

  return `<p class="admin-filtre">
    <label for="filtre-jour">Journée</label>
    <select id="filtre-jour" class="admin-filtre__menu">
      <option value=""${jourChoisi === null ? ' selected' : ''}>Toutes les journées — ${contributions.length}</option>
      ${options}
    </select>
  </p>`;
}

/** Menu de journée du mode manuel. */
function gabaritJourManuel() {
  const jours = [...titresEtapes.keys()].sort((a, b) => a - b);
  const valeurCourante = position.mode === 'manuel' ? position.jour : null;
  const options = jours.map((jour) => {
    const titre = titresEtapes.get(jour);
    const libelle = titre ? `J${jour} · ${titre}` : `J${jour}`;
    return `<option value="${jour}"${valeurCourante === jour ? ' selected' : ''}>${echapper(libelle)}</option>`;
  }).join('');

  return `<p class="admin-filtre">
    <label for="position-jour">Journée</label>
    <select id="position-jour" class="admin-filtre__menu">
      <option value=""${valeurCourante === null ? ' selected' : ''}>Pas encore partis</option>
      ${options}
    </select>
  </p>`;
}

/** Date de départ et décalage du mode automatique.

    Pas de valeur inventée pour la date : tant qu'elle est vide, rien ne
    s'enregistre — voir le gestionnaire de `change` plus bas. */
function gabaritAuto() {
  const depart = position.mode === 'auto' ? (position.depart || '') : '';
  const decalage = position.mode === 'auto' ? position.decalage : 0;

  return `<p class="admin-filtre">
      <label for="position-depart">Date de départ</label>
      <input type="date" id="position-depart" class="admin-filtre__menu" value="${echapper(depart)}">
    </p>
    <p class="admin-filtre">
      <label for="position-decalage">Avance/retard, en jours</label>
      <input type="number" id="position-decalage" class="admin-filtre__menu"
             value="${decalage}" step="1" min="-30" max="30">
    </p>`;
}

/** Module « Où en sont les motos » : Manuel/Automatique en tête, puis le
    formulaire du mode affiché — celui tout juste choisi s'il y en a un,
    sinon celui que le service donne. Toujours sans bouton : chaque champ
    s'enregistre à son propre changement, et la note en bas tient lieu de
    confirmation. */
function gabaritModulePosition() {
  const mode = modeAffiche ?? position.mode ?? 'manuel';

  const note = position.majLe === null
    ? 'Aucune position indiquée : les motos attendent à Salta.'
    : position.jour === null
      ? `Pas encore partis d'après ce réglage : les motos attendent à Salta. (réglé le ${dateLisible(position.majLe)})`
      : `Mis à jour le ${dateLisible(position.majLe)}`;

  return `<div class="position-mode" role="group" aria-label="Mode de position">
      <button type="button" class="position-mode__bouton" data-mode-affiche="manuel"
              aria-pressed="${mode === 'manuel'}">Manuel</button>
      <button type="button" class="position-mode__bouton" data-mode-affiche="auto"
              aria-pressed="${mode === 'auto'}">Automatique</button>
    </div>
    ${mode === 'manuel' ? gabaritJourManuel() : gabaritAuto()}
    <p class="admin-position__note" id="position-note">${echapper(note)}</p>`;
}

/* Tout ce qui vient d'une contribution est de la donnée non modérée : auteur,
   texte et jusqu'à la clé du média passent par `echapper`, y compris en
   position d'attribut ou d'URL — c'est cette page qui en a le plus besoin,
   puisqu'elle affiche justement ce que la modération n'a pas encore vu. */
function gabaritContribution(contribution) {
  // Tous les fichiers, pas seulement le premier : supprimer une contribution
  // emporte tout ce qu'elle porte. `media` au singulier reste le repli pour
  // un service pas encore redéployé.
  const medias = contribution.medias?.length
    ? contribution.medias
    : (contribution.media ? [contribution.media] : []);
  const apercu = gabaritGalerie(medias);
  return `<article class="souvenir" data-id="${echapper(contribution.id)}">
    <p class="souvenir__entete">
      <b>${echapper(contribution.auteur)}</b>
      <time>J${echapper(contribution.jour)} · ${echapper(new Date(contribution.creeLe).toLocaleString('fr-FR'))}</time>
    </p>
    ${apercu}
    ${contribution.texte ? `<p class="souvenir__texte">${echapper(contribution.texte)}</p>` : ''}
    <p class="souvenir__actions"><button type="button" data-action="supprimer">Supprimer</button></p>
  </article>`;
}

/** Module Modération : le menu de journée, puis la liste filtrée.

    Bâti sur la liste ENTIÈRE, filtré ensuite : les décomptes des autres
    journées doivent rester visibles même quand on n'en regarde qu'une. */
function gabaritModuleModeration(contributions) {
  const menu = gabaritMenuModeration(contributions);
  const visibles = jourChoisi === null
    ? contributions
    : contributions.filter((c) => c.jour === jourChoisi);

  const corps = visibles.length
    ? `<p class="sous-titre">${visibles.length} contribution(s)</p>${visibles.map(gabaritContribution).join('')}`
    : `<p class="souvenirs__vide">${
        jourChoisi === null
          ? 'Aucune contribution pour le moment.'
          : `Aucune contribution pour la journée ${jourChoisi}.`
      }</p>`;

  return menu + corps;
}

function gabaritNav() {
  const entree = (cle, libelle) => `<button type="button" class="admin-nav__bouton"
    data-onglet-admin="${cle}" aria-pressed="${ongletAdmin === cle}">${libelle}</button>`;
  return `<nav class="admin-nav" aria-label="Modules de l'administration">
    ${entree('position', 'Où en sont les motos')}
    ${entree('souvenirs', 'Modération')}
  </nav>`;
}

function demander(messageSouci) {
  racine.innerHTML = `<form class="souvenir-form" style="max-width:22rem">
    <input class="souvenir-form__champ" type="password" name="motDePasse"
           placeholder="Mot de passe de modération" required>
    <p class="souvenir-form__pied"><button type="submit">Ouvrir</button></p>
    <p class="souvenir-form__souci" ${messageSouci ? '' : 'hidden'}>${echapper(messageSouci)}</p>
  </form>`;
  const formulaire = racine.querySelector('form');
  formulaire.addEventListener('submit', (evenement) => {
    evenement.preventDefault();
    motDePasse = new FormData(formulaire).get('motDePasse');
    sessionStorage.setItem('souvenirs.admin', motDePasse);
    afficher();
  });
}

async function afficher() {
  racine.innerHTML = '<p class="souvenirs__vide">Chargement…</p>';
  let contributions;
  try {
    contributions = await listerTout(motDePasse);
  } catch (souci) {
    sessionStorage.removeItem('souvenirs.admin');
    motDePasse = '';
    // Le service distingue mot de passe faux (401) et suppression non
    // autorisée (403) ; dans les deux cas son message est déjà juste et en
    // français, on l'affiche tel quel plutôt que d'en inventer un.
    demander(souci instanceof ErreurService ? souci.message : 'Le service ne répond pas.');
    return;
  }

  // La position ne conditionne pas l'accès à la page : si sa lecture échoue,
  // on garde la dernière connue plutôt que de refuser d'afficher la page.
  position = await lireReglagesPosition().catch(() => position);
  modeAffiche = null; // un rendu complet oublie un mode choisi mais pas enregistré

  const module = ongletAdmin === 'position'
    ? gabaritModulePosition()
    : gabaritModuleModeration(contributions);

  racine.innerHTML = `<div class="admin-mise-en-page">
    ${gabaritNav()}
    <div class="admin-contenu">${module}</div>
  </div>`;
}

/** Enregistre un réglage de position et rafraîchit seulement la note et le
    formulaire — un rendu complet ferait remonter la page en haut et
    perdrait, dans le module Modération, la journée en cours d'examen. */
async function enregistrerPosition(reglage) {
  const note = racine.querySelector('#position-note');
  if (note) note.textContent = 'Enregistrement…';
  try {
    position = await ecrirePosition({ ...reglage, motDePasse });
    modeAffiche = null;
    const contenu = racine.querySelector('.admin-contenu');
    if (contenu) contenu.innerHTML = gabaritModulePosition();
  } catch (souci) {
    if (note) {
      note.textContent = souci instanceof ErreurService
        ? souci.message
        : 'Le service ne répond pas : la position n\'a pas été enregistrée.';
    }
  }
}

// Écouteur posé une seule fois, en dehors de `afficher()`, sur `racine` — un
// conteneur stable dont seul le contenu change à chaque rendu. La
// délégation d'événement est donc suffisante : pas besoin de reposer
// l'écouteur après chaque suppression ou changement de module.
racine.addEventListener('click', async (evenement) => {
  const boutonNav = evenement.target.closest('[data-onglet-admin]');
  if (boutonNav) {
    ongletAdmin = boutonNav.dataset.ongletAdmin;
    afficher();
    return;
  }

  const boutonMode = evenement.target.closest('[data-mode-affiche]');
  if (boutonMode) {
    const nouveauMode = boutonMode.dataset.modeAffiche;
    if (nouveauMode === 'manuel') {
      // Un point de départ raisonnable plutôt qu'un menu vide : la journée
      // que l'automatique montre déjà, ou J1 si les motos n'étaient encore
      // nulle part.
      await enregistrerPosition({ mode: 'manuel', jour: position.jour ?? 1 });
    } else {
      // Rien à enregistrer avant qu'une date ne soit choisie : on affiche
      // juste le formulaire, vide.
      modeAffiche = 'auto';
      const contenu = racine.querySelector('.admin-contenu');
      if (contenu) contenu.innerHTML = gabaritModulePosition();
    }
    return;
  }

  const boutonSupprimer = evenement.target.closest('button[data-action="supprimer"]');
  if (boutonSupprimer) {
    const id = boutonSupprimer.closest('[data-id]').dataset.id;
    if (!confirm('Supprimer définitivement cette contribution ?')) return;
    try {
      await supprimerContribution({ id, motDePasse });
    } catch (souci) {
      alert(souci instanceof ErreurService ? souci.message : 'Le service ne répond pas, réessayez plus tard.');
      return;
    }
    afficher();
  }
});

racine.addEventListener('change', async (evenement) => {
  if (evenement.target.matches('#filtre-jour')) {
    const valeur = evenement.target.value;
    jourChoisi = valeur === '' ? null : Number(valeur);
    afficher();
    return;
  }

  if (evenement.target.matches('#position-jour')) {
    const valeur = evenement.target.value;
    const jour = valeur === '' ? null : Number(valeur);
    await enregistrerPosition(jour === null ? { mode: null } : { mode: 'manuel', jour });
    return;
  }

  if (evenement.target.matches('#position-depart, #position-decalage')) {
    const depart = racine.querySelector('#position-depart').value;
    if (!depart) return; // pas de date : rien à enregistrer
    const decalageBrut = racine.querySelector('#position-decalage').value;
    const decalage = decalageBrut === '' ? 0 : Number(decalageBrut);
    await enregistrerPosition({ mode: 'auto', depart, decalage });
  }
});

// Un fichier s'ouvre en grand ici comme sur le site : voir une photo en
// entier avant de décider de la supprimer est le geste même de la
// modération.
brancherVisionneuse(racine);

await chargerConfig();
await chargerTitres();
if (motDePasse) afficher(); else demander();
```

- [ ] **Step 2: Vérification manuelle — modération, sans régression**

Terminal 1 : `cd worker && npx wrangler dev --local --port 8787`
Terminal 2 : `python3 -m http.server 8123` (à la racine du dépôt)

Dans le navigateur, `http://localhost:8123/admin.html` :
1. Ouvrir avec le mot de passe de modération.
2. Le module « Où en sont les motos » s'affiche par défaut, le menu à gauche marque cette entrée.
3. Cliquer « Modération » : la liste et le filtre de journée déjà connus apparaissent, identiques à avant cette tâche.
4. Poster un souvenir de test depuis `index.html`, vérifier qu'il apparaît en Modération, le supprimer, vérifier qu'il disparaît.

Expected : comportement de modération identique à avant Task 5, seulement déplacé sous son entrée de menu.

- [ ] **Step 3: Vérification manuelle — mode manuel**

Dans le module « Où en sont les motos » :
1. « Manuel » est actif par défaut. Choisir « J7 » dans le menu.
2. La note passe à « Enregistrement… » puis « Mis à jour le [date] ».
3. Ouvrir `index.html` dans un autre onglet : le repère est sur J7, carte et frise.
4. Choisir « Pas encore partis » : la note dit « Aucune position indiquée… », et sur `index.html` (recharger), le repère revient à Salta.

- [ ] **Step 4: Vérification manuelle — mode automatique**

1. Cliquer « Automatique » : le formulaire Date de départ / Avance-retard apparaît, vide. La note ne change pas encore — rien n'a été envoyé.
2. Poser la date du jour, laisser le décalage à 0.
3. La note passe à « Enregistrement… » puis « Mis à jour le [date] ».
4. Sur `index.html` (recharger) : le repère est sur J1.
5. Revenir dans l'admin, mettre le décalage à 2 : la note se réenregistre, `index.html` rechargé montre J3.
6. Cliquer « Manuel » : le menu de journée s'affiche pré-rempli sur J3 (la valeur automatique du moment), et s'enregistre en mode manuel.
7. Recliquer « Automatique » : la date de départ posée à l'étape 2 est toujours là.

- [ ] **Step 5: Vérification manuelle — téléphone**

Réduire la fenêtre du navigateur sous 40rem (~640px) de large, ou ouvrir les outils de développement en mode responsive. Le menu à gauche passe en barre horizontale sous l'entête ; les deux entrées restent cliquables et lisibles.

- [ ] **Step 6: Commit**

```bash
git add js/admin.js
git commit -m "Menu à gauche dans l'admin, mode automatique pour la position"
```

---

## Task 6: Vérification finale, README

**Files:**
- Modify: `README.md` (section « Souvenirs des compagnons », le paragraphe sur la modération)

**Interfaces:** aucune — tâche de vérification et de documentation.

- [ ] **Step 1: Relire le paragraphe existant sur la modération**

Dans `README.md`, chercher `**Modération**` (section « Souvenirs des compagnons »). Le paragraphe actuel dit :

> **Modération** : la page `admin.html` […] Elle permet de supprimer n'importe quelle contribution, et porte un menu pour n'afficher qu'une journée à la fois. […]

- [ ] **Step 2: Ajouter un paragraphe sur les deux modules et la position automatique**

Juste après ce paragraphe, ajouter :

```markdown
La page a deux modules, choisis depuis un menu à gauche (en haut sur
téléphone) : la modération elle-même, et « Où en sont les motos ». Ce second
module pose la position affichée sur la carte et la frise du site, en
manuel (une journée choisie à la main) ou en automatique (une date de
départ, et le site avance tout seul de J1 à J15 — un décalage en jours
corrige un retard ou une avance sans changer de mode). Le changement de
journée automatique se fait à minuit heure de Paris.
```

- [ ] **Step 3: Lancer toute la suite de tests une dernière fois**

Run: `cd worker && npm test`
Expected: PASS — tous les tests, anciens et nouveaux.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Documente les modules d'administration et la position automatique"
```
