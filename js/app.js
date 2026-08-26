/* Orchestration : charge les données, monte la carte, la frise et le panneau,
   et garde tout le monde d'accord sur l'étape affichée.

   L'étape courante vit dans l'adresse (#j7) : chacun peut donc envoyer un lien
   vers un jour précis du voyage. */

import { creerCarte } from './carte.js';
import { ajusterMotDeLaFrise, assemblerVoyage, dessinerFrise, dessinerProfilEtape } from './profil.js';
import { monterSouvenirs, brancherVisionneuse } from './souvenirs-vue.js';
import { listerDecomptes, lirePosition } from './souvenirs.js';

const nombre = (valeur) => valeur.toLocaleString('fr-FR');
const echapper = (texte) => String(texte).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const etat = {
  etapes: [], traces: null, voyage: null, jour: null, carte: null,
  // Nombre de souvenirs par journée, pour les pastilles du bandeau.
  decomptes: {},
  // Où en sont les motos : la journée dite depuis la zone d'administration, et
  // quand elle l'a été. `null` tant que personne ne l'a dite — les motos
  // attendent alors au kilomètre zéro, à Salta. `departPrevuLe` et `arriveeLe`
  // datent les deux bouts du voyage quand le service les connaît.
  position: { jour: null, majLe: null, departPrevuLe: null, arriveeLe: null },
  // Onglet du panneau, et si l'on y est arrivé par un clic. Le défaut se
  // recalcule à chaque journée — souvenirs quand il y en a, étape sinon —,
  // mais un choix explicite tient jusqu'au changement de journée.
  onglet: 'etape',
  ongletChoisiALaMain: false,
};

const elements = {
  eyebrow: document.getElementById('eyebrow-voyage'),
  titre: document.getElementById('titre-voyage'),
  panneau: document.getElementById('panneau'),
  frise: document.getElementById('frise'),
  poignee: document.getElementById('poignee'),
  poigneeTexte: document.getElementById('poignee-texte'),
  boutonAccueil: document.getElementById('bouton-accueil'),
  identite: document.querySelector('.bandeau__identite'),
  navigation: document.getElementById('navigation'),
};

// ------------------------------------------------------------------ données

async function charger(chemin) {
  const reponse = await fetch(chemin);
  if (!reponse.ok) throw new Error(`${chemin} : ${reponse.status}`);
  return reponse.json();
}

async function demarrer() {
  let contenu, traces;
  try {
    [contenu, traces] = await Promise.all([
      charger('data/etapes.json'),
      charger('data/parcours.geojson'),
    ]);
  } catch (erreur) {
    elements.panneau.innerHTML = `<div class="fiche">
      <h2 class="fiche__titre">Les données du parcours ne se chargent pas</h2>
      <p class="recit">${echapper(erreur.message)}. Ouvrez la page via un serveur web
      plutôt qu'en double-cliquant le fichier : <code>python3 -m http.server</code>
      dans le dossier du site, puis <code>http://localhost:8000</code>.</p></div>`;
    return;
  }

  etat.etapes = contenu.etapes;
  etat.traces = traces;
  etat.voyage = assemblerVoyage(traces);

  remplirBandeau(contenu.voyage);
  etat.accueil = contenu.voyage;

  etat.carte = creerCarte(document.getElementById('carte'), {
    etapes: etat.etapes,
    traces,
    surChoixEtape: (jour) => choisir(jour),
  });

  brancherHabillages();
  brancherInterface();
  reglerFeuille('fermee');
  choisir(jourDepuisAdresse(), { recentrer: false });
  redessinerFrise();

  // Les pastilles arrivent après coup : le bandeau est utilisable sans elles,
  // et un service injoignable ne doit pas retarder l'affichage du parcours.
  listerDecomptes()
    .then((decomptes) => {
      etat.decomptes = decomptes;
      redessinerFrise();
      // Les décomptes arrivent après le premier affichage : c'est seulement
      // maintenant qu'on sait si la journée ouverte a des souvenirs, donc quel
      // onglet elle devait montrer.
      appliquerOngletParDefaut();
    })
    .catch(() => {});

  // La position des motos suit le même chemin que les décomptes : elle arrive
  // quand elle arrive, et son absence n'empêche rien de s'afficher.
  lirePosition()
    .then((position) => {
      etat.position = position;
      redessinerFrise();
    })
    .catch(() => {});

  // La grille de la page n'est mesurable qu'après le premier rendu : c'est là
  // seulement que la carte peut se cadrer sur la bonne étape.
  requestAnimationFrame(() => etat.carte.recadrer());
}

