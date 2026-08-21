/* Page de modération : liste tout, permet de supprimer n'importe quelle entrée.

   Le mot de passe d'administration est distinct de celui du groupe et n'est
   gardé que pour la durée de l'onglet — sessionStorage, jamais localStorage,
   et jamais écrit dans le dépôt. */

import {
  chargerConfig, listerTout, supprimerContribution, urlMedia, ErreurService,
} from './souvenirs.js';

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const racine = document.getElementById('admin');
let motDePasse = sessionStorage.getItem('souvenirs.admin') || '';

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
  const apercu = !medias.length ? '' : `<div class="souvenir__galerie${medias.length > 1 ? ' est-multiple' : ''}">${
    medias.map((m) => {
      const source = echapper(urlMedia(m.cle));
      const corps = m.genre === 'video'
        ? `<video class="souvenir__media" src="${source}" controls preload="metadata"></video>`
        : `<img class="souvenir__media" src="${source}" alt="" loading="lazy">`;
      return `<figure class="souvenir__figure">${corps}</figure>`;
    }).join('')
  }</div>`;
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

  racine.innerHTML = contributions.length
    ? `<p class="sous-titre">${contributions.length} contribution(s)</p>${contributions.map(gabarit).join('')}`
    : '<p class="souvenirs__vide">Aucune contribution pour le moment.</p>';
}

// Écouteur posé une seule fois, en dehors de `afficher()`, sur `racine` — un
// conteneur stable dont seul le contenu change à chaque rendu, jamais
// l'élément lui-même. La délégation d'événement est donc suffisante : pas
// besoin de reposer l'écouteur après chaque suppression, et surtout pas avec
// `{ once: true }`, qui consommerait le tout premier clic dans la zone (sur
// une photo, un texte, n'importe où) et laisserait ensuite tous les boutons
// « Supprimer » muets.
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
if (motDePasse) afficher(); else demander();
