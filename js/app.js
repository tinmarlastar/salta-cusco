/* Orchestration : charge les données, monte la carte, la frise et le panneau,
   et garde tout le monde d'accord sur l'étape affichée.

   L'étape courante vit dans l'adresse (#j7) : chacun peut donc envoyer un lien
   vers un jour précis du voyage. */

import { creerCarte } from './carte.js';
import { assemblerVoyage, dessinerFrise, dessinerProfilEtape } from './profil.js';
import { monterSouvenirs, brancherVisionneuse } from './souvenirs-vue.js';
import { listerDecomptes } from './souvenirs.js';

const nombre = (valeur) => valeur.toLocaleString('fr-FR');
const echapper = (texte) => String(texte).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const etat = {
  etapes: [], traces: null, voyage: null, jour: null, carte: null,
  // Nombre de souvenirs par journée, pour les pastilles du bandeau.
  decomptes: {},
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
  etapePrecedente: document.getElementById('etape-precedente'),
  etapeSuivante: document.getElementById('etape-suivante'),
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
  majPasAPas(etape);
}

/** Le pas-à-pas reste visible partout : depuis l'accueil, « suivant » ouvre J1. */
function majPasAPas(etape) {
  const jours = etat.etapes.map((e) => e.jour);
  const index = etape ? jours.indexOf(etape.jour) : -1;

  // Les flèches nomment leur destination, comme la barre du bas de panneau.
  // Une flèche seule oblige à cliquer pour savoir où elle mène ; avec le nom,
  // on sait avant de partir. Depuis l'accueil, « suivant » ouvre la première
  // étape : c'est elle qu'il annonce.
  const precedente = index > 0 ? etat.etapes[index - 1] : null;
  const suivante = index === -1 ? etat.etapes[0] : etat.etapes[index + 1];
  nommerFleche(elements.etapePrecedente, '←', precedente, 'Étape précédente');
  nommerFleche(elements.etapeSuivante, '→', suivante, 'Étape suivante');

  // `disabled` n'a plus grand-chose à désactiver puisque le volet est masqué
  // quand il n'a pas de destination ; on le garde par sûreté, au cas où un
  // rendu laisserait le bouton visible.
  elements.etapePrecedente.disabled = !precedente;
  elements.etapeSuivante.disabled = !suivante;
}

/** Écrit une flèche du pas-à-pas : le chevron, puis la destination. */
function nommerFleche(bouton, chevron, cible, intitule) {
  // Sans destination — avant J1, après J15 — le volet disparaît au lieu de
  // rester en place, éteint : un bloc gris collé à « Tout le parcours » se lit
  // comme une commande en panne plutôt que comme une extrémité du voyage.
  bouton.hidden = !cible;
  if (!cible) return;

  const nom = `J${cible.jour} ${cible.arrivee.nom}`;
  const marque = `<span aria-hidden="true">${chevron}</span>`;
  const texte = `<span class="pas-a-pas__nom">${echapper(nom)}</span>`;
  // Le chevron précède le nom à gauche, le suit à droite : chacun pointe vers
  // l'extérieur du bloc, donc vers le sens du déplacement.
  bouton.innerHTML = chevron === '←' ? marque + texte : texte + marque;
  bouton.setAttribute('aria-label', `${intitule} : ${nom}`);
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
    decomptes: etat.decomptes,
  });
  amenerEtapeEnVue();
}

/** Sur un écran étroit la frise déborde : on l'amène sur l'étape choisie. */
function amenerEtapeEnVue() {
  const defilement = elements.frise.parentElement;
  if (defilement.scrollWidth <= defilement.clientWidth) return;

  const marque = elements.frise.querySelector('.est-actif');
  if (!marque) return;

  const boite = marque.getBBox ? marque.getBBox() : null;
  if (!boite) return;

  const largeurVue = elements.frise.viewBox.baseVal.width;
  if (!largeurVue) return;
  const echelle = elements.frise.getBoundingClientRect().width / largeurVue;
  // Positionnement direct plutôt qu'animé : la frise vient d'être redessinée,
  // un glissement donnerait l'impression qu'elle flotte pendant la lecture.
  const centre = (boite.x + boite.width / 2) * echelle;
  defilement.scrollLeft = centre - defilement.clientWidth / 2;
}

