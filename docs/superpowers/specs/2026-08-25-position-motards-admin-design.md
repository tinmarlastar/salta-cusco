# Position des motards en automatique, et modules d'administration

Design validé le 25 août 2026.

## Le besoin

La modération (`admin.html`) mélange aujourd'hui deux choses sans rapport sur
un seul écran : le menu « Où en sont les motos » en tête de page, et la liste
des contributions à modérer en dessous. Deux demandes :

1. **Un menu à gauche** pour naviguer entre ces deux modules, plutôt qu'une
   page qui les empile.
2. **Un mode automatique** pour la position des motos : donner une date de
   départ, et laisser le site avancer tout seul de J1 à J15 au fil des jours,
   plutôt que de choisir la journée à la main chaque soir.

Le mode manuel existe déjà (commit `edfdcc4`) : un menu de journée dans la
modération, une table clé/valeur `reglages` côté worker, `GET`/`PUT
/api/position`. Ce design l'étend, il ne le refait pas.

## Ce qui ne change pas

Le site public (`js/app.js`, `js/carte.js`, `js/profil.js`) lit
`GET /api/position` et affiche le repère à partir de `{ jour, majLe }`. Cette
forme ne change pas : le mode automatique est calculé **dans le worker**, à
chaque lecture. Le site public n'a donc aucune idée qu'un mode existe — il
continue de recevoir une journée toute faite, exactement comme aujourd'hui.
Zéro changement sur ces trois fichiers, ni sur `index.html`.

C'était le choix à faire ici : calculer côté site aurait touché du code qui
fonctionne déjà et fait dépendre l'affichage de l'horloge de chaque visiteur.
Un Cron Worker qui écrirait la position chaque nuit a aussi été écarté :
ça ajoute un déclencheur planifié à déployer et surveiller, pour un calcul qui
ne coûte rien à refaire à chaque lecture — quelques millisecondes contre un
étage d'infrastructure en plus.

## Modèle de données

Toujours la table `reglages` (`cle`, `valeur`, `maj_le`), sans migration —
elle est clé/valeur depuis le début justement pour ça. Quatre clés au lieu
d'une :

| clé | valeur | rôle |
|---|---|---|
| `position_mode` | `manuel` \| `auto` | quel calcul appliquer |
| `position_jour` | `"1"`…`"15"` | la journée, en mode manuel (déjà existant) |
| `position_depart` | `"2026-09-01"` | date de départ, en mode auto |
| `position_decalage` | `"-3"`…`"3"` (entier signé) | avance/retard en jours, en mode auto |

**Rétrocompatibilité** : les données déjà en base n'ont que `position_jour`,
`position_mode` n'existe pas encore. Un mode absent avec un `position_jour`
présent se lit comme `manuel` — aucune migration à écrire, aucune coupure de
service au déploiement.

Une écriture pose toutes les clés du mode choisi dans la même requête, avec
le même `maj_le` ; les clés de l'autre mode ne sont pas effacées (passer en
manuel puis revenir en auto retrouve la date de départ posée avant, sans la
ressaisir).

## Calcul de la position automatique

Dans le worker, à chaque `GET /api/position` :

```
mode = reglages.position_mode ?? (reglages.position_jour existe ? 'manuel' : null)

si mode === 'manuel' :
    jour = reglages.position_jour (ou null si absent)

si mode === 'auto' :
    depart      = reglages.position_depart
    decalage    = reglages.position_decalage ?? 0
    aujourdhui  = date du jour à Paris (Europe/Paris, DST géré par Intl)
    ecoules     = aujourdhui − depart, en jours entiers
    calcule     = ecoules + 1 + decalage

    si calcule < 1  : jour = null   // pas encore partis, comme aujourd'hui
    si calcule > 15 : jour = 15     // le voyage est fini, les motos restent à Cusco
    sinon           : jour = calcule
```

Heure de Paris plutôt qu'un fuseau du parcours : le voyage traverse
l'Argentine (UTC-3), le Chili, la Bolivie (UTC-4) et le Pérou (UTC-5) — aucun
fuseau du tracé n'est plus « juste » qu'un autre pour dire quand on change de
journée, et Paris est le fuseau de Martin et des proches qui suivent le
voyage. `Intl.DateTimeFormat` avec `timeZone: 'Europe/Paris'` calcule la date
du jour sans bibliothèque, heure d'été comprise.

`majLe` reste la date de la dernière écriture des réglages, comme aujourd'hui
— pas recalculé à chaque lecture. En mode auto, il dit donc quand la date de
départ ou le décalage a été posé, pas que la position vient d'être vérifiée
à l'instant ; c'est la même sémantique qu'en manuel, où `majLe` dit quand la
journée a été choisie.

## API du worker

