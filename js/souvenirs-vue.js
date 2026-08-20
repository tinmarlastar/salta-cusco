/* Bloc « Souvenirs des compagnons » sous le récit de chaque étape.

   Ce module possède le DOM du bloc ; il ne parle au réseau qu'à travers
   souvenirs.js et souvenirs-file.js. */

import {
  listerEtape, modifierContribution, supprimerContribution,
  compresserImage, verifierVideo, urlMedia, creerCleIdempotence, creerJetonAuteur, ErreurService,
} from './souvenirs.js';
import {
  mettreEnFile, listerFile, viderEntree, demarrerRenvoi, renvoyerMaintenant, reprendreEntree,
} from './souvenirs-file.js';

const CLE_AUTEUR = 'souvenirs.auteur';
const CLE_MOT_DE_PASSE = 'souvenirs.motDePasse';
const CLE_JETONS = 'souvenirs.jetons';

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const jetons = () => JSON.parse(localStorage.getItem(CLE_JETONS) || '{}');

// Rappel passé à `demarrerRenvoi` : c'est `traiterEntree`, dans
// souvenirs-file.js, qui l'appelle sur tout envoi en file d'attente réussi,
// avec l'identifiant attribué par le service et le jeton d'auteur — depuis
// I3, en général celui généré par la vue à la mise en file (`creerJetonAuteur`
// dans souvenirs.js), connu dès le départ et non plus tributaire d'une
// réponse fraîche du service. Le module de file n'a ni localStorage ni DOM,
// la mémorisation est bien ici, une préoccupation de la vue.
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
  // Bouton « Réessayer » (C2, revue finale) : sur toute entrée bloquée, pas
  // seulement un mot de passe refusé — c'est un rattrapage général une fois
  // la cause corrigée (mot de passe, vidéo trop lourde raccourcie, etc.).
  const reessayer = entree.bloque
    ? '<button type="button" data-action="reessayer">Réessayer</button>' : '';
  return `<article class="souvenir est-en-attente" data-local="${echapper(entree.idLocal)}">
    <p class="souvenir__entete"><b>${echapper(entree.auteur)}</b> <time>${motif}</time></p>
    ${entree.texte ? `<p class="souvenir__texte">${echapper(entree.texte)}</p>` : ''}
    <p class="souvenir__actions">${reessayer}<button type="button" data-action="abandonner">Abandonner</button></p>
  </article>`;
}

