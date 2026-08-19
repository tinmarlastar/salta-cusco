# Aventure des 4 Nations — Salta → Cusco

Carte interactive du raid moto Vintage Rides de Salta (Argentine) à Cusco (Pérou) :
3 036 km dont 875 km de piste, quatre pays andins, quinze jours.

Le site tient en trois écrans : une carte qui porte tout le parcours, une fiche
par jour, et une frise du bas qui est en réalité le profil d'altitude du voyage
entier — les quinze jours y sont posés sur la silhouette réelle du trajet.

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
data/etapes.json      le contenu éditorial des quinze jours
data/parcours.geojson les traces et les relevés d'altitude
img/etapes/           les photos, extraites de la brochure
tools/                les deux scripts de fabrication
```

Leaflet est embarqué dans `js/vendor/` : le site ne dépend d'aucun CDN ni
d'aucune clé d'API. Les trois fonds de carte (satellite Esri, relief
OpenTopoMap, plan CARTO) sont libres d'accès avec attribution.

## Ce que le tracé vaut

Les portions asphaltées suivent les vraies routes. Les deux portions de piste
tracées à la main — Sud Lipez et salar — sont fidèles dans leur intention et
leurs points de passage, mais ne sont pas des traces GPS : ne pas s'en servir
pour naviguer. Si Vintage Rides fournit les GPX des douze jours, ils
remplaceront avantageusement le calcul.