function remplirBandeau(voyage) {
  // La monture est déjà détaillée dans le panneau d'accueil : la répéter ici
  // ferait déborder le bandeau sur un téléphone.
  elements.eyebrow.textContent = `${voyage.operateur} · ${voyage.duree}`;

  // Le drapeau du pays de départ, puis celui d'arrivée, glissés après le nom
  // de chaque ville — pris sur la première et la dernière étape plutôt
  // qu'écrits en dur, pour rester justes si le voyage change un jour de
  // point de départ ou d'arrivée.
  const drapeauPays = (code) => voyage.pays.find((p) => p.code === code)?.drapeau ?? '';
  const depart = etat.etapes[0];
  const arrivee = etat.etapes[etat.etapes.length - 1];
  let sousTitre = voyage.sousTitre.replace('Horizons sud-américains, ', '');
  if (depart) {
    sousTitre = sousTitre.replace(depart.depart.nom, `${depart.depart.nom} ${drapeauPays(depart.pays[0])}`);
  }
  if (arrivee) {
    const code = arrivee.pays[arrivee.pays.length - 1];
    sousTitre = sousTitre.replace(arrivee.arrivee.nom, `${arrivee.arrivee.nom} ${drapeauPays(code)}`);
  }

  elements.titre.innerHTML = `${echapper(voyage.titre)} <span>${echapper(sousTitre)}</span>`;
}

// ---------------------------------------------------------------- sélection

function jourDepuisAdresse() {
  const trouve = /^#j(\d{1,2})$/.exec(location.hash);
  if (!trouve) return null;
  const jour = Number(trouve[1]);
  return etat.etapes.some((e) => e.jour === jour) ? jour : null;
}

function choisir(jour, { recentrer = true, majAdresse = true } = {}) {
  if (jour !== etat.jour) etat.ongletChoisiALaMain = false;
  etat.jour = jour;
  const etape = etat.etapes.find((e) => e.jour === jour) || null;

  etat.carte.montrerEtape(etape, { recentrer });
  afficherPanneau(etape);
  majPoignee();
  redessinerFrise();

  if (majAdresse) {
    const cible = etape ? `#j${etape.jour}` : ' ';
    if (location.hash !== cible) history.replaceState(null, '', etape ? cible : location.pathname);
  }
  elements.boutonAccueil.hidden = !etape;
  // Pas de curseur de main sur l'accueil, où le clic n'aurait nulle part où
  // aller : une invitation sans destination se remarque tout de suite.
  elements.identite.classList.toggle('est-cliquable', Boolean(etape));
  elements.identite.title = etape ? 'Revenir au parcours entier' : '';
}

/** Revient au parcours entier : la carte, et rien qui la couvre.

    Sur téléphone, `choisir(null)` seul laissait la feuille ouverte : on
    demandait « tout le parcours » et on obtenait la présentation du voyage,
    un texte à lire posé par-dessus la carte qu'on venait justement chercher.
    Le parcours entier EST la carte — c'est ce que le titre promet quand on le
    touche. La feuille se replie donc avec la sélection.

    Sur grand écran, où le panneau est une colonne et non une feuille,
    `reglerFeuille` n'a rien à replier : l'appel y reste sans effet visible, et
    les deux tailles d'écran gardent un seul chemin de retour. */
function revenirAuParcours() {
  choisir(null);
  reglerFeuille('fermee');
}

/** Déplace la sélection d'un cran ; depuis l'accueil, avance sur la première étape. */
function decaler(pas) {
  const jours = etat.etapes.map((e) => e.jour);
  if (!jours.length) return;
  const index = jours.indexOf(etat.jour);
  const cible = index === -1 ? (pas > 0 ? jours[0] : null) : jours[index + pas];
  if (cible !== undefined && cible !== null) choisir(cible);
}

function redessinerFrise() {
  if (!etat.voyage) return;
  dessinerFrise(elements.frise, {
    voyage: etat.voyage,
    etapes: etat.etapes,
    jourActif: etat.jour,
    surChoixEtape: (jour) => choisir(jour),
    surSurvolEtape: (jour) => etat.carte?.survolerEtape(jour),
    surSortieEtape: () => etat.carte?.finSurvol(),
    decomptes: etat.decomptes,
    positionJour: etat.position.jour,
    departPrevuLe: etat.position.departPrevuLe,
    arriveeLe: etat.position.arriveeLe,
  });
  amenerEtapeEnVue();
  majBordsFrise();
  // Après le recentrage, jamais avant : c'est lui qui décide si « Nous sommes
  // ici ! » est resté dans la fenêtre.
  ajusterMotDeLaFrise(elements.frise);
}

/** Marque lequel des deux bords de la frise cache une suite.

    La frise est la seule navigation du site, et sur un téléphone elle mesure
    704 points dans une fenêtre de 390 : à l'ouverture, on voit J1 à J8 et rien
    ne dit que le voyage continue. La barre de défilement d'iOS reste invisible
    tant qu'on ne touche pas — un visiteur qui ne devine pas le geste croit que
    le raid s'arrête au huitième jour.

    Le bord qui cache quelque chose s'estompe donc (le dégradé est dans la
    CSS) : le tracé qui s'efface au lieu de s'arrêter net dit qu'il y a une
    suite. Marqué des deux côtés séparément, parce qu'au bout de la course il
    n'y a plus rien à annoncer et qu'un bord estompé mentirait alors.

    Quatre points de tolérance : un défilement tactile s'arrête rarement sur
    l'entier, et une frise arrivée au bout à 0,6 point près doit se lire comme
    arrivée au bout. */
function majBordsFrise() {
  const defilement = elements.frise.parentElement;
  const reste = defilement.scrollWidth - defilement.clientWidth;
  const gauche = defilement.scrollLeft > 4;
  const droite = defilement.scrollLeft < reste - 4;
  defilement.dataset.bords = gauche && droite ? 'deux'
    : gauche ? 'gauche'
      : droite ? 'droite' : 'aucun';
}

