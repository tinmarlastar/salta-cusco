# Souvenirs des compagnons — notes et médias postés par les participants

Design validé le 20 août 2026.

## Le besoin

Pendant le raid Salta → Cusco, les participants veulent laisser des notes et
poster des photos ou vidéos sur chaque étape, **en direct depuis le terrain**.

Deux contraintes dominent tout le reste :

1. **Le réseau est capricieux** — haute altitude, Sud Lipez, salar, zones sans
   couverture. Un envoi qui échoue ne doit jamais faire perdre le contenu.
2. **Aucun compte à créer** — les compagnons ne doivent pas s'inscrire quelque
   part pour participer. Un prénom et un mot de passe de groupe suffisent.

Le site actuel est strictement statique (GitHub Pages, aucun backend). Ce
sous-système est le premier à introduire de l'état partagé.

## Architecture

Un service Cloudflare fait l'intermédiaire entre le site statique et le
stockage. Le site reste statique : seul le bloc « souvenirs » appelle le
service.

```
Navigateur (site GitHub Pages)
   │  fetch()
   ▼
Worker Cloudflare  ──────►  R2   (photos et vidéos, fichiers bruts)
                   ──────►  KV   (notes texte et métadonnées des médias)
```

**Pourquoi Cloudflare plutôt que Supabase ou Firebase** : R2 ne facture jamais
la bande passante de lecture. Des vidéos revisionnées par le groupe pendant des
mois après le voyage ne coûtent rien et ne peuvent pas épuiser un quota. Les
paliers gratuits de Supabase (~2 Go/mois de lecture) et Firebase sont plus
serrés sur ce point précis, avec le risque que des médias cassent en plein
voyage.

### Découpage des unités

| Unité | Rôle | Dépend de |
|---|---|---|
| `worker/index.js` | routes HTTP, autorisations | R2, KV |
| `js/souvenirs.js` | appels au service, file d'attente locale | rien du site |
| `js/souvenirs-vue.js` | rendu du bloc et du formulaire | `souvenirs.js` |
| `js/app.js` | branche le bloc dans le panneau d'étape | `souvenirs-vue.js` |

Le module d'accès au service ne connaît pas le DOM ; le module de vue ne connaît
pas le réseau. Chacun est lisible et testable séparément.

## Modèle de données

**KV** — une clé par contribution : `etape:<jour>:<id>`

```json
{
  "id": "01J8X...",
  "jour": 7,
  "auteur": "Martin",
  "type": "note" | "media",
  "texte": "…",
  "media": { "cle": "medias/7/01J8X.jpg", "genre": "image" | "video", "octets": 284910 },
  "creeLe": "2026-09-14T18:22:41.000Z",
  "modifieLe": null,
  "jetonHache": "sha256:…"
}
```

L'identifiant est un ULID : trié chronologiquement, ce qui permet de lister une
étape dans l'ordre sans trier après coup.

**R2** — les fichiers bruts sous `medias/<jour>/<id>.<ext>`.

## Autorisations

Trois niveaux, volontairement légers — c'est un groupe d'amis, pas un service
public.

- **Poster** : mot de passe de groupe, transmis de vive voix avant le départ.
  Demandé une fois par appareil, puis mémorisé.
- **Modifier ou supprimer sa propre contribution** : à la création, le service
  génère un jeton secret et le renvoie **une seule fois, au créateur**. Il n'est
  jamais présent dans la liste publique. Le navigateur le conserve ; tant qu'il
  l'a, les boutons « Modifier » et « Supprimer » apparaissent sur les
  contributions de cet appareil uniquement.
- **Tout supprimer** : mot de passe d'administration, distinct du mot de passe
  de groupe, connu de Martin seul. Page `#admin`.

Côté KV on ne stocke que le **hachage** du jeton : quelqu'un qui lirait la base
ne pourrait pas se faire passer pour un auteur.

Un média peut porter une légende : elle se modifie comme une note. Seul le
fichier lui-même n'est pas remplaçable — pour changer une photo, on supprime et
on repose.

**Compromis assumé** : le droit de modifier est lié à l'appareil, pas à un
compte. Changer de téléphone ou vider son navigateur fait perdre la main sur ses
anciens posts. La modération, elle, reste toujours valable sur tout.

Les mots de passe sont comparés en temps constant, et ne sont jamais écrits dans
les journaux.

## Routes du service

