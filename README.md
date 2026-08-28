# Aventure des 4 Nations — Salta → Cusco

Carte interactive du raid moto Vintage Rides de Salta (Argentine) à Cusco (Pérou) :
3 036 km dont 875 km de piste, quatre pays andins, quinze jours.

Le site tient en trois écrans : une carte qui porte tout le parcours, une fiche
par jour, et une frise en tête de page qui est en réalité le profil d'altitude
du voyage entier — les quinze jours y sont posés sur la silhouette réelle du
trajet.

## Le faire tourner chez soi

Le site a besoin d'être servi par un serveur web : ouvrir `index.html` en
double-cliquant ne fonctionne pas, parce que le navigateur refuse alors de
charger les données du parcours.

```bash
python3 -m http.server 8123
```

Puis ouvrir <http://localhost:8123>.

## Le publier

Le dépôt est prêt pour GitHub Pages, sans étape de compilation.

1. Créer un dépôt GitHub et y envoyer ce dossier.
2. Dans **Settings → Pages**, choisir la source **GitHub Actions**.
3. Chaque envoi sur `main` republie le site ; l'adresse apparaît à la fin du
   workflow, sous la forme `https://<compte>.github.io/<dépôt>/`.

Le workflow se trouve dans `.github/workflows/pages.yml`.

Chaque jour a sa propre adresse : `…/#j7` ouvre directement la traversée du
salar. Pratique pour envoyer une étape précise à quelqu'un.

## Modifier le contenu

Tout le texte du voyage vit dans **`data/etapes.json`** — aucun besoin de
toucher au code.

- **Corriger un récit** : le champ `recit` de l'étape concernée.
- **Ajouter une photo** : déposer le fichier dans `img/etapes/`, puis ajouter
  son chemin au tableau `photos` de l'étape.
- **Ajouter un lieu remarquable** : une entrée dans `points`, avec `nom`,
  `lat`, `lon`, `altitudeM` et `note`. Ajouter `"frontiere": true` pour la
  souligner en rouge.

Les kilométrages affichés (`km`, `kmPiste`) sont ceux de la brochure, pas ceux
mesurés sur le tracé : ils font foi.

## Refabriquer les données

Deux scripts, à lancer seulement si les sources changent. Le site publié
n'appelle aucune API : tout est figé sur disque.

```bash
python3 -m pip install pypdf pillow
python3 tools/extraire_photos.py "chemin/vers/brochure.pdf"
python3 tools/construire_parcours.py
```

`construire_parcours.py` calcule l'itinéraire route par route via OSRM, trace à
la main les deux portions que le réseau routier ne connaît pas — la piste du
Sud Lipez et la traversée du salar — puis relève l'altitude tous les deux
kilomètres. Il affiche, pour chaque étape, l'écart entre la distance calculée
et celle annoncée par la brochure : **c'est le garde-fou du tracé**. Un écart
au-delà d'une quinzaine de pour cent signale une coordonnée fausse ou un détour
oublié. Le total actuel tombe à 1 % de l'annonce.

Les réponses sont mises en cache dans `tools/.cache-parcours.json` ; `--refaire`
l'ignore.

## Ce qu'il y a dans le dossier

```
index.html            la page
css/style.css         toute la mise en forme
js/app.js             état, panneau, navigation entre étapes
js/carte.js           carte Leaflet : fonds, traces, jalons
js/profil.js          la frise et les profils d'altitude, en SVG
js/souvenirs*.js      le carnet de route : service, file d'attente, affichage
admin.html, js/admin.js  la modération, hors du site public
data/etapes.json      le contenu éditorial des quinze jours
data/parcours.geojson les traces et les relevés d'altitude
data/config.json      l'adresse du service du carnet
img/etapes/           les photos, extraites de la brochure
tools/                les deux scripts de fabrication
worker/               le service Cloudflare du carnet (D1 + R2)
```

Leaflet est embarqué dans `js/vendor/`, et les trois polices dans
`css/vendor/polices/` — licence SIL Open Font, sous-ensembles latin et
latin-ext, 232 Kio chargés pour un texte français. Aucune bibliothèque, aucune
fonte, aucune clé d'API n'est donc appelée à distance : il ne reste qu'une
seule dépendance extérieure, les tuiles des fonds de carte. Sans réseau, le
texte se lit normalement et seule la carte reste grise. Les trois fonds
(satellite Esri, relief OpenTopoMap, plan CARTO) sont libres d'accès avec
attribution.

