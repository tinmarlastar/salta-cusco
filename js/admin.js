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
  lireReglagesPosition, ecrirePosition, lireConsommation, lireVisites, ErreurService,
} from './souvenirs.js';
import { gabaritGalerie, brancherVisionneuse } from './souvenirs-vue.js';
import { brancherHabillages } from './habillage.js';

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
let position = {
  jour: null, majLe: null, mode: null, depart: null, decalage: 0,
  departPrevuPose: null, arriveePosee: null, departPrevuLe: null, arriveeLe: null,
};

// Bascule Manuel/Automatique choisie à l'écran, tant qu'elle n'a pas encore
// été enregistrée — passer sur « Automatique » n'écrit rien tant qu'aucune
// date n'est posée (voir plus bas). `null` : suivre `position.mode` tel
// quel. Remise à zéro à chaque rendu complet : un mode Automatique choisi
// puis abandonné sans date ne doit pas survivre à un changement de module.
let modeAffiche = null;

// Les compteurs Cloudflare et, le cas échéant, la raison pour laquelle on ne
// les a pas. Gardés hors de `afficher()` : ils se chargent après le premier
// rendu, et se redessinent seuls quand la réponse arrive.
let consommation = null;
let soucisConsommation = null;

// Les statistiques de fréquentation, mêmes règles que les compteurs Cloudflare.
let visites = null;
let soucisVisites = null;

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

// Une date sans heure (AAAA-MM-JJ) se découpe à la main : `new Date('2026-09-01')`
// se lit à minuit UTC et afficherait la veille à l'ouest de Greenwich. Même
// raison que dans profil.js, où la frise écrit ces mêmes dates.
const dateSeuleLisible = (iso) => {
  const [annee, mois, jour] = iso.split('-');
  return `${jour}/${mois}/${annee}`;
};

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

/** Date à annoncer sur la frise, aux deux bouts du voyage.

    Le mode automatique déduit ces dates de la date de départ ; le manuel,
    lui, ne sait rien du calendrier — d'où ce champ, qui ne paraît qu'aux
    deux moments où la frise a une phrase à dater : « Pas encore partis »
    (« Départ prévu le… ») et la dernière journée (« Nous sommes arrivés
    le… »). Ailleurs il n'y a rien à annoncer, « Nous sommes ici ! » suffit.

    Facultatif : champ laissé vide, la frise s'en tient à sa flèche sans
    date. Une date saisie puis mise de côté — on repasse à J7 — n'est pas
    effacée pour autant, elle ressortira le moment venu. */
function gabaritDateAnnoncee(jourManuel) {
  const jours = [...titresEtapes.keys()];
  const derniere = jours.length ? Math.max(...jours) : null;

  let id;
  let libelle;
  let valeur;
  if (jourManuel === null) {
    id = 'position-depart-prevu';
    libelle = 'Date de départ de Salta';
    valeur = position.departPrevuPose;
  } else if (jourManuel === derniere) {
    id = 'position-arrivee';
    libelle = 'Date de l\'arrivée';
    valeur = position.arriveePosee;
  } else {
    return '';
  }

  return `<p class="admin-filtre">
    <label for="${id}">${libelle}</label>
    <input type="date" id="${id}" class="admin-filtre__menu" value="${echapper(valeur || '')}">
  </p>`;
}

