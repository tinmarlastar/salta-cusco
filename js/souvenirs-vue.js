/* Bloc « Souvenirs des compagnons » sous le récit de chaque étape.

   Ce module possède le DOM du bloc ; il ne parle au réseau qu'à travers
   souvenirs.js et souvenirs-file.js. */

import {
  listerEtape, modifierContribution, supprimerContribution,
  compresserImage, verifierVideo, urlMedia, creerCleIdempotence, ErreurService,
} from './souvenirs.js';
import { mettreEnFile, listerFile, viderEntree, demarrerRenvoi } from './souvenirs-file.js';

const CLE_AUTEUR = 'souvenirs.auteur';
const CLE_MOT_DE_PASSE = 'souvenirs.motDePasse';
const CLE_JETONS = 'souvenirs.jetons';

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const jetons = () => JSON.parse(localStorage.getItem(CLE_JETONS) || '{}');

// Rappel passé à `demarrerRenvoi` : c'est `traiterEntree`, dans
// souvenirs-file.js, qui l'appelle quand un envoi en file d'attente réussit
// et que le service a renvoyé un jeton d'auteur (uniquement à la création :
// le module de file n'a ni localStorage ni DOM, la mémorisation est bien ici,
// une préoccupation de la vue).
function retenirJeton(id, jeton) {
  if (!jeton) return;
  const tous = jetons();
  tous[id] = jeton;
  localStorage.setItem(CLE_JETONS, JSON.stringify(tous));
}

function oublierJeton(id) {
  const tous = jetons();
  delete tous[id];
  localStorage.setItem(CLE_JETONS, JSON.stringify(tous));
}