## Ce que le tracé vaut

Les portions asphaltées suivent les vraies routes. Les deux portions de piste
tracées à la main — Sud Lipez et salar — sont fidèles dans leur intention et
leurs points de passage, mais ne sont pas des traces GPS : ne pas s'en servir
pour naviguer. Si Vintage Rides fournit les GPX des douze jours, ils
remplaceront avantageusement le calcul.

## Habillages

Quatre jeux de couleurs, choisis par les boutons de l'entête : **Nuit** (celui
d'origine), **Sel** (le salar : papier chaud, encre bleu nuit), **Altiplano**
(sable et turquoise des lagunes) et **Nations** (papier froid, bleu d'encre).
Le choix tient d'une visite à l'autre.

Chaque habillage ne redéfinit que des variables de couleur — pas une règle de
mise en page ne change. C'est ce qui permet d'en essayer quatre sans risquer la
moindre régression de disposition, et cela suppose qu'aucune couleur ne soit
écrite en dur ailleurs : une seule suffirait à laisser un bouton bleu nuit sur
un fond de papier.

Deux jetons méritent l'attention si l'on en ajoute un cinquième :
`--sur-accent` et `--sur-alerte`, ce qui se pose **sur** une couleur vive. Dans
« Sel », l'accent est un jaune trop clair pour porter du blanc — le contraste
tombe à 2,98 — et c'est l'encre qui s'y pose, à 5,23.

## Naviguer dans le voyage

**La frise est la barre de navigation**, posée au-dessus de la carte : le
profil d'altitude, les quinze journées et le nombre de notes de chacune
d'un seul tenant. Une seule barre, donc, plutôt qu'un profil en pied de page
et une liste de jours ailleurs. Les décomptes viennent d'un unique appel au
service (`GET /api/decomptes`) et se corrigent d'eux-mêmes dès qu'une note
est publiée ou supprimée.

**Survoler une journée de la frise la désigne sur la carte**, sans rien
ouvrir : sa trace ressort du parcours, et les deux pastilles qu'elle relie
s'allument. Rien ne s'ajoute à la carte — ce sont les repères déjà posés qui
répondent. Le clavier fait de même, au focus. Cela ne vaut qu'en vue
d'ensemble : une journée déjà ouverte a sa trace en avant et sa pastille
allumée, un second surlignage y ferait deux journées actives à la fois.

**Le panneau a deux onglets**, *Étape* et *Carnet de route*. Il s'ouvre sur le
carnet quand la journée a reçu des notes, sur l'étape sinon — c'est ce qu'on vient
chercher. Un clic sur un onglet tient jusqu'au changement de journée. La barre
« journée précédente / suivante » vit hors du panneau, au pied de la scène,
donc toujours atteignable : elle borde la carte quand la feuille est fermée et
le récit quand elle est ouverte. Elle vivait auparavant après le récit et toutes
les notes, c'est-à-dire une page entière de défilement plus bas.

La même barre ferme aussi la fiche d'accueil, où elle n'a qu'une moitié —
« Suivant · J1 Salta » — et depuis J1 le retour ramène à l'accueil, sous le
nom que lui donne déjà le bandeau : « Accueil · Tout le parcours ». On
parcourt ainsi le voyage entier d'un bout à l'autre sans jamais quitter la
barre. Une moitié sans destination garde sa place mais reste vide, sans
intitulé ni chevron : un « Suivant — » grisé annonçait une suite qui n'existe
pas. L'onglet *Étape* garde ce qui décrit la
journée — chiffres, profil, récit, points — et laisse les notes au sien.

**Sur téléphone**, la fiche est une feuille tirée depuis le bas, à deux
hauteurs : fermée, ou pleine — elle monte alors d'un seul tenant jusque sous la
frise, la carte recouverte. Les hauteurs partielles d'avant donnaient une
lucarne où la fiche se lisait par tiers ; sur un écran de téléphone, garder la
carte visible pendant qu'on lit le récit coûte plus qu'elle ne rapporte. La
frise, elle, reste toujours au-dessus : c'est la seule navigation du site.

La poignée dit « + d'infos » et porte un chevron qui montre où va la feuille ;
ouverte, le chevron seul suffit à la refermer, et l'`aria-label` continue de
dire ce qui s'ouvre — le détail de la journée, ou celui du parcours entier
depuis l'accueil. L'entête, lui, se resserre : « Tout le parcours » s'efface (le
titre y ramène) et les quatre pastilles d'habillage tiennent le coin haut droit.