/** Sur un écran étroit la frise déborde : on l'amène sur l'étape choisie, ou
    sur les motos quand il n'y en a plus. */
function amenerEtapeEnVue() {
  const defilement = elements.frise.parentElement;
  if (defilement.scrollWidth <= defilement.clientWidth) return;

  /** Amène une abscisse du dessin au milieu de la fenêtre. Positionnement
      direct plutôt qu'animé : la frise vient d'être redessinée, un glissement
      donnerait l'impression qu'elle flotte pendant la lecture. */
  const centrerSur = (xDessin) => {
    const largeurVue = elements.frise.viewBox.baseVal.width;
    if (!largeurVue) return;
    const echelle = elements.frise.getBoundingClientRect().width / largeurVue;
    defilement.scrollLeft = xDessin * echelle - defilement.clientWidth / 2;
  };

  const marque = elements.frise.querySelector('.est-actif');
  // Parcours entier : la frise se cale sur les motos plutôt que sur le premier
  // jour. Sur un téléphone elle mesure le double de la fenêtre, et la moitié du
  // voyage est hors champ : arriver sur l'accueil au huitième jour de route et
  // ne voir que J1 à J8 cache précisément ce qu'on vient regarder. Ce qu'elle
  // montre est ce que la phrase annonce — « Nous sommes ici ! » en chemin, la
  // date du départ avant de partir, celle de l'arrivée une fois à Cusco.
  //
  // Avant le départ, les motos sont au kilomètre zéro : la frise se cale donc
  // sur son début, comme avant, le défilement négatif étant ramené à zéro par
  // le navigateur. Rien ne change tant qu'on n'est pas partis.
  if (!marque) {
    centrerSur(Number(elements.frise.dataset.motosX) || 0);
    return;
  }

  const boite = marque.getBBox ? marque.getBBox() : null;
  if (!boite) return;
  centrerSur(boite.x + boite.width / 2);
}

// ------------------------------------------------------------------ panneau

function afficherPanneau(etape) {
  elements.panneau.innerHTML = etape ? gabaritFiche(etape) : gabaritAccueil(etat.accueil);
  elements.panneau.scrollTop = 0;
  afficherNavigation(etape);

  if (etape) {
    const trace = etat.traces.features.find((f) => f.properties.jour === etape.jour);
    const svg = elements.panneau.querySelector('.profil-etape svg');
    if (trace && svg) {
      dessinerProfilEtape(svg, trace, {
        surSurvol: (lat, lon) => etat.carte.placerCurseur(lat, lon),
        surSortie: () => etat.carte.masquerCurseur(),
      });
    }
    const blocSouvenirs = elements.panneau.querySelector('#souvenirs-etape');
    if (blocSouvenirs) {
      monterSouvenirs(blocSouvenirs, etape.jour, {
        // Le décompte vient de la vue des souvenirs, seule à connaître le
        // nombre réellement publié pour cette journée. Il corrige la pastille
        // de la frise dès qu'un souvenir est publié ou supprimé, sans
        // recharger la page — d'où le redessin, sans lequel la valeur était
        // bien enregistrée mais n'apparaissait qu'au changement de journée
        // suivant, celui-ci redessinant la frise pour d'autres raisons.
        surDecompte: (nombre) => {
          etat.decomptes[etape.jour] = nombre;
          majOngletCompte(nombre);
          redessinerFrise();
        },
      });
    }
    brancherOnglets();
  }

  for (const bouton of elements.panneau.querySelectorAll('[data-lat]')) {
    bouton.addEventListener('click', () => {
      etat.carte.carte.setView([Number(bouton.dataset.lat), Number(bouton.dataset.lon)], 13);
    });
  }
}

/** La bande du bas : d'où l'on vient, où l'on va.

    Refaite à chaque journée comme la fiche, mais séparément : elle n'est plus
    dedans, et depuis l'accueil elle n'a qu'une moitié à remplir. */
function afficherNavigation(etape) {
  const precedente = etape ? etat.etapes.find((e) => e.jour === etape.jour - 1) : null;
  const suivante = etape ? etat.etapes.find((e) => e.jour === etape.jour + 1) : etat.etapes[0];
  // Depuis l'accueil il n'y a rien en arrière ; depuis J1, le retour ramène au
  // parcours entier plutôt qu'à une journée qui n'existe pas.
  const precedent = etape ? (precedente ? cibleEtape(precedente) : CIBLE_ACCUEIL) : null;
  elements.navigation.innerHTML = gabaritNavigation(precedent, cibleEtape(suivante));

  for (const bouton of elements.navigation.querySelectorAll('[data-jour]')) {
    // « accueil » plutôt qu'un numéro convenu : la vue d'ensemble n'est pas
    // une journée, et un 0 posé là aurait fini par se glisser dans une
    // comparaison de jours, où il aurait passé pour une étape.
    const cible = bouton.dataset.jour === 'accueil' ? null : Number(bouton.dataset.jour);
    bouton.addEventListener('click', () => choisir(cible));
  }
}

// -------------------------------------------------------- onglets du panneau