const dateCourte = (iso) => new Date(iso).toLocaleDateString('fr-FR', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

function gabaritContribution(contribution) {
  const sien = Boolean(jetons()[contribution.id]);
  const media = contribution.media;
  const corpsMedia = !media ? '' : media.genre === 'video'
    ? `<video class="souvenir__media" src="${echapper(urlMedia(media.cle))}" controls preload="metadata"></video>`
    : `<img class="souvenir__media" src="${echapper(urlMedia(media.cle))}" alt="" loading="lazy">`;

  return `<article class="souvenir" data-id="${echapper(contribution.id)}">
    <p class="souvenir__entete">
      <b>${echapper(contribution.auteur)}</b>
      <time>${echapper(dateCourte(contribution.creeLe))}</time>
      ${contribution.modifieLe ? '<em>modifié</em>' : ''}
    </p>
    ${corpsMedia}
    ${contribution.texte ? `<p class="souvenir__texte">${echapper(contribution.texte)}</p>` : ''}
    ${sien ? `<p class="souvenir__actions">
      <button type="button" data-action="modifier">Modifier</button>
      <button type="button" data-action="supprimer">Supprimer</button>
    </p>` : ''}
  </article>`;
}

function gabaritEnAttente(entree) {
  const motif = entree.bloque
    ? `Bloqué : ${echapper(entree.dernierSouci)}`
    : 'En attente de réseau';
  return `<article class="souvenir est-en-attente" data-local="${echapper(entree.idLocal)}">
    <p class="souvenir__entete"><b>${echapper(entree.auteur)}</b> <time>${motif}</time></p>
    ${entree.texte ? `<p class="souvenir__texte">${echapper(entree.texte)}</p>` : ''}
    <p class="souvenir__actions"><button type="button" data-action="abandonner">Abandonner</button></p>
  </article>`;
}

function gabaritFormulaire() {
  const auteur = localStorage.getItem(CLE_AUTEUR) || '';
  const motDePasse = localStorage.getItem(CLE_MOT_DE_PASSE) || '';
  return `<form class="souvenir-form">
    ${auteur && motDePasse ? '' : `
      <input class="souvenir-form__champ" name="auteur" placeholder="Votre prénom"
             value="${echapper(auteur)}" maxlength="40" required>
      <input class="souvenir-form__champ" name="motDePasse" type="password"
             placeholder="Mot de passe du groupe" value="${echapper(motDePasse)}" required>`}
    <textarea class="souvenir-form__champ" name="texte" rows="2" maxlength="2000"
              placeholder="Une note, un souvenir…"></textarea>
    <p class="souvenir-form__pied">
      <label class="souvenir-form__fichier">
        Photo ou vidéo<input type="file" name="fichier" accept="image/*,video/*" hidden>
      </label>
      <span class="souvenir-form__choisi"></span>
      <button type="submit">Publier</button>
    </p>
    <p class="souvenir-form__souci" hidden></p>
  </form>`;
}

export function monterSouvenirs(conteneur, jour) {
  conteneur.innerHTML = `<p class="sous-titre">Souvenirs des compagnons</p>
    <div class="souvenirs__liste">Chargement…</div>
    ${gabaritFormulaire()}`;

  const liste = conteneur.querySelector('.souvenirs__liste');
  const formulaire = conteneur.querySelector('.souvenir-form');
  const souci = conteneur.querySelector('.souvenir-form__souci');
  const champFichier = formulaire.querySelector('[name="fichier"]');
  const nomChoisi = conteneur.querySelector('.souvenir-form__choisi');

  async function rafraichir() {
    const attente = await listerFile(jour);
    let publiees = [];
    try {
      // `listerEtape` attend `chargerConfig()` en interne avant toute requête :
      // c'est ce qui garantit que `gabaritContribution`, appelée juste après
      // avec des contributions qui ont pu porter un média, ne produit jamais
      // d'URL de média avant que la configuration ne soit chargée.
      publiees = await listerEtape(jour);
    } catch {
      liste.innerHTML = attente.length
        ? attente.map(gabaritEnAttente).join('')
        : '<p class="souvenirs__vide">Les souvenirs ne se chargent pas pour le moment.</p>';
      return;
    }
    liste.innerHTML = publiees.length || attente.length
      ? publiees.map(gabaritContribution).join('') + attente.map(gabaritEnAttente).join('')
      : '<p class="souvenirs__vide">Aucun souvenir pour cette étape. Soyez le premier.</p>';
  }

  champFichier.addEventListener('change', () => {
    const fichier = champFichier.files[0];
    nomChoisi.textContent = fichier ? fichier.name : '';
  });

  formulaire.addEventListener('submit', async (evenement) => {
    evenement.preventDefault();
    souci.hidden = true;

    const donnees = new FormData(formulaire);
    const auteur = (donnees.get('auteur') || localStorage.getItem(CLE_AUTEUR) || '').trim();
    const motDePasse = donnees.get('motDePasse') || localStorage.getItem(CLE_MOT_DE_PASSE) || '';
    const texte = (donnees.get('texte') || '').trim();
    let fichier = champFichier.files[0] || null;

    if (!auteur || !motDePasse) {
      souci.textContent = 'Indiquez votre prénom et le mot de passe du groupe.';
      souci.hidden = false;
      return;
    }
    if (!texte && !fichier) {
      souci.textContent = 'Écrivez une note ou choisissez une photo.';
      souci.hidden = false;
      return;
    }

    if (fichier && fichier.type.startsWith('video/')) {
      const refus = verifierVideo(fichier);
      if (refus) { souci.textContent = refus; souci.hidden = false; return; }
    }
    if (fichier && fichier.type.startsWith('image/')) {
      try {
        fichier = await compresserImage(fichier);
      } catch {
        // La compression a échoué : on envoie l'original plutôt que rien.
      }
    }

    localStorage.setItem(CLE_AUTEUR, auteur);
    localStorage.setItem(CLE_MOT_DE_PASSE, motDePasse);

    const entree = {
      type: fichier ? 'media' : 'note',
      jour, auteur, texte, fichier, motDePasse,
      idempotence: creerCleIdempotence(),
    };

    formulaire.reset();
    nomChoisi.textContent = '';

    // On passe systématiquement par la file : c'est elle qui tente l'envoi et
    // qui garde le souvenir si le réseau manque.
    await mettreEnFile(entree);
    await rafraichir();
  });

  liste.addEventListener('click', async (evenement) => {
    const bouton = evenement.target.closest('button[data-action]');
    if (!bouton) return;
    const carte = bouton.closest('[data-id], [data-local]');
    const action = bouton.dataset.action;

    if (action === 'abandonner') {
      await viderEntree(carte.dataset.local);
      await rafraichir();
      return;
    }

    const id = carte.dataset.id;
    const jeton = jetons()[id];
    if (!jeton) return;

    if (action === 'supprimer') {
      if (!confirm('Supprimer ce souvenir ?')) return;
      try {
        await supprimerContribution({ id, jeton });
        oublierJeton(id);
      } catch (probleme) {
        alert(probleme instanceof ErreurService ? probleme.message : 'Suppression impossible pour le moment.');
      }
      await rafraichir();
      return;
    }

    if (action === 'modifier') {
      const actuel = carte.querySelector('.souvenir__texte')?.textContent || '';
      const nouveau = prompt('Modifier le texte :', actuel);
      if (nouveau === null) return;
      try {
        await modifierContribution({ id, texte: nouveau.trim(), jeton });
      } catch (probleme) {
        alert(probleme instanceof ErreurService ? probleme.message : 'Modification impossible pour le moment.');
      }
      await rafraichir();
    }
  });

  // Idempotente côté file (écouteurs et minuterie armés une seule fois par
  // onglet) : on peut donc l'appeler à chaque affichage de fiche d'étape sans
  // rien empiler. `memoriserJeton` est ce qui permet à l'auteur de retrouver
  // ses boutons Modifier/Supprimer une fois l'entrée passée par la file.
  demarrerRenvoi({ surChangement: rafraichir, memoriserJeton: retenirJeton });
  rafraichir();
}