`GET /api/position` — inchangée : aucune autorisation, même forme de réponse
`{ jour, majLe }`.

`PUT /api/position` — toujours le mot de passe d'administration, payload
étendu :

```json
{ "mode": "manuel", "jour": 7 }
{ "mode": "auto", "depart": "2026-09-01", "decalage": 0 }
{ "mode": null }
```

Validations :

- `mode: "manuel"` — `jour` entier entre 1 et 15 (règle déjà en place).
- `mode: "auto"` — `depart` une date ISO (`AAAA-MM-JJ`) valide ; `decalage`
  entier, borné à ±30 (assez large pour tout retard raisonnable, assez
  strict pour rejeter une saisie absurde).
- `mode: null` — efface `position_mode`, `position_jour`, `position_depart`
  et `position_decalage` : retour à « pas encore partis », l'état d'origine.
- Tout payload qui ne correspond à aucune de ces trois formes : `400`.

La réponse de `PUT` est la même chose qu'un `GET` fraîchement recalculé —
`{ jour, majLe }` — pour que l'admin voie tout de suite l'effet de son
changement, comme aujourd'hui.

## Interface d'administration

### Le menu à gauche

Deux entrées, un module affiché à la fois — même principe que les onglets
Étape/Souvenirs du panneau public, transposé à l'admin :

- **Où en sont les motos**
- **Modération**

`admin.html` ne change pas : `js/admin.js` possède déjà tout `#admin`, le
menu et les deux modules sont son affaire, pas celle du HTML statique. Un
état `ongletAdmin` (`'position'` par défaut — c'est le geste le plus courant
une fois le voyage commencé) commande lequel des deux gabarits `afficher()`
dessine.

Sur téléphone, le menu passe en barre horizontale sous l'entête plutôt qu'en
colonne — le patron déjà en place pour les onglets Étape/Souvenirs, repris
tel quel.

### Le module « Où en sont les motos »

Un choix Manuel/Automatique en tête (deux boutons, celui du mode actif
marqué), puis :

- **Manuel** : le menu de journée déjà existant, inchangé. Choisir une
  journée l'enregistre tout de suite, sans bouton — le geste déjà en place.
- **Automatique** : un champ date (« Date de départ ») et un champ nombre
  (« Avance/retard, en jours ») — vide/zéro par défaut. Les deux s'enregistrent
  ensemble, au changement, dès qu'une date de départ est renseignée ; tant
  qu'elle est vide, rien n'est envoyé — pas de mode auto à moitié posé.

Dans les deux modes, une ligne affiche la journée effective du moment et la
date de dernière mise à jour — exactement la note déjà là aujourd'hui
(`Mis à jour le …` / `Aucune position indiquée`), relue après chaque
changement.

Changer de mode n'efface pas les réglages de l'autre : repasser de auto à
manuel puis à nouveau à auto retrouve la date de départ posée avant.

### Le module « Modération »

Reprise à l'identique du contenu actuel sous la position : le menu de
journée pour filtrer, la liste des contributions, le bouton Supprimer. Rien
ne change dans son comportement, seulement son emplacement — un gabarit à
part plutôt que la suite de la même page.

## Vérification

Reprend la pratique déjà en place dans `worker/test/` (tests des fonctions
d'autorisation et de la file d'attente) :

1. **Calcul automatique** : date de départ dans le futur → `null` ; jour du
   départ → J1 ; en cours de voyage → le bon jour ; après J15 → plafonné à 15 ;
   décalage positif et négatif appliqué correctement.
2. **Rétrocompatibilité** : une ligne `position_jour` sans `position_mode`
   en base se lit comme mode manuel.
3. **Écriture** : `PUT` avec un payload qui ne correspond à aucun des trois
   formats est rejeté (400) ; `mode: null` efface bien les quatre clés ;
   changer de mode conserve les réglages de l'autre mode.
4. **Manuel, sans régression** : le comportement déjà testé aujourd'hui
   (mot de passe requis, journée entre 1 et 15, effacement) continue de
   passer tel quel.
5. **Manuel côté admin** : ouvrir la modération, basculer entre les deux
   modules, vérifier que le menu de journée de la modération garde son état
   propre (indépendant du module position).
6. **Site public** : `GET /api/position` renvoie bien `{ jour, majLe }` dans
   les deux modes ; le repère sur la carte et la frise n'a besoin d'aucune
   modification pour en tenir compte.

## Hors périmètre

Retiré volontairement :

- notification quand le mode automatique fait changer de journée ;
- historique des positions passées (seule la position courante est gardée,
  comme aujourd'hui) ;
- prise en compte du fuseau réel du tracé plutôt que celui de Paris ;
- mode automatique calé sur autre chose qu'une date de départ fixe (pas de
  jours de repos configurables individuellement — un décalage manuel suffit
  à absorber un imprévu).