function brancherOnglets() {
  for (const bouton of elements.panneau.querySelectorAll('[data-onglet]')) {
    bouton.addEventListener('click', () => {
      etat.ongletChoisiALaMain = true;
      activerOnglet(bouton.dataset.onglet);
    });
  }
  appliquerOngletParDefaut();
}

/** Ouvre sur les souvenirs quand la journée en a, sur l'étape sinon.

    C'est ce que l'on vient chercher : une journée qui a reçu des photos se
    regarde d'abord, une journée vide se lit. Un clic sur un onglet coupe court
    à cette règle jusqu'au changement de journée — sans quoi le décompte, qui
    arrive après coup, ramènerait sur « Souvenirs » quelqu'un qui vient d'aller
    voir le récit. */
function appliquerOngletParDefaut() {
  if (etat.ongletChoisiALaMain) return;
  if (!elements.panneau.querySelector('[data-onglet]')) return;
  activerOnglet(etat.decomptes[etat.jour] > 0 ? 'souvenirs' : 'etape');
}

function activerOnglet(nom) {
  etat.onglet = nom;
  for (const bouton of elements.panneau.querySelectorAll('[data-onglet]')) {
    const actif = bouton.dataset.onglet === nom;
    bouton.classList.toggle('est-actif', actif);
    bouton.setAttribute('aria-selected', String(actif));
  }
  for (const volet of elements.panneau.querySelectorAll('[data-volet]')) {
    volet.hidden = volet.dataset.volet !== nom;
  }
}

function majOngletCompte(nombre) {
  const compte = elements.panneau.querySelector('.onglets__compte');
  if (!compte) return;
  compte.hidden = nombre === 0;
  compte.textContent = nombre;
}

function gabaritAccueil(voyage) {
  const joursParPays = new Map(voyage.pays.map((p) => [p.code, 0]));
  for (const etape of etat.etapes) {
    for (const code of etape.pays) joursParPays.set(code, (joursParPays.get(code) || 0) + 1);
  }

  // Les chiffres du voyage vivaient dans l'entête, où ils occupaient une bande
  // sur toute la largeur à chaque écran. Ils décrivent le voyage entier : leur
  // place est sur sa fiche, c'est-à-dire ici.
  const denivele = etat.voyage?.denivelePositifM;

  const mesures = [
    ['Distance', `${nombre(voyage.distanceKm)} <b>km</b>`],
    ['Altitude max', `${nombre(voyage.altitudeMaxM)} <b>m</b>`],
    ['Pays traversés', `${voyage.pays.length}`],
    // Le dénivelé vient du tracé, pas de la brochure : si les traces n'ont pas
    // pu être chargées, la case s'efface plutôt que d'afficher zéro.
    ...(denivele ? [['Dénivelé total', `${nombre(denivele)} <b>m</b>`]] : []),
  ];

  return `<div class="accueil">
    <dl class="chiffres">${mesures
      .map(([titre, valeur]) => `<div><dt>${titre}</dt><dd>${valeur}</dd></div>`)
      .join('')}</dl>

    <img class="accueil__photo" src="${voyage.photo}" alt="Un motard seul sur une piste de terre, face à une cordillère enneigée." loading="lazy">
    <p class="accueil__texte">${echapper(voyage.presentation)}</p>

    <p class="sous-titre">Quatre pays, quinze jours</p>
    <ul class="pays">
      ${voyage.pays.map((p) => `<li><span aria-hidden="true">${p.drapeau}</span> ${echapper(p.nom)}
        <em>${joursParPays.get(p.code)} jour${joursParPays.get(p.code) > 1 ? 's' : ''}</em></li>`).join('')}
    </ul>

    <p class="sous-titre">La formule</p>
    <ul class="pays">
      <li>Encadrement <em>${echapper(voyage.formule)}</em></li>
      <li>Niveau <em>${echapper(voyage.niveau)}</em></li>
      <li>Hébergement <em>${echapper(voyage.hebergement)}</em></li>
      <li>Repas <em>${echapper(voyage.pension)}</em></li>
      <li>Monture <em>${echapper(voyage.moto)}</em></li>
    </ul>

    <p class="sous-titre">Aperçu des hébergements</p>
    <div class="vignettes">
      ${voyage.hebergements.map((photo) =>
        `<img src="${photo}" alt="" loading="lazy" tabindex="0">`).join('')}
    </div>
  </div>`;
}

// Allures retenues pour estimer un temps de trajet à partir des distances, en
// km/h. Grossier par nature — un col à 4 800 m ne se monte pas à l'allure d'une
// piste plate, et le sable du salar n'est pas la latérite — mais du bon ordre
// de grandeur sur une journée entière, où le rapide et le lent se compensent.
const VITESSE_ROUTE = 60;
const VITESSE_PISTE = 25;

function dureeEstimee(kmRoute, kmPiste) {
  return Math.round((kmRoute / VITESSE_ROUTE + kmPiste / VITESSE_PISTE) * 60);
}