Toujours sur téléphone, la frise déborde de l'écran — 704 points pour 375. Elle
se cale donc sur ce qu'on vient regarder : la journée ouverte, ou, depuis
l'accueil, l'endroit où en sont les motos.

## Le carnet de route

Chaque étape porte un carnet où les participants laissent des notes — un mot,
des photos, des vidéos. Le mot « souvenir » a été écarté de l'écran : les
proches lisent ces notes pendant le voyage, presque en direct, pas des années
plus tard. Il survit dans le code, où `souvenirs.js`, la base D1 et les routes
de l'API gardent leur nom : renommer la plomberie aurait demandé une migration
pour un changement qui ne concerne que la copie. Le site reste statique : ce bloc parle à un petit service Cloudflare
(dossier `worker/`), qui range les fichiers dans R2 et les notes dans D1.

**Pour poster**, il faut le mot de passe du groupe — donné de vive voix avant le
départ. Il n'est demandé qu'une fois par téléphone.

**Si le réseau manque** (et il manquera, dans le Sud Lipez comme sur le salar),
l'envoi est gardé sur le téléphone et repart tout seul dès que ça capte. Rien
ne se perd. La carte dit ce qu'elle fait vraiment, ce qui évite de tout
recommencer par doute :

| Ce qui est écrit | Ce qui se passe |
| --- | --- |
| `Envoi en cours · 3 sur 6` | ça monte en ce moment, la bordure bat lentement |
| `En attente d'envoi` | en file, sur le point de partir |
| `Hors réseau, repart tout seul` | le téléphone n'a pas de réseau |
| `Envoi interrompu, nouvel essai automatique` | une tentative a échoué, la suivante est programmée |
| `Bloqué : …` | refus définitif du service, un geste est attendu |

Si une note reste affichée en attente sans jamais repartir alors que le
réseau fonctionne de nouveau, recharger la page suffit à relancer la file.

**Regarder les photos** : un clic sur une photo l'ouvre en grand. Les flèches
du clavier, les boutons à l'écran ou un glissé du pouce passent d'un fichier au
suivant **dans toute la journée** — les photos et vidéos de toutes les notes de
l'étape se feuillettent d'affilée, quel qu'en soit l'auteur, et la série boucle
sur la dernière. Les galeries de la fiche d'étape, elles, restent chacune leur
propre série : on ne passe pas des photos d'un hébergement à celles d'un col.
`Échap` referme. Photos et vidéos s'ouvrent du même geste : dans la grille,
une vidéo est une vignette marquée d'un rond de lecture, sans commandes — elle
se joue en grand, dans la visionneuse.

**Plusieurs photos et vidéos par note**, sans limite de nombre. Le
sélecteur s'ouvre autant de fois qu'on veut : les fichiers s'ajoutent à la
liste au lieu de la remplacer, et chacun peut être retiré avant publication.
Les plafonds restent par fichier — 12 Mo une photo (après recompression
automatique), 60 Mo une vidéo. Le nombre de fichiers et leur poids total sont
affichés avant l'envoi : c'est le garde-fou d'une sélection malheureuse dans
la pellicule.

Chaque fichier part dans sa propre requête. Sur un lien qui lâche à mi-course,
seul le fichier en cours est à recommencer : la carte en attente indique
« 6 fichiers · 2 envoyés », et la reprise repart au troisième. Aucun fichier
n'est jamais attaché deux fois, chacun portant sa propre clé d'idempotence.

**Chacun peut modifier ou supprimer ses propres notes**, y compris leur
ajouter une photo après coup ou en retirer une seule : les boutons
n'apparaissent que sur le téléphone qui les a publiés. Changer d'appareil ou
vider son navigateur fait perdre cette main — la modération, elle, reste
valable sur tout.