// Les champs prénom/mot de passe sont toujours présents dans le DOM (jamais
// omis) : c'est ce qui permet de les faire réapparaître dynamiquement — sans
// reconstruire tout le formulaire, ce qui perdrait le texte en cours de
// saisie — quand `souvenirs.motDePasse` est effacé après un refus (C2).
// `required` a été retiré volontairement : le gestionnaire de soumission
// valide déjà prénom et mot de passe à la main, et `required` sur un champ
// masqué (`hidden`) dépend d'un comportement de rendu peu fiable d'un
// navigateur à l'autre.
// Le champ mot de passe ne porte PAS `value` (N2, re-revue) : le cuire dans
// l'attribut le rend restaurable par `formulaire.reset()` — via
// `defaultValue`, jamais touché par le `.value = ''` de `rafraichir()` —
// ressuscitant une faute de frappe après qu'un 401 l'a effacée. `localStorage`
// reste ainsi l'unique source de vérité pour ce champ ; le prénom, lui, n'a
// pas ce risque (jamais vidé sur refus), garder son `value` est sans danger
// et évite de le redemander inutilement.
function gabaritFormulaire() {
  const auteur = localStorage.getItem(CLE_AUTEUR) || '';
  const motDePasse = localStorage.getItem(CLE_MOT_DE_PASSE) || '';
  const connue = Boolean(auteur && motDePasse);
  return `<form class="souvenir-form">
    <input class="souvenir-form__champ" name="auteur" placeholder="Votre prénom"
           value="${echapper(auteur)}" maxlength="40" ${connue ? 'hidden' : ''}>
    <input class="souvenir-form__champ" name="motDePasse" type="password"
           placeholder="Mot de passe du groupe" ${connue ? 'hidden' : ''}>
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

  // Amélioration B (re-revue) : plusieurs `rafraichir()` concurrents (celui
  // du gestionnaire de soumission et celui déclenché par `signaler()` quand
  // la file change pendant qu'on attend déjà) peuvent s'entrelacer et
  // achever dans le désordre — le plus lent écrase alors `liste.innerHTML`
  // avec un instantané périmé, laissant par exemple une carte « en attente »
  // fantôme sur un souvenir déjà publié, jusqu'au prochain événement de
  // file. Un compteur de génération simple : chaque appel se numérote à
  // l'entrée, et n'écrit plus s'il s'est fait doubler entretemps.
  let generation = 0;

  async function rafraichir() {
    const mienne = ++generation;
    // I1 (revue finale) : `listerFile` peut rejeter (IndexedDB indisponible
    // en navigation privée Firefox, délai de garde d'ouverture dépassé...).
    // Sans ce `.catch`, le rejet sortait de cette fonction avant d'atteindre
    // le filet plus bas prévu pour le service injoignable, et le bloc restait
    // bloqué sur « Chargement… » pour de bon.
    const attente = await listerFile(jour).catch(() => []);

    // C2 (revue finale) : une entrée bloquée par un 401 signifie que le mot
    // de passe mémorisé au moment de CET envoi était faux. On l'efface pour
    // que le champ réapparaisse — sinon le participant n'a plus aucun moyen
    // de le corriger. `.hidden` et `.value` sont ajustés directement (pas de
    // reconstruction du formulaire) pour ne pas perdre un texte en cours de
    // saisie.
    //
    // Comparaison au mot de passe PORTÉ PAR L'ENTRÉE (pas une simple
    // présence de `refusMotDePasse` dans la file) : trouvé pendant la
    // vérification bout en bout de la re-revue — sans cette précision, une
    // carte bloquée non résolue restait indéfiniment `refusMotDePasse: true`
    // et ce test redevenait vrai à CHAQUE `rafraichir()` ultérieur, effaçant
    // par la même occasion un mot de passe VALIDE tout juste enregistré par
    // une soumission suivante — avant même que le participant ait pu s'en
    // servir. En comparant à `entree.motDePasse` (le mot de passe tel qu'il
    // était AU MOMENT du refus, gelé sur l'entrée), l'effacement ne se
    // déclenche plus que si le mot de passe actuellement mémorisé est
    // ENCORE celui qui a été refusé — jamais un mot de passe différent saisi
    // depuis.
    const entreeRefusee = attente.find((e) => e.refusMotDePasse);
    if (entreeRefusee && localStorage.getItem(CLE_MOT_DE_PASSE) === entreeRefusee.motDePasse) {
      localStorage.removeItem(CLE_MOT_DE_PASSE);
      const champAuteur = formulaire.querySelector('[name="auteur"]');
      const champMotDePasse = formulaire.querySelector('[name="motDePasse"]');
      if (champAuteur) champAuteur.hidden = false;
      if (champMotDePasse) { champMotDePasse.hidden = false; champMotDePasse.value = ''; }
    }

    let publiees = [];
    try {
      // `listerEtape` attend `chargerConfig()` en interne avant toute requête :
      // c'est ce qui garantit que `gabaritContribution`, appelée juste après
      // avec des contributions qui ont pu porter un média, ne produit jamais
      // d'URL de média avant que la configuration ne soit chargée.
      publiees = await listerEtape(jour);
    } catch {
      if (mienne !== generation) return; // un appel plus récent a pris le dessus
      liste.innerHTML = attente.length
        ? attente.map(gabaritEnAttente).join('')
        : '<p class="souvenirs__vide">Les souvenirs ne se chargent pas pour le moment.</p>';
      return;
    }
    if (mienne !== generation) return; // un appel plus récent a pris le dessus
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
      // I3 (revue finale) : généré ici, au même endroit que la clé
      // d'idempotence — avant tout envoi — pour que le rejeu d'une réponse
      // perdue en route (le cas nominal en zone de réseau faible) n'empêche
      // plus jamais l'auteur de retrouver ses boutons Modifier/Supprimer.
      jeton: creerJetonAuteur(),
    };

    // C3 (revue finale) : `mettreEnFile` peut légitimement rejeter (quota de
    // stockage dépassé, transaction avortée, délai de garde IndexedDB). Sans
    // ce `try/catch`, le rejet partait non rattrapé, aucun message ne
    // s'affichait, et le formulaire — vidé plus bas AVANT ce correctif —
    // avait déjà fait disparaître le texte du participant. On ne vide donc le
    // formulaire QU'APRÈS la mise en file réussie.
    try {
      await mettreEnFile(entree);
    } catch (probleme) {
      souci.textContent = `Enregistrement impossible pour le moment (${probleme?.message || 'erreur inconnue'}). Le texte est conservé, réessayez.`;
      souci.hidden = false;
      return;
    }

    formulaire.reset();
    nomChoisi.textContent = '';

    // C1 (revue finale) : sans cet appel, rien ne tente l'envoi avant le
    // prochain déclencheur (retour réseau, onglet revisible, minuterie de
    // 2 min) — un participant qui poste en pleine 4G voit « En attente de
    // réseau », croit que rien n'est parti, republie, et chaque republication
    // crée un vrai doublon (nouvelle clé d'idempotence). Non attendu à
    // dessein : la file signale déjà `rafraichir` par elle-même (`signaler`)
    // quand l'entrée est retirée, inutile de bloquer ici sur un envoi qui
    // peut prendre jusqu'à 120 s (média).
    renvoyerMaintenant();
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

    if (action === 'reessayer') {
      // C2 (revue finale) : « le mot de passe courant » — celui tapé à
      // l'instant dans le champ qui vient de réapparaître prime sur celui,
      // possiblement encore absent, de `localStorage` (il n'y est réécrit
      // qu'à une soumission complète du formulaire).
      const champMotDePasse = formulaire.querySelector('[name="motDePasse"]');
      const motDePasseCourant = (champMotDePasse && champMotDePasse.value.trim())
        || localStorage.getItem(CLE_MOT_DE_PASSE) || '';
      if (!motDePasseCourant) {
        souci.textContent = 'Indiquez le mot de passe du groupe avant de réessayer.';
        souci.hidden = false;
        return;
      }
      localStorage.setItem(CLE_MOT_DE_PASSE, motDePasseCourant);
      await reprendreEntree(carte.dataset.local, motDePasseCourant);
      renvoyerMaintenant();
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
