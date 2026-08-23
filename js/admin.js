/* Page de modération : liste tout, permet de supprimer n'importe quelle entrée.

   Le mot de passe d'administration est distinct de celui du groupe et n'est
   gardé que pour la durée de l'onglet — sessionStorage, jamais localStorage,
   et jamais écrit dans le dépôt. */

import {
  chargerConfig, listerTout, supprimerContribution, ErreurService,
} from './souvenirs.js';
import { gabaritGalerie, brancherVisionneuse } from './souvenirs-vue.js';

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const racine = document.getElementById('admin');
let motDePasse = sessionStorage.getItem('souvenirs.admin') || '';

// Journée choisie dans le menu ; `null` signifie « toutes ». Gardée hors de
// `afficher()`, qui redessine tout après chaque suppression : sans cela, on
// serait renvoyé à la liste complète juste après avoir supprimé, et il
// faudrait retrouver sa journée à chaque fois.
let jourChoisi = null;

/** Titres des étapes, pour nommer les journées du menu.

    « J7 » seul n'aide pas à retrouver de quel jour on parle ; « J7 · Uyuni →
    Tahua », si. Le repli est volontairement discret : si le fichier ne se
    charge pas, le menu reste utilisable avec les seuls numéros. */
let titresEtapes = new Map();

async function chargerTitres() {
  try {
    const donnees = await fetch('data/etapes.json').then((r) => r.json());
    for (const etape of donnees.etapes || []) titresEtapes.set(etape.jour, etape.titre);
  } catch {
    titresEtapes = new Map();
  }
}

/** Menu des journées, avec le nombre de contributions de chacune.

    Toutes les journées du voyage y figurent, y compris celles restées vides :
    en modération, savoir qu'un jour n'a rien reçu est une information, pas un
    trou à masquer. Le décompte est recalculé à chaque affichage, donc juste
    après une suppression. */
function gabaritMenu(contributions) {
  const parJour = new Map();
  for (const c of contributions) parJour.set(c.jour, (parJour.get(c.jour) || 0) + 1);

  // Les journées connues du parcours, plus toute journée qui porterait des
  // contributions sans figurer dans `etapes.json` — sinon elles deviendraient
  // invisibles, donc impossibles à modérer.
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

/* Tout ce qui vient d'une contribution est de la donnée non modérée : auteur,
   texte et jusqu'à la clé du média passent par `echapper`, y compris en
   position d'attribut ou d'URL — c'est cette page qui en a le plus besoin,
   puisqu'elle affiche justement ce que la modération n'a pas encore vu. */
function gabarit(contribution) {
  // Tous les fichiers, pas seulement le premier : supprimer une contribution
  // emporte tout ce qu'elle porte, et modérer à l'aveugle sur une photo
  // représentative de cinq autres n'aurait aucun sens. `media` au singulier
  // reste le repli pour un service pas encore redéployé.
  const medias = contribution.medias?.length
    ? contribution.medias
    : (contribution.media ? [contribution.media] : []);
  // Exactement la galerie du site, y compris ses vignettes vidéo : la page
  // avait sa propre version, avec des commandes de lecture que le site
  // n'affiche plus, et la règle de curseur commune aux deux y promettait un
  // agrandissement que rien ne servait. Pas de croix de retrait ici : la
  // modération supprime un souvenir entier, elle ne fait pas le tri dedans.
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

async function afficher() {
  racine.innerHTML = '<p class="souvenirs__vide">Chargement…</p>';
  let contributions;
  try {
    contributions = await listerTout(motDePasse);
  } catch (souci) {
    sessionStorage.removeItem('souvenirs.admin');
    motDePasse = '';
    // Le service distingue mot de passe faux (401) et suppression non
    // autorisée (403, rencontré plus bas) ; dans les deux cas son message est
    // déjà juste et en français, on l'affiche tel quel plutôt que d'en
    // inventer un qui risquerait de ne plus correspondre au vrai refus.
    demander(souci instanceof ErreurService ? souci.message : 'Le service ne répond pas.');
    return;
  }

  // Le menu est bâti sur la liste ENTIÈRE, la liste affichée sur le filtre :
  // les décomptes des autres journées doivent rester visibles même quand on
  // n'en regarde qu'une.
  const menu = gabaritMenu(contributions);
  const visibles = jourChoisi === null
    ? contributions
    : contributions.filter((c) => c.jour === jourChoisi);

  const corps = visibles.length
    ? `<p class="sous-titre">${visibles.length} contribution(s)</p>${visibles.map(gabarit).join('')}`
    : `<p class="souvenirs__vide">${
        jourChoisi === null
          ? 'Aucune contribution pour le moment.'
          : `Aucune contribution pour la journée ${jourChoisi}.`
      }</p>`;

  racine.innerHTML = menu + corps;
}

// Écouteur posé une seule fois, en dehors de `afficher()`, sur `racine` — un
// conteneur stable dont seul le contenu change à chaque rendu, jamais
// l'élément lui-même. La délégation d'événement est donc suffisante : pas
// besoin de reposer l'écouteur après chaque suppression, et surtout pas avec
// `{ once: true }`, qui consommerait le tout premier clic dans la zone (sur
// une photo, un texte, n'importe où) et laisserait ensuite tous les boutons
// « Supprimer » muets.
// Délégué comme le clic, et pour la même raison : `afficher()` remplace tout
// le contenu de `racine`, donc le menu lui-même, à chaque rendu.
racine.addEventListener('change', (evenement) => {
  if (!evenement.target.matches('#filtre-jour')) return;
  const valeur = evenement.target.value;
  jourChoisi = valeur === '' ? null : Number(valeur);
  afficher();
});

// Un fichier s'ouvre en grand ici comme sur le site : voir une photo en entier
// avant de décider de la supprimer est le geste même de la modération. La
// série parcourue est celle de la liste affichée — donc de la journée filtrée,
// le cas échéant.
brancherVisionneuse(racine);

racine.addEventListener('click', async (evenement) => {
  const bouton = evenement.target.closest('button[data-action="supprimer"]');
  if (!bouton) return;
  const id = bouton.closest('[data-id]').dataset.id;
  if (!confirm('Supprimer définitivement cette contribution ?')) return;
  try {
    await supprimerContribution({ id, motDePasse });
  } catch (souci) {
    alert(souci instanceof ErreurService ? souci.message : 'Le service ne répond pas, réessayez plus tard.');
    return;
  }
  afficher();
});

await chargerConfig();
await chargerTitres();
if (motDePasse) afficher(); else demander();