**Modération** : la page `admin.html` (séparée du site, marquée `noindex` pour
ne pas apparaître dans les moteurs de recherche), protégée par le mot de passe
d'administration. Elle permet de supprimer n'importe quelle contribution, et
porte un menu pour n'afficher qu'une journée à la fois. Le menu liste les
quinze journées du voyage avec le nombre de contributions de chacune, y
compris celles restées vides : en modération, savoir qu'un jour n'a rien reçu
est une information.

La page a deux modules, choisis depuis un menu à gauche (en haut sur
téléphone) : la modération elle-même, et « Où en sont les motos ». Ce second
module pose la position affichée sur la carte et la frise du site, en
manuel (une journée choisie à la main) ou en automatique (une date de
départ, et le site avance tout seul de J1 à J15 — un décalage en jours
corrige un retard ou une avance sans changer de mode). Le changement de
journée automatique se fait à minuit heure de Paris.

Aux deux bouts du voyage, la frise annonce une date plutôt qu'un lieu :
« Départ prévu le… » tant qu'on n'est pas partis, « Nous sommes arrivés
le… » une fois J15 atteint. L'automatique les déduit de la date de départ ;
en manuel, un champ de date paraît dans le module — et seulement à ces deux
moments-là, « Pas encore partis » et la dernière journée, les seuls où il y
a quelque chose à dater. Laissé vide, la frise dit « Nous ne sommes pas encore
partis ! » avant le départ, et « Nous sommes ici ! » en chemin. Une date saisie
n'est jamais perdue en changeant de journée : elle ressort le moment venu.

### Compter les visites

La page d'administration a un module **Visites** : combien de personnes lisent
le carnet, combien de pages elles ouvrent, et quelles étapes elles ouvrent le
plus. Trois blocs — les totaux depuis le début, la journée en cours, la courbe
jour après jour — puis le classement des quinze journées et de l'accueil.

**Rien n'identifie personne.** Pas d'adresse IP, pas de cookie, pas d'empreinte
de navigateur. C'est le navigateur du lecteur qui retient chez lui, en
`localStorage`, qu'il a déjà été compté aujourd'hui, et en `sessionStorage`
quelles étapes il a déjà ouvertes pendant sa visite ; il n'envoie qu'un numéro
d'étape et un booléen. Le service ne peut donc ni reconnaître un lecteur d'un
jour à l'autre, ni savoir combien de fois la même personne est revenue. C'est le
prix — assumé — d'un compteur qui n'espionne pas : le chiffre des « visiteurs
uniques » repose sur la parole du navigateur, et un lecteur qui vide son
stockage sera recompté.

Ce qui est compté, exactement :

- **une page vue** par étape réellement ouverte, une seule fois par visite —
  aller et venir entre l'accueil et le jour 7 ne compte pas dix fois ;
- **un visiteur** la première fois qu'un navigateur se manifeste dans la
  journée, à l'heure de Paris comme le reste du site.

Deux tables, `visites_jour` et `visites_etape`, deux compteurs qu'on incrémente
plutôt qu'une ligne par visite : une table qui grossit à chaque page lue aurait
fini par peser plus lourd que les souvenirs eux-mêmes.

La route d'écriture `POST /api/visite` est **publique** — c'est un site
public — mais réservée aux origines de `ORIGINES_AUTORISEES`. Sans ce garde, une
boucle de `curl` gonflerait les chiffres et mangerait le forfait d'écritures de
D1. Une origine se forge : ce n'est pas inviolable, c'est proportionné.

Ce module a besoin des deux nouvelles tables. **Appliquer `schema.sql` à la base
distante avant de déployer**, sinon le service interroge des tables qui
n'existent pas :

```bash
cd worker && npx wrangler d1 execute souvenirs --remote --file=schema.sql
cd worker && npx wrangler deploy
```

### Suivre la consommation

La page d'administration a un troisième module, **Consommation** : où en est le
compte Cloudflare par rapport à l'offre gratuite. Une carte par service —
Workers, D1, R2 — et pour chaque mesure sa valeur, le forfait, la part
consommée et le moment où le compteur repart de zéro. Au-delà de quatre
cinquièmes du forfait la mesure se dit « proche du plafond » ; au-delà du
plafond, la jauge passe au rouge.

