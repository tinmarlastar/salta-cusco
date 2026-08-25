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
  const depart = position.depart || '';
  const decalage = position.decalage ?? 0;

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