/** Temps de trajet : celui de l'étape s'il est connu, sinon une estimation.

    Les distances, elles, sont sûres : la durée s'en déduit plutôt que d'être
    saisie une seconde fois. Un chiffre estimé n'a le droit de figurer sur une
    fiche de voyage qu'à condition de se dire tel : l'intitulé le dit — « Durée
    estimée » et non « Temps de trajet », qui se lirait comme un relevé — et le
    « ≈ » le répète sur la valeur. Renseigner `dureeMinutes` sur une étape
    remplace l'estimation par le vrai chiffre, reprend l'intitulé « Temps de
    trajet » et fait tomber le « ≈ ». */
function gabaritDuree(etape, kmRoute) {
  const reelle = etape.dureeMinutes;
  const minutes = reelle || dureeEstimee(kmRoute, etape.kmPiste);
  if (!minutes) return '';
  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  const valeur = reste ? `${heures} <small>h</small> ${String(reste).padStart(2, '0')}` : `${heures} <small>h</small>`;
  // Le libellé porte lui-même la réserve : « Durée estimée » ne se lit pas de
  // travers, là où « Temps de trajet » suivi d'un chiffre passait pour un
  // relevé. Le « ≈ » reste sur la valeur — c'est elle qu'on retient, et
  // l'intitulé se saute d'un coup d'œil.
  const intitule = reelle ? 'Temps de trajet' : 'Durée estimée';
  return `<div><dt>${intitule}</dt><dd>${reelle ? '' : '≈ '}${valeur}</dd></div>`;
}

/* Ce que vise une moitié de la barre de navigation : la valeur à poser dans
   `data-jour`, ce qui s'écrit dessous, et de quoi remplacer l'intitulé comme
   le chevron du côté — une cible peut porter les siens. `null` — pas de
   cible — laisse la moitié vide.

   L'accueil en profite : « Précédent » l'annoncerait comme la journée d'avant
   J1, alors que c'est la fiche du voyage entier. Il reprend donc mot pour mot
   ce qu'en dit déjà le bouton du bandeau, « Tout le parcours » — deux noms
   pour un même endroit se seraient contredits à l'écran. */
/* Une maison dessinée ici plutôt qu'un caractère « ⌂ » ou un émoji : le
   premier manque à beaucoup de polices et tomberait sur un rectangle vide,
   le second arrive avec ses propres couleurs et ne prendrait pas celle de la
   pastille. `currentColor` la lui donne, comme au chevron qu'elle remplace.

   Toit, murs, porte : trois traits, pas un de plus. À quatorze points de côté,
   une fenêtre ou une cheminée se refermeraient en pâté. */
const ICONE_MAISON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"
     fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1.9 7.7 8 2.4l6.1 5.3"/>
  <path d="M3.4 8.6v5h9.2v-5"/>
  <path d="M6.6 13.6v-3.1h2.8v3.1"/>