Ce module est **facultatif** : sans les deux secrets ci-dessous, il affiche une
phrase qui le dit et rien d'autre ne change. Le carnet fonctionne sans lui.

Les chiffres viennent de l'API GraphQL Analytics de Cloudflare, interrogée par
le service — le jeton ne descend jamais dans le navigateur. Il faut donc deux
secrets de plus, posés comme les mots de passe :

```bash
cd worker && npx wrangler secret put JETON_ANALYTIQUE_CF
cd worker && npx wrangler secret put ID_COMPTE_CF
```

Le jeton se crée dans le tableau de bord Cloudflare (*My Profile → API Tokens →
Create Token → Create Custom Token*) avec une seule permission :
**Account · Account Analytics · Read**. L'identifiant de compte se lit dans
l'URL du tableau de bord, ou sur la page d'accueil du compte. Il passe en
secret plutôt qu'en variable de `wrangler.toml` : ce dépôt est public.

Deux réserves à connaître :

- **Les forfaits sont écrits en dur** dans `worker/lib/consommation.js`, relevés
  dans la documentation Cloudflare en août 2026. Ils bougent, et rien ne les
  vérifie. Si le module annonce un jour une marge qui ne correspond plus au
  tableau de bord, c'est cette table qu'il faut revoir en premier.
- **Le giga-octet y vaut 10⁹ octets et non 2³⁰.** Cloudflare écrit
  « 10 GB-month » sans dire lequel des deux : on retient la lecture la plus
  sévère, qui rend le forfait plus petit de 7 % et fait monter la jauge plus
  vite. Se tromper de ce côté fait s'inquiéter un peu tôt ; se tromper de
  l'autre ferait annoncer de la marge qui n'existe pas.

Si Cloudflare refuse la demande ou renomme un champ, le module affiche le
message de Cloudflare tel quel, en anglais : il nomme le champ fautif, et c'est
la seule chose qui permette de corriger la requête sans tâtonner.

### Développer en local

Le service tourne à côté du site, sur un port différent :

```bash
cd worker
npm install
npx wrangler d1 execute souvenirs --local --file=schema.sql
npx wrangler dev --local --port 8787
```

Le site, lui, doit être servi sur le port **8123 exactement** (voir
« Le faire tourner chez soi » plus haut) : c'est la seule origine locale que le
service autorise, avec `127.0.0.1:8123`, en plus de l'adresse GitHub Pages —
voir `ORIGINES_AUTORISEES` dans `worker/wrangler.toml`.

Les mots de passe locaux vont dans `worker/.dev.vars` (non suivi par git, à
créer soi-même) :

```
MOT_DE_PASSE_GROUPE=...
MOT_DE_PASSE_ADMIN=...
```

> **Important — sécurité.** Les mots de passe de développement `uyuni2026` et
> `admin-de-test` ont servi d'exemple dans le plan d'implémentation de cette
> fonctionnalité. Ils n'apparaissent plus dans les fichiers d'aujourd'hui, mais
> restent lisibles dans l'historique du dépôt, public s'il est hébergé sur
> GitHub. **Ne jamais les
> réutiliser comme mots de passe de production** : choisir, au moment du
> déploiement (étape « Poser les deux mots de passe » ci-dessous), deux mots
> de passe différents de ceux-là.

Tests des fonctions pures du service — autorisation, position, consommation,
visites — et de la file d'attente hors-ligne (61 tests) :

```bash
cd worker && node --test
```

Sans chemin : `node --test test/` fonctionnait sous Node 20, mais Node 22 lit le
dossier comme un module et échoue. La forme nue trouve les mêmes fichiers sous
les deux versions.

### Déployer le service

Ces étapes ne sont à faire qu'une fois, par la personne qui possède (ou crée)
le compte Cloudflare. Elles ne demandent qu'un compte gratuit.

1. **Se connecter à Cloudflare** — ouvre une page web pour autoriser
   `wrangler` :

   ```bash
   cd worker
   npx wrangler login
   ```

   Attendu : le navigateur s'ouvre, demande de se connecter (ou de créer un
   compte gratuit) puis d'autoriser l'accès ; le terminal affiche ensuite
   `Successfully logged in`.