// ------------------------------------------------------------------ panneau

function afficherPanneau(etape) {
  elements.panneau.innerHTML = etape ? gabaritFiche(etape) : gabaritAccueil(etat.accueil);
  elements.panneau.scrollTop = 0;

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

  for (const bouton of elements.panneau.querySelectorAll('[data-jour]')) {
    bouton.addEventListener('click', () => choisir(Number(bouton.dataset.jour)));
  }
  for (const bouton of elements.panneau.querySelectorAll('[data-lat]')) {
    bouton.addEventListener('click', () => {
      etat.carte.carte.setView([Number(bouton.dataset.lat), Number(bouton.dataset.lon)], 13);
    });
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
  const mesures = [
    ['Distance', `${nombre(voyage.distanceKm)} <b>km</b>`],
    ['Dont piste', `${nombre(voyage.pisteKm)} <b>km</b>`],
    ['Point haut', `${nombre(voyage.altitudeMaxM)} <b>m</b>`],
    ['Pays', `${voyage.pays.length}`],
  ];

  return `<div class="accueil">
    <dl class="chiffres">${mesures
      .map(([titre, valeur]) => `<div><dt>${titre}</dt><dd>${valeur}</dd></div>`)
      .join('')}</dl>

    <img class="accueil__photo" src="${voyage.photo}" alt="Le salar d'Uyuni vu du ciel, traversé de traces de roues." loading="lazy">
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

function gabaritFiche(etape) {
  const precedente = etat.etapes.find((e) => e.jour === etape.jour - 1);
  const suivante = etat.etapes.find((e) => e.jour === etape.jour + 1);
  const drapeaux = etape.pays
    .map((code) => etat.accueil.pays.find((p) => p.code === code))
    .filter(Boolean);

  // La journée dans l'ordre où on la vit : d'où l'on part, ce qu'on avale, où
  // l'on arrive. La distance sur route se déduit du reste plutôt que d'être
  // saisie — deux chiffres à tenir d'accord au lieu d'un seul finiraient par
  // diverger.
  const kmRoute = Math.max(0, etape.km - etape.kmPiste);
  const mesures = etape.ride
    ? `<div><dt>Départ à</dt><dd>${nombre(etape.depart.altitudeM)} <small>m</small></dd></div>
       <div><dt>Distance</dt><dd>${nombre(etape.km)} <small>km</small></dd></div>
       <div class="${etape.kmPiste ? 'est-piste' : ''}"><dt>Dont piste</dt>
         <dd>${nombre(etape.kmPiste)} <small>km</small></dd></div>
       <div><dt>Dont route</dt><dd>${nombre(kmRoute)} <small>km</small></dd></div>
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
      <span class="fiche__pays">· ${drapeaux.map((p) => `${p.drapeau} ${echapper(p.nom)}`).join(' · ')}</span></p>
    <h2 class="fiche__titre">${echapper(etape.titre)}</h2>
    ${etape.ride ? '' : '<p class="fiche__repos">Journée sans moto</p>'}

    <div class="onglets" role="tablist" aria-label="Contenu de l'étape">
      <button type="button" class="onglets__bouton" role="tab" data-onglet="etape"
              id="onglet-etape" aria-controls="volet-etape">Étape</button>
      <button type="button" class="onglets__bouton" role="tab" data-onglet="souvenirs"
              id="onglet-souvenirs" aria-controls="volet-souvenirs">Souvenirs<span
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

    <div class="navigation">
      <button type="button" ${precedente ? `data-jour="${precedente.jour}"` : 'disabled'}>
        <b aria-hidden="true">←</b>
        <span class="navigation__texte"><span>Précédent</span>${precedente ? `J${precedente.jour} ${echapper(precedente.arrivee.nom)}` : '—'}</span></button>
      <button type="button" ${suivante ? `data-jour="${suivante.jour}"` : 'disabled'}>
        <span class="navigation__texte"><span>Suivant</span>${suivante ? `J${suivante.jour} ${echapper(suivante.arrivee.nom)}` : '—'}</span>
        <b aria-hidden="true">→</b></button>
    </div>
  </div>`;
}

// ------------------------------------------------------- feuille (téléphone)

const LIBELLES_FEUILLE = { fermee: 'Voir le détail', mi: 'Tout voir', pleine: 'Replier' };

function reglerFeuille(hauteur) {
  etat.feuille = hauteur;
  elements.panneau.classList.toggle('est-mi', hauteur === 'mi');
  elements.panneau.classList.toggle('est-ouvert', hauteur === 'pleine');
  elements.poignee.dataset.hauteur = hauteur;
  elements.poignee.setAttribute('aria-expanded', String(hauteur !== 'fermee'));
  // Le bouton annonce ce qu'il fera, pas l'état où l'on est : « Replier » sur
  // une feuille déjà pleine se comprend, « Plein écran » sur la même feuille
  // laisserait croire qu'il ne s'est rien passé au clic précédent.
  elements.poigneeTexte.textContent = LIBELLES_FEUILLE[hauteur];
  if (hauteur !== 'fermee') elements.panneau.focus();
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
  try {
    if (nom) localStorage.setItem(CLE_HABILLAGE, nom);
    else localStorage.removeItem(CLE_HABILLAGE);
  } catch {
    // Navigation privée, stockage refusé : l'habillage vaut pour cette visite.
  }
}

function brancherHabillages() {
  for (const bouton of document.querySelectorAll('.habillages [data-habillage]')) {
    bouton.addEventListener('click', () => appliquerHabillage(bouton.dataset.habillage));
  }
  let garde = '';
  try {
    garde = localStorage.getItem(CLE_HABILLAGE) || '';
  } catch {
    garde = '';
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

  elements.boutonAccueil.addEventListener('click', () => choisir(null));

  // Le titre du voyage ramène au parcours entier, comme le bouton voisin. Le
  // geste est celui qu'on attend d'un titre de site. Il reste un raccourci à
  // la souris : le bouton « Tout le parcours », lui, est atteignable au
  // clavier, et lui ajouter un second point d'arrêt pour la même action
  // encombrerait la tabulation sans rien apporter.
  elements.identite.addEventListener('click', () => {
    if (etat.jour !== null) choisir(null);
  });
  elements.etapePrecedente.addEventListener('click', () => decaler(-1));
  elements.etapeSuivante.addEventListener('click', () => decaler(1));

  for (const bouton of document.querySelectorAll('.fonds__bouton[data-fond]')) {
    bouton.addEventListener('click', () => {
      etat.carte.changerFond(bouton.dataset.fond);
      for (const autre of document.querySelectorAll('.fonds__bouton[data-fond]')) {
        autre.setAttribute('aria-pressed', String(autre === bouton));
      }
    });
  }

  // Trois hauteurs plutôt que deux. La position intermédiaire est la plus
  // utile : elle laisse voir les chiffres et la mosaïque du jour sans masquer
  // la carte, ce qui était impossible avec un simple ouvert/fermé où tout
  // consultait plein écran.
  elements.poignee.addEventListener('click', () => reglerFeuille(
    { fermee: 'mi', mi: 'pleine', pleine: 'fermee' }[etat.feuille || 'fermee'],
  ));

  document.addEventListener('keydown', (evenement) => {
    // La cible peut être le document lui-même, qui n'a pas de méthode matches.
    const cible = evenement.target;
    if (cible instanceof Element && cible.closest('input, textarea, select')) return;
    if (evenement.key === 'ArrowRight' || evenement.key === 'ArrowLeft') {
      evenement.preventDefault();
      decaler(evenement.key === 'ArrowRight' ? 1 : -1);
    }
    if (evenement.key === 'Escape' && etat.jour !== null) choisir(null);
  });

  window.addEventListener('hashchange', () => choisir(jourDepuisAdresse(), { majAdresse: false }));

  let attente;
  new ResizeObserver(() => {
    clearTimeout(attente);
    attente = setTimeout(redessinerFrise, 120);
  }).observe(elements.frise.parentElement);
}

demarrer();