</svg>`;

// Chaque destination se dit de deux façons : au long, et en court pour les
// écrans étroits, où la moitié de barre qui l'accueille ne fait plus que la
// moitié d'un téléphone — « J13 Quince Mil » en débordait. Les deux libellés
// sont écrits dans la page, la CSS choisit ; les calculer en JavaScript
// d'après la largeur de la fenêtre aurait refait à la main ce qu'une media
// query fait seule, et il aurait fallu tout réafficher à chaque rotation.
const CIBLE_ACCUEIL = {
  cle: 'accueil', sens: 'Accueil', libelle: 'Tout le parcours', court: 'Parcours',
  icone: ICONE_MAISON,
};
// Le numéro suffit en court : c'est le nom que la frise donne aux journées, et
// celui par lequel on les nomme partout ailleurs sur le site.
const cibleEtape = (etape) => (etape
  ? { cle: etape.jour, libelle: `J${etape.jour} ${etape.arrivee.nom}`, court: `J${etape.jour}` }
  : null);

/** La barre « précédent / suivant », au pied de l'écran.

    Elle vit hors du panneau, dans la scène : c'est le seul chemin qui mène
    d'un bout à l'autre du voyage sans passer par la frise, et au pied de la
    fiche il disparaissait avec elle — sur téléphone, feuille fermée, changer
    de journée demandait de rouvrir le détail pour le refermer aussitôt.

    La même sur l'accueil et sur une journée : il n'aurait pas de sens qu'un
    chemin change de forme en route. Depuis l'accueil il n'y a que la suite,
    depuis J1 le retour ramène au parcours entier, depuis J15 il n'y a plus
    rien devant.

    Une moitié sans destination garde sa place — la barre reste coupée en deux,
    de largeur constante — mais reste vide : ni intitulé, ni chevron, ni tiret.
    Un « Suivant — » grisé annonçait une suite qui n'existe pas ; le vide, lui,
    ne promet rien. */
function gabaritNavigation(precedent, suivant) {
  // `aria-hidden` en plus de `disabled` : sans nom, ce bouton se serait
  // annoncé comme « bouton » et rien d'autre. Il ne porte aucune information,
  // il tient la moitié de la barre — les lecteurs d'écran n'ont rien à en
  // dire.
  const vide = '<button type="button" disabled aria-hidden="true"></button>';
  const destination = (cible) =>
    `<span class="navigation__long">${echapper(cible.libelle)}</span>`
    + `<span class="navigation__court">${echapper(cible.court)}</span>`;
  const texte = (cible, sens) =>
    `<span class="navigation__texte"><span class="navigation__sens">${cible.sens || sens}</span>${destination(cible)}</span>`;
  const ouvrir = (cible) => `<button type="button" data-jour="${echapper(cible.cle)}">`;

  // Les deux boutons seuls : leur bande est écrite dans `index.html`, elle ne
  // se refait pas à chaque journée.
  return `${precedent ? `${ouvrir(precedent)}<b aria-hidden="true">${precedent.icone || '←'}</b>${texte(precedent, 'Précédent')}</button>` : vide}
    ${suivant ? `${ouvrir(suivant)}${texte(suivant, 'Suivant')}<b aria-hidden="true">${suivant.icone || '→'}</b></button>` : vide}`;
}

function gabaritFiche(etape) {
  // Espace insécable entre le drapeau et le nom du pays : sur une journée qui
  // en traverse deux, la ligne peut se replier faute de place — la croix de
  // fermeture lui prend son coin droit. Qu'elle se replie est très bien, mais
  // qu'elle sépare « 🇨🇱 » de « Chili » laisserait un drapeau orphelin en bout
  // de ligne. Elle casse maintenant au point médian, entre deux pays, qui est
  // le seul endroit où la couper a un sens.
  const drapeaux = etape.pays
    .map((code) => etat.accueil.pays.find((p) => p.code === code))
    .filter(Boolean);

  // La journée dans l'ordre où on la vit : d'où l'on part, ce qu'on avale, où
  // l'on arrive. La distance sur route se déduit du reste plutôt que d'être
  // saisie — deux chiffres à tenir d'accord au lieu d'un seul finiraient par
  // diverger.
  //
  // « Dont route » ne s'affiche que s'il y a de la route. La traversée du
  // salar est intégralement en piste : la case occupait un sixième de la
  // grille pour annoncer un zéro, et sur un téléphone cette grille est déjà ce
  // qui sépare le titre du récit. Un chiffre qui ne dit rien ne vaut pas la
  // ligne qu'il coûte. « Dont piste » reste, lui, même à zéro : il répond à
  // une question qu'on se pose vraiment avant de partir — celle-là, un zéro y
  // répond.
  const kmRoute = Math.max(0, etape.km - etape.kmPiste);
  const mesures = etape.ride
    ? `<div><dt>Départ à</dt><dd>${nombre(etape.depart.altitudeM)} <small>m</small></dd></div>
       <div><dt>Distance</dt><dd>${nombre(etape.km)} <small>km</small></dd></div>
       <div><dt>Dont piste</dt><dd>${nombre(etape.kmPiste)} <small>km</small></dd></div>
       ${kmRoute ? `<div><dt>Dont route</dt><dd>${nombre(kmRoute)} <small>km</small></dd></div>` : ''}
       <div><dt>Arrivée à</dt><dd>${nombre(etape.arrivee.altitudeM)} <small>m</small></dd></div>
       ${gabaritDuree(etape, kmRoute)}`
    : `<div><dt>Étape</dt><dd>${echapper(etape.arrivee.nom)}</dd></div>
       <div><dt>Altitude</dt><dd>${nombre(etape.arrivee.altitudeM)} <small>m</small></dd></div>`;

  const profil = etape.ride
    ? `<figure class="profil-etape"><svg></svg>
         <figcaption><span>${echapper(etape.depart.nom)}</span><span>${echapper(etape.arrivee.nom)}</span></figcaption>
       </figure>`
    : '';

  const points = (etape.points || []).length
    ? `<p class="sous-titre">Sur la route</p>
       <ul class="points">${etape.points.map((point) => `
         <li class="${point.frontiere ? 'est-frontiere' : ''}${point.option ? ' est-option' : ''}">
           <button type="button" data-lat="${point.lat}" data-lon="${point.lon}">
             <span class="points__nom">${echapper(point.nom)} <em>${nombre(point.altitudeM)} m</em></span>
             <span class="points__note">${echapper(point.note)}</span>
           </button>
         </li>`).join('')}</ul>`
    : '';

  return `<div class="fiche">
    <p class="fiche__jour" data-pays="${etape.pays[etape.pays.length - 1]}"><span class="fiche__numero">J${etape.jour}</span>
      <span class="fiche__pays">· ${drapeaux.map((p) => `${p.drapeau}&nbsp;${echapper(p.nom)}`).join(' · ')}</span></p>
    <h2 class="fiche__titre">${echapper(etape.titre)}</h2>
    ${etape.ride ? '' : '<p class="fiche__repos">Journée sans moto</p>'}

    <div class="onglets" role="tablist" aria-label="Contenu de l'étape">
      <button type="button" class="onglets__bouton" role="tab" data-onglet="etape"
              id="onglet-etape" aria-controls="volet-etape">Étape</button>
      <button type="button" class="onglets__bouton" role="tab" data-onglet="souvenirs"
              id="onglet-souvenirs" aria-controls="volet-souvenirs">Carnet de route<span
              class="onglets__compte" hidden></span></button>
    </div>

    <div class="volet" data-volet="etape" id="volet-etape" role="tabpanel" aria-labelledby="onglet-etape">
      <dl class="mesures">${mesures}</dl>
      ${profil}

      <p class="recit">${echapper(etape.recit)}</p>

      ${etape.photos.length ? `<div class="galerie">${etape.photos
        .map((photo) => `<img src="${photo}" alt="" loading="lazy" tabindex="0">`).join('')}</div>` : ''}

      ${points}
    </div>

    <div class="volet" data-volet="souvenirs" id="volet-souvenirs" role="tabpanel" aria-labelledby="onglet-souvenirs">
      <div class="souvenirs" id="souvenirs-etape"></div>
    </div>
  </div>`;
}

// ------------------------------------------------------- feuille (téléphone)

// Le bouton annonce ce qu'il fera, pas l'état où l'on est : « Replier » sur une
// feuille déjà pleine se comprend, « Plein écran » sur la même feuille
// laisserait croire qu'il ne s'est rien passé au clic précédent.
//
// Ouverte, la feuille tient tout l'écran : le repli s'y dit par une croix dans
// le coin, comme sur toute fiche qu'on ferme, et non plus par un mot au bas
// d'une page dont le bas est déjà pris par la navigation. Le signe seul ne
// nommant rien, la phrase reste — en `aria-label`, pour qui n'a que la voix.
//
// Fermée, la poignée dit « + d'infos » — trois signes qui tiennent dans la
// pastille et laissent la carte respirer, là où « Détail de la journée »
// prenait la moitié du bord bas. Ce que la feuille contient, la vue le dit
// déjà : c'est la journée nommée sur la frise, ou le parcours entier quand
// aucune n'est choisie. L'énoncé, lui, garde la précision que le mot a perdue —
// une voix qui annonce « plus d'infos » sans dire sur quoi n'annonce rien.
const LIBELLES_FEUILLE = {
  fermee: {
    etape: { texte: "+ d'infos", enonce: 'Voir le détail de la journée' },
    accueil: { texte: "+ d'infos", enonce: 'Voir le détail du parcours' },
  },
  // Ouverte, la poignée n'a plus de mot : le chevron retourné dit à lui seul
  // que la feuille redescend. La phrase reste en `aria-label`, pour qui n'a
  // que la voix — un chevron ne s'énonce pas.
  pleine: { texte: '', enonce: 'Replier le détail' },
};

function libelleFeuille() {
  if (etat.feuille !== 'fermee') return LIBELLES_FEUILLE.pleine;
  return etat.jour === null ? LIBELLES_FEUILLE.fermee.accueil : LIBELLES_FEUILLE.fermee.etape;
}

/** Réaccorde la poignée à ce qu'elle ouvrirait. Appelée aussi bien quand la
    feuille bouge que quand la journée change sous elle : depuis la bande
    précédent/suivant, on passe du parcours entier à J1 sans jamais toucher à
    la feuille, et la poignée annoncerait sinon la page qu'on vient de quitter. */
function majPoignee() {
  const libelle = libelleFeuille();
  elements.poigneeTexte.textContent = libelle.texte;
  elements.poignee.setAttribute('aria-label', libelle.enonce);
}

function reglerFeuille(hauteur) {
  etat.feuille = hauteur;
  elements.panneau.classList.toggle('est-ouvert', hauteur === 'pleine');
  elements.poignee.dataset.hauteur = hauteur;
  elements.poignee.setAttribute('aria-expanded', String(hauteur !== 'fermee'));
  majPoignee();
  // `preventScroll` : sans lui, donner le focus au panneau demande au
  // navigateur de l'amener en vue — et à cet instant la feuille est encore
  // glissée sous le bord bas de la scène, qu'elle déborde donc de sa propre
  // hauteur. Le navigateur fait défiler la scène pour la rattraper, et rien ne
  // l'y ramène ensuite : la feuille et la bande précédent/suivant restent
  // échouées au milieu de l'écran, la moitié basse vide. Le défaut ne se
  // voyait qu'à la première ouverture après chargement — ensuite le panneau a
  // déjà le focus et `focus()` ne défile plus, ce qui le faisait passer pour un
  // caprice de la page d'accueil.
  if (hauteur !== 'fermee') elements.panneau.focus({ preventScroll: true });
}

// ------------------------------------------------------------- interactions

/* --------------------------------------------------------------- habillage

   Quatre jeux de couleurs, choisis par un attribut sur <html>. Le choix tient
   d'une visite à l'autre : comparer suppose de vivre avec chacun un moment,
   pas de le voir trois secondes. */

const CLE_HABILLAGE = 'salta-cusco.habillage';

function appliquerHabillage(nom) {
  if (nom) document.documentElement.dataset.habillage = nom;
  else delete document.documentElement.dataset.habillage;

  for (const bouton of document.querySelectorAll('[data-habillage]')) {
    bouton.setAttribute('aria-pressed', String(bouton.dataset.habillage === nom));
  }

  // La barre du navigateur suit l'habillage. Elle était écrite en dur dans
  // l'entête HTML, sur la valeur de « Nations » : passer en « Nuit » laissait
  // donc un bandeau blanc coiffer une page bleu nuit — exactement le défaut
  // que cette balise était censée éviter, mais dans l'autre sens.
  //
  // La couleur se relit sur le document plutôt que d'être recopiée ici :
  // quatre valeurs de plus à tenir d'accord avec la CSS auraient divergé au
  // premier habillage retouché. `--nuit` est le fond de la page, c'est-à-dire
  // ce que la barre doit prolonger.
  const barre = document.querySelector('meta[name="theme-color"]');
  if (barre) {
    const fond = getComputedStyle(document.documentElement).getPropertyValue('--nuit').trim();
    if (fond) barre.setAttribute('content', fond);
  }
  try {
    // « Nuit » n'a pas de nom d'attribut — c'est le :root — mais il lui faut un
    // nom en mémoire. Sans lui, le choisir revenait à effacer la clé, donc à
    // retrouver « Nations » à la visite suivante : le seul des quatre
    // habillages qu'on ne pouvait pas garder.
    localStorage.setItem(CLE_HABILLAGE, nom || 'nuit');
  } catch {
    // Navigation privée, stockage refusé : l'habillage vaut pour cette visite.
  }
}

function brancherHabillages() {
  for (const bouton of document.querySelectorAll('.habillages [data-habillage]')) {
    bouton.addEventListener('click', () => appliquerHabillage(bouton.dataset.habillage));
  }
  // « Nations » par défaut : c'est l'habillage qui distingue le plus ce site,
  // la couleur y portant une information plutôt qu'un décor.
  let garde = 'nations';
  try {
    const memoire = localStorage.getItem(CLE_HABILLAGE);
    if (memoire) garde = memoire === 'nuit' ? '' : memoire;
  } catch {
    // Stockage refusé : la visite commence sur l'habillage par défaut.
  }
  appliquerHabillage(garde);
}

function brancherInterface() {
  // Les photos du voyage s'ouvrent en grand comme celles des souvenirs : celles
  // des hébergements sur la fiche d'accueil, celles de l'étape dans son onglet.
  // Chaque galerie est sa propre série — on ne passe pas d'un hôtel à un col.
  //
  // Branché une seule fois, sur le panneau, qui ne change jamais d'élément :
  // le poser à chaque rendu de fiche empilerait un écouteur par étape
  // consultée. Le sélecteur ne croise pas celui des souvenirs, qui ont leur
  // propre branchement dans leur module.
  brancherVisionneuse(elements.panneau, {
    selecteur: '.vignettes img, .galerie img',
    groupe: '.vignettes, .galerie',
  });

  elements.boutonAccueil.addEventListener('click', revenirAuParcours);

  // Le titre du voyage ramène au parcours entier, comme le bouton voisin. Le
  // geste est celui qu'on attend d'un titre de site. Il reste un raccourci à
  // la souris : le bouton « Tout le parcours », lui, est atteignable au
  // clavier, et lui ajouter un second point d'arrêt pour la même action
  // encombrerait la tabulation sans rien apporter. Sur écran étroit, où ce
  // bouton est masqué faute de place, c'est « Échap » qui tient le rôle.
  elements.identite.addEventListener('click', () => {
    if (etat.jour !== null) revenirAuParcours();
  });

  for (const bouton of document.querySelectorAll('.fonds__bouton[data-fond]')) {
    bouton.addEventListener('click', () => {
      etat.carte.changerFond(bouton.dataset.fond);
      for (const autre of document.querySelectorAll('.fonds__bouton[data-fond]')) {
        autre.setAttribute('aria-pressed', String(autre === bouton));
      }
    });
  }

  // Deux hauteurs, et non plus trois. La position intermédiaire gardait la
  // carte visible, mais au prix du seul geste qui compte sur un téléphone :
  // lire la journée. Elle coupait la fiche en deux — les chiffres au-dessus du
  // bord, le récit derrière un second appui — et demandait deux fois plus de
  // défilement pour arriver au bout. « Voir le détail » ouvre donc directement
  // la feuille pleine ; la carte est à un repli de distance, et la frise, qui
  // reste seule au-dessus, permet de changer de journée sans rien replier.
  elements.poignee.addEventListener('click', () => reglerFeuille(
    etat.feuille === 'pleine' ? 'fermee' : 'pleine',
  ));

  document.addEventListener('keydown', (evenement) => {
    // La cible peut être le document lui-même, qui n'a pas de méthode matches.
    const cible = evenement.target;
    if (cible instanceof Element && cible.closest('input, textarea, select')) return;
    if (evenement.key === 'ArrowRight' || evenement.key === 'ArrowLeft') {
      evenement.preventDefault();
      decaler(evenement.key === 'ArrowRight' ? 1 : -1);
    }
    if (evenement.key === 'Escape' && etat.jour !== null) revenirAuParcours();
  });

  window.addEventListener('hashchange', () => choisir(jourDepuisAdresse(), { majAdresse: false }));

  // Le dégradé des bords suit le doigt : `passive`, parce qu'on ne fait que
  // lire une position — rien à annuler, et le défilement ne doit pas attendre.
  elements.frise.parentElement.addEventListener('scroll', () => {
    majBordsFrise();
    // Le mot des motos suit le même sort que les bords : ce qui sort de la
    // fenêtre au doigt en sort tout autant que ce qui en sort au recentrage.
    ajusterMotDeLaFrise(elements.frise);
  }, { passive: true });

  let attente;
  new ResizeObserver(() => {
    clearTimeout(attente);
    attente = setTimeout(redessinerFrise, 120);
  }).observe(elements.frise.parentElement);
}

demarrer();