2. **Créer la base de données D1** — c'est là que vivent les notes :

   ```bash
   npx wrangler d1 create souvenirs
   ```

   Attendu : un bloc `[[d1_databases]]` s'affiche, avec un `database_id` (un
   identifiant du genre `xxxxxxxx-xxxx-...`). **Copier cet identifiant** dans
   `worker/wrangler.toml`, à la place de `à-renseigner-au-deploiement`.

3. **Créer le bucket R2** — c'est là que vivent les photos et vidéos :

   ```bash
   npx wrangler r2 bucket create souvenirs-medias
   ```

   Attendu : une confirmation de création du bucket.

4. **Appliquer le schéma sur la base distante** — crée les tables dans la
   base créée à l'étape 2 (à ne pas confondre avec `--local`, utilisé plus
   haut pour le développement) :

   ```bash
   npx wrangler d1 execute souvenirs --remote --file=schema.sql
   ```

   Attendu : les deux instructions du schéma s'exécutent sans erreur. Cette
   étape est indispensable **avant** le déploiement : le service planterait
   sur sa première requête sans elle.

5. **Poser les deux mots de passe** — ce sont des secrets Cloudflare, jamais
   écrits dans le dépôt ; chaque commande demande de taper une valeur puis
   Entrée :

   ```bash
   npx wrangler secret put MOT_DE_PASSE_GROUPE
   npx wrangler secret put MOT_DE_PASSE_ADMIN
   ```

   Choisir un mot de passe de groupe simple à dire de vive voix, et un mot de
   passe d'administration différent et plus long — **ni l'un ni l'autre ne
   doit reprendre `uyuni2026` ou `admin-de-test`**, utilisés dans le plan
   d'implémentation et donc déjà publics.

   Deux autres secrets, facultatifs, ouvrent le module Consommation de la page
   d'administration : voir « Suivre la consommation » plus bas.

6. **Déployer** :

   Avant de déployer, vérifier `ORIGINES_AUTORISEES` dans `worker/wrangler.toml` :
   si ce dépôt est hébergé sous un compte GitHub différent de `tinmarlastar`,
   l'adresse GitHub Pages réelle du site publié doit y être ajoutée. Sans ça,
   le CORS échoue silencieusement une fois le service en ligne — le bloc
   carnet ne se charge plus, sans message d'erreur visible.

   ```bash
   npx wrangler deploy
   ```

   Attendu : une adresse du type
   `https://souvenirs-salta-cusco.<compte>.workers.dev`.

7. **Pointer le site sur le service en ligne** — remplacer le contenu de
   `data/config.json` (déjà réglé sur le service déployé dans ce dépôt) :

   ```json
   {
     "serviceUrl": "https://souvenirs-salta-cusco.<compte>.workers.dev"
   }
   ```

   C'est le **seul fichier à changer** pour passer du service local au
   service déployé, et c'est la **dernière étape** du déploiement.

8. **Vérifier** :

   ```bash
   curl -s "https://souvenirs-salta-cusco.<compte>.workers.dev/api/etape/7"
   ```

   Attendu : `{"contributions":[]}`.

9. **Publier le site** — envoyer le commit qui met à jour `data/config.json`
   sur `main` ; le workflow GitHub Pages republie le site automatiquement.
   Vérifier ensuite sur le site publié que le carnet se charge et
   qu'une note peut être postée.

### Redéployer le service

Après une modification de `worker/index.js` ou de `worker/lib/` :

```bash
cd worker && npx wrangler deploy
```

**Si `schema.sql` a changé**, l'appliquer à la base distante *avant* de
déployer, sinon le service déployé interroge des tables qui n'existent pas
encore :

```bash
cd worker && npx wrangler d1 execute souvenirs --remote --file=schema.sql
```

Le script est écrit pour être rejoué sans dommage (`IF NOT EXISTS`,
`INSERT OR IGNORE`) : l'appliquer deux fois ne crée pas de doublon et ne
détruit rien.

Les mots de passe restent ceux déjà posés ; il n'y a pas besoin de les
reposer, sauf pour les changer :

```bash
cd worker && npx wrangler secret put MOT_DE_PASSE_GROUPE
```