| Méthode | Chemin | Autorisation | Effet |
|---|---|---|---|
| `GET` | `/api/etape/:jour` | aucune | liste les contributions, **sans** les jetons |
| `POST` | `/api/etape/:jour` | mot de passe de groupe | crée une note ; renvoie le jeton |
| `POST` | `/api/etape/:jour/media` | mot de passe de groupe | crée un média ; renvoie le jeton |
| `PATCH` | `/api/contribution/:id` | jeton de l'entrée | modifie le texte (note ou légende de média) |
| `DELETE` | `/api/contribution/:id` | jeton **ou** mot de passe admin | supprime l'entrée et son fichier R2 |
| `GET` | `/media/:cle` | aucune | sert le fichier depuis R2 |

CORS restreint à l'origine du site publié et à `localhost` pour le
développement.

## Ce que vit un participant

**Première fois** : prénom et mot de passe de groupe, puis mémorisés.

**Note** : champ texte sous le récit, 2000 caractères maximum.

**Photo** : redimensionnée et recompressée **par le navigateur avant l'envoi**
(1600 px de large, JPEG qualité 82). Un cliché de 4-8 Mo tombe à quelques
centaines de Ko : envoi plus rapide en altitude, chargement plus rapide pour les
autres, quota préservé.

**Vidéo** : pas de recompression navigateur, trop lourd. Plafond de **60 Mo**
vérifié avant l'envoi, avec un message qui dit quoi faire (raccourcir le clip,
baisser la qualité) plutôt qu'un envoi qui échoue à mi-parcours.

**HEIC** : la sélection de fichier convertit généralement en JPEG sur iPhone. Si
un HEIC brut passe malgré tout, on l'envoie tel quel — mieux vaut un fichier que
certains navigateurs afficheront mal qu'un souvenir perdu.

### La file d'attente locale

C'est la réponse au réseau capricieux, et la partie la plus importante.

Un envoi qui échoue est conservé dans IndexedDB (les fichiers binaires y tiennent
tels quels, contrairement à `localStorage`) avec un statut « en attente d'envoi »
visible dans l'interface. Il est renvoyé automatiquement :

- au retour de la connexion (événement `online`) ;
- quand l'onglet redevient visible ;
- toutes les deux minutes tant que l'onglet reste ouvert.

Les tentatives sont **espacées progressivement** (2 s, 4 s, 8 s… plafonnées à
5 min) pour ne pas vider la batterie en zone blanche. Chaque envoi porte une clé
d'idempotence : un renvoi après une réponse perdue en route ne crée pas de
doublon. Rien ne se perd, personne ne retape son message.

## Rendu dans le site

Un bloc « Souvenirs des compagnons » sous le récit de chaque étape, dans le
style déjà établi (mêmes variables CSS, même typographie). Chaque contribution
affiche l'auteur, la date, le texte ou le média, et — pour ses propres posts —
les boutons « Modifier » et « Supprimer ».

Les médias sont en `loading="lazy"`, les vidéos en `preload="metadata"` : on ne
télécharge pas des dizaines de mégaoctets de vidéo à l'ouverture d'une étape.

Si le service est injoignable, le bloc affiche un message sobre et **le reste du
site continue de fonctionner normalement** — la carte, les profils et les fiches
ne dépendent en rien du Worker.

## Hors périmètre

Retiré volontairement pour rester simple et robuste :

- comptes utilisateurs ;
- limitation anti-abus au-delà du mot de passe (pas de blocage par IP) ;
- remplacement du fichier d'un média (supprimer et reposter) ;
- vignettes générées pour les vidéos (le navigateur affiche déjà la première image) ;
- notifications ;
- mise à jour en direct sans rechargement.

## Déploiement

Une fois : créer un compte Cloudflare (gratuit, sans carte bancaire à ce niveau
d'usage), créer le bucket R2 et l'espace KV, puis `wrangler deploy`. Les deux
mots de passe sont posés comme secrets Cloudflare — **jamais dans le dépôt**.

L'adresse du Worker est écrite dans `data/config.json`, à côté des autres
données du site, pour qu'elle se change sans toucher au code.

## Vérification

Il n'y a pas de framework de test dans ce projet ; la vérification est manuelle
et suit la pratique en place :

1. `wrangler dev` en local, site servi par `python3 -m http.server`.
2. Poster une note, une photo, une vidéo. Vérifier l'apparition après rechargement.
3. Modifier puis supprimer sa propre note ; vérifier qu'un autre navigateur ne
   voit **pas** ces boutons sur la même note.
4. Couper le réseau (mode avion), poster : vérifier le statut « en attente ».
   Rétablir : vérifier le renvoi automatique et l'absence de doublon.
5. Vérifier qu'un mauvais mot de passe est refusé, et que `#admin` supprime
   n'importe quelle entrée.
6. Vérifier que le site reste utilisable Worker éteint.
