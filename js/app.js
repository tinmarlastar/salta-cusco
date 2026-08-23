/* Orchestration : charge les données, monte la carte, la frise et le panneau,
   et garde tout le monde d'accord sur l'étape affichée.

   L'étape courante vit dans l'adresse (#j7) : chacun peut donc envoyer un lien
   vers un jour précis du voyage. */

import { creerCarte } from './carte.js';
import { assemblerVoyage, dessinerFrise, dessinerProfilEtape } from './profil.js';
import { monterSouvenirs } from './souvenirs-vue.js';
import { listerDecomptes } from './souvenirs.js';

const nombre = (valeur) => valeur.toLocaleString('fr-FR');
const echapper = (texte) => String(texte).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const etat = {
  etapes: [], traces: null, voyage: null, jour: null, carte: null,
  // Nombre de souvenirs par journée, pour les pastilles du bandeau.
  decomptes: {},
  // Onglet du panneau. Gardé ici, et non dans la fiche : changer de journée ne
  // doit pas ramener sur « Étape » quelqu'un qui suit les souvenirs jour après
  // jour.
  onglet: 'etape',
};

const elements = {
  eyebrow: document.getElementById('eyebrow-voyage'),
  titre: document.getElementById('titre-voyage'),
  chiffres: document.getElementById('chiffres-voyage'),
  panneau: document.getElementById('panneau'),
  frise: document.getElementById('frise'),
  poignee: document.getElementById('poignee'),
  poigneeTexte: document.getElementById('poignee-texte'),
  boutonAccueil: document.getElementById('bouton-accueil'),
  etapePrecedente: document.getElementById('etape-precedente'),
  etapeSuivante: document.getElementById('etape-suivante'),
  etapePosition: document.getElementById('etape-position'),
  journees: document.getElementById('journees'),
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

  construireJournees();
  brancherInterface();
  reglerFeuille('fermee');
  choisir(jourDepuisAdresse(), { recentrer: false });
  redessinerFrise();

  // Les pastilles arrivent après coup : le bandeau est utilisable sans elles,
  // et un service injoignable ne doit pas retarder l'affichage du parcours.
  listerDecomptes()
    .then((decomptes) => { etat.decomptes = decomptes; majJournees(); })
    .catch(() => {});

  // La grille de la page n'est mesurable qu'après le premier rendu : c'est là
  // seulement que la carte peut se cadrer sur la bonne étape.
  requestAnimationFrame(() => etat.carte.recadrer());
}

function remplirBandeau(voyage) {
  // La monture est déjà détaillée dans le panneau d'accueil : la répéter ici
  // ferait déborder le bandeau sur un téléphone.
  elements.eyebrow.textContent = `${voyage.operateur} · ${voyage.duree}`;
  elements.titre.innerHTML =
    `${echapper(voyage.titre)} <span>${echapper(voyage.sousTitre.replace('Horizons sud-américains, de ', ''))}</span>`;

  const mesures = [
    ['Distance', `${nombre(voyage.distanceKm)} <b>km</b>`],
    ['Dont piste', `${nombre(voyage.pisteKm)} <b>km</b>`],
    ['Point haut', `${nombre(voyage.altitudeMaxM)} <b>m</b>`],
    ['Pays', `${voyage.pays.length}`],
  ];
  elements.chiffres.innerHTML = mesures
    .map(([titre, valeur]) => `<div><dt>${titre}</dt><dd>${valeur}</dd></div>`)
    .join('');
}

// ---------------------------------------------------------------- sélection

function jourDepuisAdresse() {
  const trouve = /^#j(\d{1,2})$/.exec(location.hash);
  if (!trouve) return null;
  const jour = Number(trouve[1]);
  return etat.etapes.some((e) => e.jour === jour) ? jour : null;
}

function choisir(jour, { recentrer = true, majAdresse = true } = {}) {
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
  majPasAPas(etape);
  majJournees();
}

// ------------------------------------------------------- bandeau des journées

/** Construit les quinze boutons, une seule fois : seuls l'état actif et les
    pastilles changent ensuite. Les reconstruire à chaque sélection perdrait la
    position de défilement, et donc la journée qu'on venait d'amener sous le
    pouce. */
function construireJournees() {
  elements.journees.innerHTML = etat.etapes.map((etape) => `
    <button type="button" class="journees__jour" data-jour="${etape.jour}"
            title="${echapper(etape.titre)}">
      <span class="journees__numero">J${etape.jour}</span>
      <span class="journees__pastille" hidden></span>
    </button>`).join('');

  elements.journees.addEventListener('click', (evenement) => {
    const bouton = evenement.target.closest('[data-jour]');
    if (bouton) choisir(Number(bouton.dataset.jour));
  });
}