/** Menu de journée du mode manuel, et la date à annoncer quand il y en a une. */
function gabaritJourManuel() {
  // J1 ne figure pas dans le menu : ce n'est pas une étape roulée — zéro
  // kilomètre, Salta → Salta, c'est la journée de rassemblement sur place. Elle
  // se lit comme les autres sur le site, mais n'est jamais une position. Tant
  // qu'on n'a pas quitté Salta, le réglage juste est « Pas encore partis », qui
  // fait annoncer la date du départ. Voir `PREMIER_JOUR_ROULE` côté service.
  const jours = [...titresEtapes.keys()].sort((a, b) => a - b).filter((j) => j > 1);
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
    </p>
    ${gabaritDateAnnoncee(valeurCourante)}`;
}

/** Date de départ et décalage du mode automatique.

    Pas de valeur inventée pour la date : tant qu'elle est vide, rien ne
    s'enregistre — voir le gestionnaire de `change` plus bas. */
function gabaritAuto() {
  const depart = position.depart || '';
  const decalage = position.decalage ?? 0;

  return `<p class="admin-filtre">
      <label for="position-depart">Date de départ de Salta</label>
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

  const etat = position.majLe === null
    ? 'Aucune position indiquée : les motos attendent à Salta.'
    : position.jour === null
      ? `Pas encore partis d'après ce réglage : les motos attendent à Salta (réglé le ${dateLisible(position.majLe)}).`
      : `Mis à jour le ${dateLisible(position.majLe)}.`;

  // Ce que la frise annonce en ce moment, dit ici mot pour mot : c'est la
  // seule confirmation que la date saisie sort bien à l'écran — le champ,
  // lui, montre ce qui est enregistré, pas ce qui est affiché.
  const annonce = position.departPrevuLe
    ? `Frise : « Départ de Salta le ${dateSeuleLisible(position.departPrevuLe)} ».`
    : position.arriveeLe
      ? `Frise : « Nous sommes arrivés le ${dateSeuleLisible(position.arriveeLe)} ».`
      : '';

  // Deux phrases, chacune ponctuée : l'état du réglage, puis ce qu'il donne
  // à lire sur la frise.
  const note = [etat, annonce].filter(Boolean).join(' ');

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

/* Giga-octets décimaux, et non les Mo binaires de `poidsLisible` côté site.
   Ce n'est pas une inattention : les forfaits de Cloudflare sont annoncés en
   « GB », et le module `consommation.js` les compte en 10⁹ pour rester du côté
   prudent. Afficher 3,0 Gio à côté d'une part calculée sur 3,22 Go aurait fait
   douter du calcul à chaque lecture. Une jauge et son chiffre doivent compter
   dans la même unité. */
function poidsDecimal(octets) {
  // `toLocaleString` et non `toFixed` : la virgule est le séparateur décimal
  // du français, et « 11.20 Go » au milieu d'une page qui écrit « 5 000 000 »
  // avec des espaces insécables se lisait comme un chiffre venu d'ailleurs.
  const ecrire = (valeur, decimales) => valeur.toLocaleString('fr-FR', {
    minimumFractionDigits: decimales, maximumFractionDigits: decimales,
  });
  if (octets >= 1e9) return `${ecrire(octets / 1e9, 2)} Go`;
  if (octets >= 1e6) return `${ecrire(octets / 1e6, 1)} Mo`;
  return `${ecrire(Math.round(octets / 1e3), 0)} ko`;
}

const PERIODES = {
  jour: 'aujourd\u2019hui',
  mois: 'ce mois-ci',
  instantane: 'en ce moment',
};

function gabaritMesure(mesure) {
  // Une mesure que Cloudflare n'a pas su rendre porte sa raison plutôt qu'un
  // chiffre. Elle garde sa place dans la carte : une jauge manquante se voit et
  // se corrige, une mesure escamotée laisse croire qu'elle n'a jamais existé.
  if (mesure.erreur) {
    return `<div class="conso__mesure est-muette">
      <p class="conso__libelle">${echapper(mesure.libelle)}</p>
      <p class="conso__souci">${echapper(mesure.erreur)}</p>
    </div>`;
  }

  const valeur = mesure.unite === 'octets'
    ? poidsDecimal(mesure.valeur)
    : mesure.valeur.toLocaleString('fr-FR');

  // Une mesure sans plafond — le nombre de fichiers — se lit comme un simple
  // renseignement : ni jauge, ni pourcentage, rien à dépasser.
  if (!mesure.plafond) {
    return `<div class="conso__mesure">
      <p class="conso__libelle">${echapper(mesure.libelle)}</p>
      <p class="conso__valeur">${echapper(valeur)}
        <span class="conso__periode">${PERIODES[mesure.periode] || ''}</span></p>
    </div>`;
  }

  const plafond = mesure.unite === 'octets'
    ? poidsDecimal(mesure.plafond)
    : mesure.plafond.toLocaleString('fr-FR');
  const pourcent = mesure.part < 0.01 && mesure.valeur > 0
    ? '<1 %'
    : `${Math.round(mesure.part * 100)} %`;
  // La barre s'arrête à 100 % même quand la valeur dépasse : au-delà, c'est le
  // mot « dépassé » qui le dit, une barre plus longue que sa piste ne dirait
  // rien de plus et déborderait de la carte.
  const largeur = Math.min(1, mesure.part) * 100;
  const alerte = { proche: 'proche du plafond', depasse: 'plafond dépassé' }[mesure.niveau];

  // Le POURCENTAGE en grand, la valeur brute en dessous. C'est lui qui répond à
  // la question qu'on se pose en ouvrant cette page — « suis-je encore dans le
  // gratuit ? » — quand « 84 000 » ne veut rien dire sans son plafond à côté.
  return `<div class="conso__mesure est-${mesure.niveau}">
    <p class="conso__libelle">${echapper(mesure.libelle)}
      <span class="conso__periode">${PERIODES[mesure.periode] || ''}</span></p>
    <p class="conso__valeur">${pourcent}</p>
    <p class="conso__detail">${echapper(valeur)} sur ${echapper(plafond)}</p>
    <div class="conso__jauge" role="img"
         aria-label="${pourcent} du forfait ${echapper(mesure.libelle)}">
      <span class="conso__part" style="width:${largeur.toFixed(1)}%"></span>
    </div>
    ${alerte ? `<p class="conso__alerte">${alerte}</p>` : ''}
  </div>`;
}

function gabaritModuleConsommation() {
  if (soucisConsommation) {
    return `<p class="souvenirs__vide">${echapper(soucisConsommation)}</p>`;
  }
  if (!consommation) return '<p class="souvenirs__vide">Lecture des compteurs\u2026</p>';

  const releve = new Date(consommation.releveLe).toLocaleString('fr-FR', {
    dateStyle: 'long', timeStyle: 'short',
  });
  const services = (consommation.services || []).map((service) => `
    <section class="conso__service">
      <h2 class="conso__nom">${echapper(service.nom)}</h2>
      ${service.mesures.map(gabaritMesure).join('')}
    </section>`).join('');

  return `<div class="conso">
    ${services}
    <p class="conso__pied">Relevé le ${echapper(releve)}. Les forfaits sont ceux de
      l\u2019offre gratuite de Cloudflare ; les compteurs des Workers et de D1 se
      remettent à zéro à minuit UTC, ceux de R2 au premier du mois.</p>
  </div>`;
}

/** Va chercher les compteurs et redessine le module, s'il est encore à l'écran.

    Lancée sans être attendue : la page ne doit pas retarder la modération pour
    un chiffre. Le test sur l’onglet évite qu’une réponse lente ne vienne
    écraser un module que l’on a quitté entre-temps. */
async function chargerConsommation() {
  try {
    consommation = await lireConsommation(motDePasse);
    soucisConsommation = null;
  } catch (souci) {
    // Le service répond déjà en français et nomme la cause — secret absent,
    // jeton refusé, champ inconnu de Cloudflare. Le réécrire ici ferait perdre
    // la seule information qui permette de corriger. Ce qu'on n'affiche pas,
    // c'est une panne de TRANSPORT : elle ne porte qu'un « Failed to fetch »
    // de navigateur. Le statut fait la différence — il n'existe que si le
    // service a parlé (voir `ErreurReseau` dans souvenirs.js).
    soucisConsommation = souci?.statut
      ? souci.message
      : 'Le service ne répond pas, réessaie plus tard.';
  }
  if (ongletAdmin !== 'consommation') return;
  const contenu = racine.querySelector('.admin-contenu');
  if (contenu) contenu.innerHTML = gabaritModuleConsommation();
}

/* Le module Visites. Mêmes cartes que Consommation — c'est la même page et le
   même geste, on vient y lire des chiffres — mais sans jauge : il n'y a pas de
   plafond à la fréquentation, et une barre qui se remplit y aurait suggéré un
   quota inexistant. */

const dateCourteFr = (aaaaMmJj) => {
  const [, mois, jour] = aaaaMmJj.split('-');
  return `${jour}/${mois}`;
};

function gabaritChiffre(libelle, valeur, precision) {
  return `<div class="conso__mesure">
    <p class="conso__libelle">${echapper(libelle)}
      <span class="conso__periode">${echapper(precision)}</span></p>
    <p class="conso__valeur">${valeur.toLocaleString('fr-FR')}</p>
  </div>`;
}

/* La série des jours, en barres verticales : c'est la forme d'une
   fréquentation, et elle répond du même coup à « est-ce que ça monte ? », ce
   qu'une liste de nombres ne dit qu'au prix d'une lecture ligne à ligne.
   Rapportée au jour le plus fréquenté, comme le classement des étapes : au
   total, aucune barre ne serait visible. */
function gabaritSerie(jours) {
  if (!jours.length) return '';
  const sommet = Math.max(...jours.map((j) => j.pages), 1);
  const barres = jours.map((j) => {
    const hauteur = Math.max(2, (j.pages / sommet) * 100);
    const titre = `${dateCourteFr(j.date)} — ${j.visiteurs} visiteur${j.visiteurs > 1 ? 's' : ''}, ${j.pages} page${j.pages > 1 ? 's' : ''}`;
    return `<div class="visites__barre" style="height:${hauteur.toFixed(1)}%" title="${echapper(titre)}"></div>`;
  }).join('');

  return `<section class="conso__service">
    <h2 class="conso__nom">Jour après jour</h2>
    <div class="visites__serie" role="img"
         aria-label="Fréquentation quotidienne du ${echapper(dateCourteFr(jours[0].date))} au ${echapper(dateCourteFr(jours[jours.length - 1].date))}">
      ${barres}
    </div>
    <p class="visites__bornes">
      <span>${echapper(dateCourteFr(jours[0].date))}</span>
      <span>${echapper(dateCourteFr(jours[jours.length - 1].date))}</span>
    </p>
  </section>`;
}

function nomEtape(numero) {
  if (numero === 0) return 'Accueil — le parcours entier';
  const titre = titresEtapes.get(numero);
  return titre ? `J${numero} · ${titre}` : `J${numero}`;
}

function gabaritEtapesLues(etapes) {
  if (!etapes.length) return '';
  const lignes = etapes.map((e) => `
    <div class="visites__etape">
      <p class="visites__etape-nom">${echapper(nomEtape(e.etape))}
        <span class="conso__periode">${e.pages.toLocaleString('fr-FR')}</span></p>
      <div class="conso__jauge"><span class="conso__part" style="width:${(e.part * 100).toFixed(1)}%"></span></div>
    </div>`).join('');

  return `<section class="conso__service">
    <h2 class="conso__nom">Les étapes les plus lues</h2>
    ${lignes}
  </section>`;
}

function gabaritModuleVisites() {
  if (soucisVisites) return `<p class="souvenirs__vide">${echapper(soucisVisites)}</p>`;
  if (!visites) return '<p class="souvenirs__vide">Lecture des visites\u2026</p>';

  if (!visites.total.pages) {
    return `<p class="souvenirs__vide">Aucune visite enregistrée pour le moment.
      Le compteur démarre à la première page ouverte après la mise en ligne.</p>`;
  }

  return `<div class="conso">
    <section class="conso__service">
      <h2 class="conso__nom">Depuis le début</h2>
      ${gabaritChiffre('Visiteurs', visites.total.visiteurs, 'uniques par jour, cumulés')}
      ${gabaritChiffre('Pages vues', visites.total.pages, 'toutes journées confondues')}
    </section>
    <section class="conso__service">
      <h2 class="conso__nom">Aujourd\u2019hui</h2>
      ${gabaritChiffre('Visiteurs', visites.aujourdhui.visiteurs, 'depuis minuit, heure de Paris')}
      ${gabaritChiffre('Pages vues', visites.aujourdhui.pages, 'depuis minuit')}
    </section>
    ${gabaritSerie(visites.jours)}
    ${gabaritEtapesLues(visites.etapes)}
    <p class="conso__pied">Aucune adresse IP, aucun cookie, aucune empreinte : le
      navigateur retient chez lui qu\u2019il a d\u00e9j\u00e0 \u00e9t\u00e9 compt\u00e9 aujourd\u2019hui et n\u2019envoie
      qu\u2019un \u00ab\u00a0+1\u00a0\u00bb anonyme. Une m\u00eame \u00e9tape rouverte dans la m\u00eame visite ne compte
      qu\u2019une fois.</p>
  </div>`;
}

async function chargerVisites() {
  try {
    visites = await lireVisites(motDePasse);
    soucisVisites = null;
  } catch (souci) {
    soucisVisites = souci?.statut
      ? souci.message
      : 'Le service ne répond pas, réessaie plus tard.';
  }
  if (ongletAdmin !== 'visites') return;
  const contenu = racine.querySelector('.admin-contenu');
  if (contenu) contenu.innerHTML = gabaritModuleVisites();
}

function gabaritNav() {
  const entree = (cle, libelle) => `<button type="button" class="admin-nav__bouton"
    data-onglet-admin="${cle}" aria-pressed="${ongletAdmin === cle}">${libelle}</button>`;
  return `<nav class="admin-nav" aria-label="Modules de l'administration">
    ${entree('position', 'Où en sont les motos')}
    ${entree('souvenirs', 'Modération')}
    ${entree('visites', 'Visites')}
    ${entree('consommation', 'Consommation')}
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

  let module;
  if (ongletAdmin === 'position') module = gabaritModulePosition();
  else if (ongletAdmin === 'consommation') module = gabaritModuleConsommation();
  else if (ongletAdmin === 'visites') module = gabaritModuleVisites();
  else module = gabaritModuleModeration(contributions);

  racine.innerHTML = `<div class="admin-mise-en-page">
    ${gabaritNav()}
    <div class="admin-contenu">${module}</div>
  </div>`;

  // Volontairement non attendu : les compteurs arrivent après le reste et se
  // posent d'eux-mêmes. Les attendre ici aurait fait patienter devant une page
  // vide pour un chiffre dont la modération n'a que faire.
  if (ongletAdmin === 'consommation') chargerConsommation();
  if (ongletAdmin === 'visites') chargerVisites();
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
    } else if (position.depart) {
      await enregistrerPosition({ mode: 'auto', depart: position.depart, decalage: position.decalage ?? 0 });
    } else {
      // Rien à enregistrer avant qu'une date ne soit choisie : on affiche
      // juste le formulaire, à remplir.
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
      alert(souci instanceof ErreurService ? souci.message : 'Le service ne répond pas, réessaie plus tard.');
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

  // Les deux dates annoncées s'enregistrent chacune pour soi, sans toucher
  // à la journée : le mode renvoyé est celui qui est déjà à l'écran — le
  // champ n'existe pas ailleurs — et le service, lui, ne modifie que ce que
  // la requête porte.
  if (evenement.target.matches('#position-depart-prevu')) {
    await enregistrerPosition({ mode: null, departPrevuLe: evenement.target.value || null });
    return;
  }

  if (evenement.target.matches('#position-arrivee')) {
    await enregistrerPosition({
      mode: 'manuel', jour: position.jour, arriveeLe: evenement.target.value || null,
    });
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

// L'habillage se pose avant le premier chargement réseau : il ne dépend que du
// stockage local, et attendre le service pour peindre la page aurait laissé
// l'entête sur l'habillage par défaut le temps d'un aller-retour.
brancherHabillages();

await chargerConfig();
await chargerTitres();
if (motDePasse) afficher(); else demander();