function majJournees() {
  for (const bouton of elements.journees.querySelectorAll('[data-jour]')) {
    const jour = Number(bouton.dataset.jour);
    const actif = jour === etat.jour;
    bouton.classList.toggle('est-actif', actif);
    bouton.setAttribute('aria-current', actif ? 'true' : 'false');

    const nombre = etat.decomptes[jour] || 0;
    const pastille = bouton.querySelector('.journees__pastille');
    pastille.hidden = nombre === 0;
    pastille.textContent = nombre;
    // Le nombre doit être dit, pas seulement montré : sans ça un lecteur
    // d'écran annonce « J7 7 », qu'on lit comme une seconde journée.
    bouton.setAttribute('aria-label', nombre
      ? `Jour ${jour}, ${nombre} souvenir${nombre > 1 ? 's' : ''}`
      : `Jour ${jour}`);
  }
  amenerJourneeEnVue();
}

/** Sur un écran étroit le bandeau déborde : on y amène la journée choisie. */
function amenerJourneeEnVue() {
  const actif = elements.journees.querySelector('.est-actif');
  if (!actif) return;
  if (elements.journees.scrollWidth <= elements.journees.clientWidth) return;
  const cible = actif.offsetLeft + actif.offsetWidth / 2 - elements.journees.clientWidth / 2;
  elements.journees.scrollTo({ left: cible, behavior: 'smooth' });
}

/** Le pas-à-pas reste visible partout : depuis l'accueil, « suivant » ouvre J1. */
function majPasAPas(etape) {
  const jours = etat.etapes.map((e) => e.jour);
  const index = etape ? jours.indexOf(etape.jour) : -1;

  elements.etapePosition.textContent = etape ? `J${etape.jour}` : '—';
  elements.etapePrecedente.disabled = index <= 0;
  elements.etapeSuivante.disabled = index === jours.length - 1;
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
        mosaique: elements.panneau.querySelector('#mosaique-jour'),
        // Le décompte vient de la vue des souvenirs, seule à connaître le
        // nombre réellement publié pour cette journée : il corrige la pastille
        // du bandeau, chargée une fois au démarrage, dès qu'un souvenir est
        // publié ou supprimé sans recharger la page.
        surDecompte: (nombre) => {
          etat.decomptes[etape.jour] = nombre;
          majOngletCompte(nombre);
          majJournees();
        },
      });
      // « +N » sous la mosaïque : bascule sur l'onglet qui montre tout.
      blocSouvenirs.addEventListener('souvenirs:tout-voir', () => activerOnglet('souvenirs'));
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
    bouton.addEventListener('click', () => activerOnglet(bouton.dataset.onglet));
  }
  activerOnglet(etat.onglet);
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

  return `<div class="accueil">
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
      ${voyage.hebergements.map((photo) => `<img src="${photo}" alt="" loading="lazy">`).join('')}
    </div>
  </div>`;
}

function gabaritFiche(etape) {
  const precedente = etat.etapes.find((e) => e.jour === etape.jour - 1);
  const suivante = etat.etapes.find((e) => e.jour === etape.jour + 1);
  const drapeaux = etape.pays
    .map((code) => etat.accueil.pays.find((p) => p.code === code))
    .filter(Boolean);

  const mesures = etape.ride
    ? `<div><dt>Distance</dt><dd>${nombre(etape.km)} <small>km</small></dd></div>
       <div class="${etape.kmPiste ? 'est-piste' : ''}"><dt>Dont piste</dt>
         <dd>${nombre(etape.kmPiste)} <small>km</small></dd></div>
       <div><dt>Arrivée à</dt><dd>${nombre(etape.arrivee.altitudeM)} <small>m</small></dd></div>`
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
    <p class="fiche__jour"><span class="fiche__numero">J${etape.jour}</span>
      <span>${drapeaux.map((p) => p.drapeau).join(' ')} ${drapeaux.map((p) => echapper(p.nom)).join(' · ')}</span></p>
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
      <div class="mosaique-jour" id="mosaique-jour"></div>

      <dl class="mesures">${mesures}</dl>
      ${profil}

      <p class="recit">${echapper(etape.recit)}</p>

      ${etape.photos.length ? `<div class="galerie">${etape.photos
        .map((photo) => `<img src="${photo}" alt="" loading="lazy">`).join('')}</div>` : ''}

      ${points}
    </div>

    <div class="volet" data-volet="souvenirs" id="volet-souvenirs" role="tabpanel" aria-labelledby="onglet-souvenirs">
      <div class="souvenirs" id="souvenirs-etape"></div>
    </div>

    <div class="navigation">
      <button type="button" ${precedente ? `data-jour="${precedente.jour}"` : 'disabled'}>
        <span>Précédent</span>${precedente ? `J${precedente.jour} ${echapper(precedente.arrivee.nom)}` : '—'}</button>
      <button type="button" ${suivante ? `data-jour="${suivante.jour}"` : 'disabled'}>
        <span>Suivant</span>${suivante ? `J${suivante.jour} ${echapper(suivante.arrivee.nom)}` : '—'}</button>
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

function brancherInterface() {
  elements.boutonAccueil.addEventListener('click', () => choisir(null));
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
