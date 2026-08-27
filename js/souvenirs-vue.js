/* Bloc des souvenirs, dans l'onglet du même nom de chaque étape.

   Ce module possède le DOM du bloc ; il ne parle au réseau qu'à travers
   souvenirs.js et souvenirs-file.js. */

import {
  listerEtape, modifierContribution, supprimerContribution, supprimerFichier,
  compresserImage, verifierVideo, urlMedia, creerCleIdempotence, creerJetonAuteur, ErreurService,
} from './souvenirs.js';
import {
  mettreEnFile, listerFile, viderEntree, demarrerRenvoi, renvoyerMaintenant, reprendreEntree,
  progressionEnvoi,
} from './souvenirs-file.js';

const CLE_AUTEUR = 'souvenirs.auteur';
const CLE_MOT_DE_PASSE = 'souvenirs.motDePasse';
const CLE_JETONS = 'souvenirs.jetons';

// Nombre d'échecs au-delà duquel une entrée cesse de se dire passagère. Trois,
// et non un : sur le réseau visé, les deux premiers ratés sont la normale, et
// afficher un motif technique à chacun ferait passer pour une panne ce que la
// file d'attente sait très bien rattraper toute seule.
const ESSAIS_AVANT_AVEU = 3;

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

/** Un fichier d'un souvenir publié, avec sa croix de retrait pour son auteur. */
function gabaritUnMedia(media, sien) {
  const source = echapper(urlMedia(media.cle));
  // Dans la galerie, une vidéo est une vignette et rien d'autre : pas de
  // commandes de lecture. Elles obligeaient à réserver le clic à un petit
  // bouton d'agrandissement, alors qu'une photo s'ouvrait sur toute sa
  // surface — deux gestes différents pour la même intention. Sans commandes,
  // tout s'ouvre pareil, et la vidéo se joue en grand, ce qui vaut de toute
  // façon mieux qu'un lecteur dans une case de grille.
  //
  // `#t=0.1` force l'affichage d'une image au lieu d'un rectangle noir sur
  // Safari iOS — soit exactement les téléphones du voyage. La vraie adresse
  // est gardée à part, pour que la visionneuse ne reparte pas de ce fragment.
  const corps = media.genre === 'video'
    ? `<video class="souvenir__media" src="${source}#t=0.1" data-source="${source}"
              preload="metadata" muted playsinline tabindex="0"></video>
       <span class="souvenir__lecture" aria-hidden="true">▶</span>`
    : `<img class="souvenir__media" src="${source}" alt="" loading="lazy" tabindex="0">`;
  // Sans ce retrait, une photo ajoutée par erreur obligerait à supprimer le
  // souvenir entier — texte et autres photos comprises.
  const retirer = sien
    ? `<button type="button" class="souvenir__retirer" data-action="retirer-media"
               data-media="${echapper(media.id)}" aria-label="Retirer ce fichier">×</button>`
    : '';
  return `<figure class="souvenir__figure">${corps}${retirer}</figure>`;
}

/** Galerie d'un souvenir, telle qu'elle s'affiche sur le site.

    Exportée pour la page de modération : elle montrait ses vidéos avec leurs
    commandes de lecture alors que le site les présente en vignettes, et la
    règle de curseur — commune aux deux pages — y promettait un agrandissement
    que rien ne servait. Deux gabarits pour la même chose finissaient
    fatalement par diverger. */
export function gabaritGalerie(medias, { avecRetraits = false } = {}) {
  if (!medias.length) return '';
  return `<div class="souvenir__galerie${medias.length > 1 ? ' est-multiple' : ''}">
      ${medias.map((m) => gabaritUnMedia(m, avecRetraits)).join('')}
    </div>`;
}

/** Fichiers d'une publication, dans l'ordre où ils sont à l'écran.

    Relevé au moment du clic plutôt que tenu à jour : la liste est reconstruite
    à chaque rafraîchissement, un index mémorisé y désignerait vite autre
    chose. */
function serieDe(conteneur, selecteur) {
  return [...conteneur.querySelectorAll(selecteur)].map((element) => ({
    // `data-source` pour une vidéo : son `src` de vignette porte le fragment
    // `#t=0.1` qui n'a rien à faire en plein écran.
    source: element.dataset.source || element.getAttribute('src') || '',
    genre: element.tagName === 'VIDEO' ? 'video' : 'image',
    element,
  }));
}

/** Rend cliquables les fichiers d'un conteneur : clic ou Entrée les ouvrent
    en grand, et les flèches circulent dans les fichiers de LA PUBLICATION
    cliquée — pas au-delà.

    Le conteneur ne sert qu'à la délégation : c'est un élément stable dont seul
    le contenu change, si bien que rien n'est à reposer après un rendu. */
export function brancherVisionneuse(conteneur, {
  selecteur = '.souvenir__media',
  groupe = '.souvenir',
} = {}) {
  function ouvrirDepuis(vise) {
    if (!vise) return;
    // La série est celle du groupe qui entoure l'image — une publication pour
    // les souvenirs, une galerie pour les photos du voyage. Repli sur le
    // conteneur quand il n'y a pas de groupe : la visionneuse continue de
    // fonctionner plutôt que de rester muette.
    const bloc = vise.closest(groupe) || conteneur;
    const fichiers = serieDe(bloc, selecteur);
    const depart = fichiers.findIndex((f) => f.element === vise);
    if (depart >= 0) ouvrirVisionneuse(fichiers, depart);
  }

  conteneur.addEventListener('click', (evenement) => {
    ouvrirDepuis(evenement.target.closest(selecteur));
  });

  // Au clavier : une vignette est atteignable par tabulation, elle doit donc
  // s'ouvrir à l'Entrée comme un bouton.
  conteneur.addEventListener('keydown', (evenement) => {
    if (evenement.key !== 'Enter' && evenement.key !== ' ') return;
    const vise = evenement.target.closest?.(selecteur);
    if (!vise) return;
    evenement.preventDefault();
    ouvrirDepuis(vise);
  });
}

function gabaritContribution(contribution) {
  const sien = Boolean(jetons()[contribution.id]);
  // `medias` depuis que plusieurs fichiers sont possibles ; `media` au
  // singulier reste le repli pour une réponse servie par un service pas
  // encore redéployé.
  const medias = contribution.medias?.length
    ? contribution.medias
    : (contribution.media ? [contribution.media] : []);
  const corpsMedia = gabaritGalerie(medias, { avecRetraits: sien });

  return `<article class="souvenir" data-id="${echapper(contribution.id)}">
    <p class="souvenir__entete">
      <b>${echapper(contribution.auteur)}</b>
      <time>${echapper(dateCourte(contribution.creeLe))}</time>
      ${contribution.modifieLe ? '<em>modifié</em>' : ''}
    </p>
    ${corpsMedia}
    ${contribution.texte ? `<p class="souvenir__texte">${echapper(contribution.texte)}</p>` : ''}
    ${sien ? `<p class="souvenir__actions">
      <button type="button" data-action="ajouter-media">Ajouter une photo</button>
      <button type="button" data-action="modifier">Modifier</button>
      <button type="button" data-action="supprimer">Supprimer</button>
    </p>` : ''}
  </article>`;
}

/** Poids d'un fichier en attente, pour dire à l'auteur qu'il est bien gardé. */
function poidsLisible(octets) {
  if (!octets) return '';
  return octets >= 1024 * 1024
    ? `${(octets / (1024 * 1024)).toFixed(1)} Mo`
    : `${Math.max(1, Math.round(octets / 1024))} Ko`;
}

/** Ce que fait réellement une entrée en attente, en toutes lettres.

    « En attente de réseau » était écrit sur tout ce qui n'était pas bloqué :
    aussi bien sur un envoi en plein vol que sur une entrée qui patiente entre
    deux tentatives, réseau parfaitement disponible. Les deux cas les plus
    inquiétants — une vidéo qui met quatre minutes à monter, un envoi qui
    vient d'être coupé — étaient précisément ceux que le libellé décrivait le
    plus mal, au point de donner envie de tout recommencer et de créer un
    doublon. */
function motifEnAttente(entree, progression) {
  if (entree.bloque) return `Bloqué : ${echapper(entree.dernierSouci)}`;

  const enVol = progression && progression.idLocal === entree.idLocal;
  if (enVol) {
    // Le décompte n'a de sens qu'à partir de deux fichiers, et seulement une
    // fois la contribution créée : pendant sa création, rien ne monte encore.
    return progression.phase === 'fichier' && progression.total > 1
      ? `Envoi en cours · ${progression.envoyes + 1} sur ${progression.total}`
      : 'Envoi en cours…';
  }

  // `navigator.onLine` ne prouve pas qu'Internet répond — seulement qu'une
  // interface est active — mais son « faux » est fiable : à false, on est
  // certainement hors réseau.
  if (!navigator.onLine) return 'Hors réseau, repart tout seul';
  // Un envoi qui a échoué deux ou trois fois, c'est le réseau des Andes qui
  // fait son métier : « nouvel essai automatique » dit exactement ce qu'il
  // faut, et nommer une panne passagère n'apporterait que de l'inquiétude.
  // Au-delà, ce n'est plus un creux de réseau : le service refuse toujours la
  // même chose, et le rassurant « nouvel essai automatique » devient un
  // mensonge qui peut durer des jours — l'envoi repart bien toutes les cinq
  // minutes, sans jamais aboutir, et rien ne dit pourquoi. On dit alors ce que
  // le service a réellement répondu : c'est la seule trace exploitable pour
  // qui doit corriger, et le seul moyen pour l'auteur de comprendre que son
  // téléphone n'y est pour rien.
  if (entree.tentatives >= ESSAIS_AVANT_AVEU && entree.dernierSouci) {
    return `${entree.tentatives} essais sans succès : ${echapper(entree.dernierSouci)}`;
  }
  if (entree.tentatives > 0) return 'Envoi interrompu, nouvel essai automatique';
  return "En attente d'envoi";
}

function gabaritEnAttente(entree, progression) {
  const motif = motifEnAttente(entree, progression);
  // Bouton « Réessayer » (C2, revue finale) : sur toute entrée bloquée, pas
  // seulement un mot de passe refusé — c'est un rattrapage général une fois
  // la cause corrigée (mot de passe, vidéo trop lourde raccourcie, etc.).
  //
  // Et, depuis, sur une entrée qui échoue encore et encore sans être bloquée
  // pour autant : elle repart bien toute seule, mais toutes les cinq minutes
  // au mieux. Une fois la cause corrigée — ou simplement pour savoir tout de
  // suite si ça passe enfin —, n'avoir aucun moyen d'agir est ce qui donne
  // envie de tout recommencer, donc de créer un doublon.
  const echoueToujours = !entree.bloque && entree.tentatives >= ESSAIS_AVANT_AVEU;
  const reessayer = entree.bloque || echoueToujours
    ? '<button type="button" data-action="reessayer">Réessayer</button>' : '';

  // Le fichier voyage avec l'entrée depuis la mise en file : il n'a jamais
  // besoin d'être resélectionné. Mais rien ne le montrait, et une carte qui
  // n'affiche que du texte donne à croire que la photo est perdue — d'où
  // l'envie bien naturelle de tout recommencer, ce qui crée un doublon.
  const fichiers = entree.fichiers || (entree.fichier ? [entree.fichier] : []);
  const envoyes = entree.fichiersEnvoyes || 0;
  let jointe = '';
  if (fichiers.length === 1) {
    jointe = `<p class="souvenir__jointe">${echapper(fichiers[0].name || 'Fichier joint')} · ${poidsLisible(fichiers[0].size)} · conservé</p>`;
  } else if (fichiers.length > 1) {
    const total = fichiers.reduce((somme, f) => somme + (f.size || 0), 0);
    // La progression compte : sur une série de vidéos, savoir que 7 des 9
    // sont passées évite de croire l'envoi bloqué et de tout recommencer.
    const avancement = envoyes > 0 && envoyes < fichiers.length
      ? ` · ${envoyes} envoyé${envoyes > 1 ? 's' : ''}`
      : ' · conservés';
    jointe = `<p class="souvenir__jointe">${fichiers.length} fichiers · ${poidsLisible(total)}${avancement}</p>`;
  }

  // Reprise après mot de passe refusé, entièrement DANS la carte. Le
  // formulaire du bas est celui d'un NOUVEAU souvenir : y renvoyer l'auteur
  // pour corriger un envoi existant lui présentait des champs vides et lui
  // faisait croire qu'il devait tout ressaisir. Ici, le texte et le fichier
  // sont sous ses yeux, le prénom est déjà connu, et il ne reste
  // littéralement qu'une chose à taper.
  const reprise = entree.refusMotDePasse ? `
    <p class="souvenir__consigne">Mot de passe incorrect, retapez-le pour publier.</p>
    <input class="souvenir__mot-de-passe" type="password" data-role="motDePasse"
           placeholder="Mot de passe du groupe" autocomplete="current-password">` : '';

  // `est-refusee` rend sa pleine opacité à la carte : l'atténuation de
  // `est-en-attente` dit « ça part tout seul, laissez faire », exactement le
  // contraire du message ici, et elle délaverait le champ dans lequel on
  // demande de taper.
  // `est-en-vol` : une entrée qui monte en ce moment ne doit pas être grisée
  // comme celles qui patientent — c'est justement celle dont on veut suivre
  // l'avancement des yeux.
  const enVol = Boolean(progression && progression.idLocal === entree.idLocal);
  const classes = `souvenir est-en-attente${entree.refusMotDePasse ? ' est-refusee' : ''}${enVol ? ' est-en-vol' : ''}`;
  // Le mot de passe de groupe n'autorise QUE la création de la contribution.
  // Une entrée qui a déjà la sienne — une photo ajoutée à un souvenir publié,
  // ou un envoi repris après que la note est passée — s'autorise avec le jeton
  // d'auteur et n'a plus rien à en faire. Sans ce drapeau, « Réessayer »
  // réclamait un mot de passe qui ne servait à rien, et refusait de repartir
  // tant qu'on ne l'avait pas tapé.
  const besoinMotDePasse = entree.contributionId ? '0' : '1';
  return `<article class="${classes}" data-local="${echapper(entree.idLocal)}" data-besoin-mdp="${besoinMotDePasse}">
    <p class="souvenir__entete"><b>${echapper(entree.auteur)}</b> <time>${motif}</time></p>
    ${entree.texte ? `<p class="souvenir__texte">${echapper(entree.texte)}</p>` : ''}
    ${jointe}
    ${reprise}
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
/** Ligne de statut : lire ou publier, et sous quel nom.

    Deux états, nommés d'après le vocabulaire du site (« Souvenirs des
    compagnons ») :
      - Visiteur   : aucun mot de passe en mémoire, on peut tout lire, publier
                     le demandera.
      - Compagnon  : un mot de passe est en mémoire, on publie sans rien
                     retaper — et on voit enfin sous quel prénom.

    « Compagnon » veut dire « un mot de passe est mémorisé », ce qui vaut
    « correct » en pratique : un refus du service l'efface aussitôt (voir la
    branche de refus dans `rafraichir`), et le statut retombe de lui-même à
    Visiteur. Le seul écart tient aux quelques secondes entre l'envoi et la
    réponse du service, où un mot de passe encore inconnu est déjà affiché
    comme bon. */
function gabaritStatut() {
  const auteur = localStorage.getItem(CLE_AUTEUR) || '';
  const compagnon = Boolean(auteur && localStorage.getItem(CLE_MOT_DE_PASSE));
  if (!compagnon) {
    return `<span class="souvenir-form__badge">Visiteur</span>
      <span class="souvenir-form__statut-detail">lecture seule — le mot de passe du groupe te sera demandé pour publier</span>`;
  }
  return `<span class="souvenir-form__badge est-compagnon">Compagnon</span>
    <span class="souvenir-form__statut-detail">tu publies en tant que <b>${echapper(auteur)}</b></span>
    <button type="button" class="souvenir-form__changer" data-action="changer-identite">Changer</button>`;
}

function gabaritFormulaire() {
  const auteur = localStorage.getItem(CLE_AUTEUR) || '';
  const motDePasse = localStorage.getItem(CLE_MOT_DE_PASSE) || '';
  const connue = Boolean(auteur && motDePasse);
  return `<form class="souvenir-form">
    <p class="souvenir-form__statut">${gabaritStatut()}</p>
    <input class="souvenir-form__champ" name="auteur" placeholder="Ton prénom"
           value="${echapper(auteur)}" maxlength="40" ${connue ? 'hidden' : ''}>
    <input class="souvenir-form__champ" name="motDePasse" type="password"
           placeholder="Mot de passe du groupe" ${connue ? 'hidden' : ''}>
    <!-- « Un mot, une photo… » nommait les pièces à fournir, pas ce qu'on
         attend : une consigne de formulaire devant une page blanche. Celui-ci
         donne le ton du carnet et pousse à écrire. Le carnet tutoie d'un bout
         à l'autre — ce sont quinze personnes qui ont roulé ensemble, et un
         « Balancez votre prose » les aurait reçues comme des inconnues. -->
    <textarea class="souvenir-form__champ" name="texte" rows="4" maxlength="5000"
              placeholder="Balance ta prose ici…"></textarea>
    <ul class="souvenir-form__fichiers" hidden></ul>
    <p class="souvenir-form__pied">
      <label class="souvenir-form__fichier">
        Photos ou vidéos<input type="file" name="fichier" accept="image/*,video/*" multiple hidden>
      </label>
      <span class="souvenir-form__choisi"></span>
      <button type="submit">Publier</button>
    </p>
    <p class="souvenir-form__souci" hidden></p>
  </form>`;
}

/* ------------------------------------------------------------ visionneuse

   Plein écran au clic sur un fichier, avec passage de l'un à l'autre.

   La série parcourue est celle d'UNE publication : on feuillette les photos
   d'un même souvenir, et l'on s'arrête à sa dernière. Enchaîner sur le
   souvenir suivant ferait passer d'un auteur et d'un moment à un autre sans
   que rien ne le signale, alors que le compteur laisse croire qu'on est
   toujours dans la même série.

   Un seul élément pour toute la page, créé au premier usage : quinze étapes
   consultées dans la soirée ne doivent pas laisser quinze visionneuses dans le
   document. */

let visionneuse = null;
let serie = [];
let position = 0;
let elementRendu = null; // ce qui avait le focus avant l'ouverture

function construireVisionneuse() {
  if (visionneuse) return visionneuse;
  visionneuse = document.createElement('div');
  visionneuse.className = 'visionneuse';
  visionneuse.hidden = true;
  visionneuse.setAttribute('role', 'dialog');
  visionneuse.setAttribute('aria-modal', 'true');
  visionneuse.setAttribute('aria-label', 'Photo ou vidéo en grand');
  visionneuse.innerHTML = `
    <button type="button" class="visionneuse__fermer" data-vis="fermer" aria-label="Fermer">×</button>
    <button type="button" class="visionneuse__fleche est-avant" data-vis="avant" aria-label="Précédent">‹</button>
    <div class="visionneuse__scene" data-vis="scene"></div>
    <button type="button" class="visionneuse__fleche est-apres" data-vis="apres" aria-label="Suivant">›</button>
    <p class="visionneuse__compteur" data-vis="compteur" aria-live="polite"></p>`;
  document.body.appendChild(visionneuse);

  visionneuse.addEventListener('click', (evenement) => {
    const bouton = evenement.target.closest('[data-vis]');
    const role = bouton?.dataset.vis;
    if (role === 'avant') { deplacer(-1); return; }
    if (role === 'apres') { deplacer(1); return; }
    // Un clic dans le vide ferme ; un clic sur le média lui-même, non — sans
    // quoi mettre une vidéo en pause fermerait la visionneuse.
    if (role === 'fermer' || evenement.target === visionneuse) fermerVisionneuse();
  });

  // Le glissé du pouce, seul geste commode sur un téléphone. Seuil à 40 px
  // pour ne pas confondre avec un simple appui, et l'axe vertical est laissé
  // au défilement.
  let departX = null;
  let departY = null;
  visionneuse.addEventListener('touchstart', (e) => {
    departX = e.changedTouches[0].clientX;
    departY = e.changedTouches[0].clientY;
  }, { passive: true });
  visionneuse.addEventListener('touchend', (e) => {
    if (departX === null) return;
    const dx = e.changedTouches[0].clientX - departX;
    const dy = e.changedTouches[0].clientY - departY;
    departX = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) deplacer(dx < 0 ? 1 : -1);
  }, { passive: true });

  return visionneuse;
}

function rendreVisionneuse() {
  const scene = visionneuse.querySelector('[data-vis="scene"]');
  const actuel = serie[position];
  if (!actuel) return;
  scene.innerHTML = actuel.genre === 'video'
    ? `<video class="visionneuse__media" src="${echapper(actuel.source)}" controls autoplay playsinline></video>`
    : `<img class="visionneuse__media" src="${echapper(actuel.source)}" alt="">`;
  const compteur = visionneuse.querySelector('[data-vis="compteur"]');
  compteur.textContent = serie.length > 1 ? `${position + 1} / ${serie.length}` : '';
  // Une série d'un seul fichier n'a rien à feuilleter.
  visionneuse.querySelectorAll('.visionneuse__fleche')
    .forEach((f) => { f.hidden = serie.length < 2; });
}

function deplacer(pas) {
  if (serie.length < 2) return;
  // Circulaire : arrivé au bout de la journée, on repart au premier. Buter
  // sur un bouton mort ferait croire à une panne.
  position = (position + pas + serie.length) % serie.length;
  rendreVisionneuse();
}

/* Ces touches appartiennent à la visionneuse tant qu'elle est ouverte.

   `app.js` écoute les mêmes sur `document` pour changer d'étape et refermer la
   fiche. En phase remontante, son gestionnaire passait AVANT celui-ci — la
   journée changeait derrière la photo qu'on regardait, et `Échap` refermait la
   fiche en même temps que la visionneuse. `preventDefault` n'y pouvait rien :
   il annule l'action par défaut du navigateur, pas les autres écouteurs.

   D'où la phase de capture (`true` à l'inscription), qui passe en premier, et
   `stopPropagation` : l'événement n'atteint jamais `document` tant que la
   visionneuse est à l'écran. Une série d'une seule photo consomme les flèches
   elle aussi — ne rien faire est la bonne réponse ; changer de journée à sa
   place serait la pire. */
function surToucheVisionneuse(evenement) {
  if (visionneuse?.hidden !== false) return;
  if (!['Escape', 'ArrowLeft', 'ArrowRight'].includes(evenement.key)) return;
  evenement.preventDefault();
  evenement.stopPropagation();
  if (evenement.key === 'Escape') { fermerVisionneuse(); return; }
  deplacer(evenement.key === 'ArrowLeft' ? -1 : 1);
}

function ouvrirVisionneuse(fichiers, depart) {
  if (!fichiers.length) return;
  construireVisionneuse();
  serie = fichiers;
  position = Math.max(0, Math.min(depart, fichiers.length - 1));
  elementRendu = document.activeElement;
  visionneuse.hidden = false;
  addEventListener('keydown', surToucheVisionneuse, true);
  rendreVisionneuse();
  visionneuse.querySelector('[data-vis="fermer"]').focus({ preventScroll: true });
}

function fermerVisionneuse() {
  if (!visionneuse || visionneuse.hidden) return;
  // Vider la scène arrête net une vidéo qui jouait : la laisser en place la
  // laisserait tourner dans un élément masqué, son compris.
  visionneuse.querySelector('[data-vis="scene"]').innerHTML = '';
  visionneuse.hidden = true;
  removeEventListener('keydown', surToucheVisionneuse, true);
  serie = [];
  elementRendu?.focus?.({ preventScroll: true });
  elementRendu = null;
}

export function monterSouvenirs(conteneur, jour, { surDecompte = null } = {}) {
  // Le formulaire porte son propre intitulé : rien ne le séparait de la liste,
  // si bien que la ligne « vous publiez en tant que… » se lisait comme la
  // suite du dernier souvenir plutôt que comme le début d'un geste nouveau.
  // Pas de titre au-dessus de la liste : l'onglet « Souvenirs » le dit déjà,
  // juste au-dessus, et le répéter volait une ligne au premier souvenir.
  conteneur.innerHTML = `<div class="souvenirs__liste">Chargement…</div>
    <p class="souvenir-form__titre">Ajouter une note
      <span class="souvenir-form__reserve">(réservé aux motards)</span></p>
    ${gabaritFormulaire()}`;

  const liste = conteneur.querySelector('.souvenirs__liste');
  const formulaire = conteneur.querySelector('.souvenir-form');
  const souci = conteneur.querySelector('.souvenir-form__souci');
  const champFichier = formulaire.querySelector('[name="fichier"]');
  const nomChoisi = conteneur.querySelector('.souvenir-form__choisi');
  const listeFichiers = conteneur.querySelector('.souvenir-form__fichiers');

  // Champ distinct de celui du formulaire : compléter un souvenir déjà publié
  // ne doit pas toucher à la sélection en cours d'un nouveau souvenir, qu'on
  // est peut-être en train de composer juste en dessous.
  const champAjout = document.createElement('input');
  champAjout.type = 'file';
  champAjout.accept = 'image/*,video/*';
  champAjout.multiple = true;
  champAjout.hidden = true;
  conteneur.appendChild(champAjout);
  let contributionAComplete = null;

  // Amélioration B (re-revue) : plusieurs `rafraichir()` concurrents (celui
  // du gestionnaire de soumission et celui déclenché par `signaler()` quand
  // la file change pendant qu'on attend déjà) peuvent s'entrelacer et
  // achever dans le désordre — le plus lent écrase alors `liste.innerHTML`
  // avec un instantané périmé, laissant par exemple une carte « en attente »
  // fantôme sur un souvenir déjà publié, jusqu'au prochain événement de
  // file. Un compteur de génération simple : chaque appel se numérote à
  // l'entrée, et n'écrit plus s'il s'est fait doubler entretemps.
  let generation = 0;

  // Vrai quand « Changer » a ouvert les champs d'identité à la demande, pour
  // corriger un prénom ou changer de mot de passe alors que tout était déjà
  // mémorisé. Remis à faux dès qu'une publication aboutit.
  let identiteDepliee = false;

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
    const motDePasseMemorise = localStorage.getItem(CLE_MOT_DE_PASSE);
    const refusees = attente.filter((e) => e.refusMotDePasse);
    // Vrai une seule fois par refus : la branche efface le mot de passe
    // mémorisé qui la conditionne. C'est ce qui permet de donner le focus
    // au champ de reprise sans le voler à chaque rafraîchissement.
    const refusNouveau = Boolean(motDePasseMemorise)
      && refusees.some((e) => e.motDePasse === motDePasseMemorise);
    if (refusNouveau) localStorage.removeItem(CLE_MOT_DE_PASSE);

    // Qui demande le mot de passe, et où. Tant qu'une carte porte un refus,
    // c'est ELLE qui le redemande, à côté du texte et du fichier concernés ;
    // le formulaire du bas garde ses champs d'identité repliés plutôt que
    // d'exposer une seconde case vide qui donnerait à croire qu'il faut tout
    // ressaisir. Il les rouvre de lui-même à la première soumission d'un
    // nouveau souvenir sans mot de passe en mémoire (voir le gestionnaire de
    // soumission).
    ajusterChampsIdentite(refusees.length > 0);

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
        ? attente.map((e) => gabaritEnAttente(e, progressionEnvoi())).join('')
        : '<p class="souvenirs__vide">Le carnet ne se charge pas pour le moment.</p>';
      return;
    }
    if (mienne !== generation) return; // un appel plus récent a pris le dessus
    liste.innerHTML = publiees.length || attente.length
      ? publiees.map(gabaritContribution).join('')
        + attente.map((e) => gabaritEnAttente(e, progressionEnvoi())).join('')
      : '<p class="souvenirs__vide">Aucune note pour cette étape. Sois le premier.</p>';

    // Le décompte sort du MÊME chargement que la liste : le recalculer ailleurs
    // demanderait une seconde requête pour les mêmes données.
    if (surDecompte) {
      try {
        surDecompte(publiees.length);
      } catch (souci) {
        console.error('Le rappel de décompte a échoué :', souci);
      }
    }
    // Le champ de reprise n'existe qu'une fois la liste rendue : c'est donc
    // ici, et pas dans la branche de refus plus haut, qu'on peut y amener le
    // curseur. Jamais si la personne écrit déjà quelque part — lui voler le
    // focus enverrait ses frappes suivantes dans une case mot de passe.
    if (refusNouveau) donnerFocusReprise();
  }

  /** Replie ou rouvre prénom + mot de passe du formulaire du bas.

      Un seul endroit doit demander le mot de passe à la fois. Quand une carte
      bloquée s'en charge, ou quand le mot de passe est déjà mémorisé, ces deux
      champs n'ont rien à faire à l'écran. */
  function ajusterChampsIdentite(repriseEnCours) {
    const champAuteur = formulaire.querySelector('[name="auteur"]');
    const champMotDePasse = formulaire.querySelector('[name="motDePasse"]');
    if (!champAuteur || !champMotDePasse) return;
    const auteurConnu = Boolean(localStorage.getItem(CLE_AUTEUR));
    const motDePasseConnu = Boolean(localStorage.getItem(CLE_MOT_DE_PASSE));
    // `identiteDepliee` : le bouton « Changer » de la ligne de statut a ouvert
    // les champs à la demande. Sans ce drapeau, le premier rafraîchissement
    // venu — et il en passe un à chaque changement de file — les refermerait
    // au milieu de la saisie.
    const replier = auteurConnu && (motDePasseConnu || repriseEnCours) && !identiteDepliee;
    champAuteur.hidden = replier;
    champMotDePasse.hidden = replier;
    // Un champ replié ne doit rien garder : rouvert plus tard, il présenterait
    // sinon la faute de frappe qu'on vient d'effacer.
    if (replier) champMotDePasse.value = '';
    majStatut();
  }

  /** Réécrit la ligne « Visiteur / Compagnon ». */
  function majStatut() {
    const ligne = formulaire.querySelector('.souvenir-form__statut');
    if (ligne) ligne.innerHTML = gabaritStatut();
    // Le bouton dit ce qu'il fera : « Changer » quand les champs sont repliés,
    // « Annuler » quand ils sont ouverts. Sans cette bascule, rien ne permettait
    // de refermer ce qu'on venait d'ouvrir par curiosité, sinon publier.
    const bouton = formulaire.querySelector('[data-action="changer-identite"]');
    if (bouton) bouton.textContent = identiteDepliee ? 'Annuler' : 'Changer';
  }

  /** Amène le curseur au champ de reprise de la carte bloquée. */
  function donnerFocusReprise() {
    const champ = liste.querySelector('.souvenir__mot-de-passe');
    if (!champ) return;
    const ailleurs = document.activeElement;
    if (ailleurs && ailleurs !== document.body
        && (formulaire.contains(ailleurs) || liste.contains(ailleurs))) return;
    champ.focus({ preventScroll: true });
    champ.scrollIntoView({ block: 'center' });
  }

  // « Changer » rouvre prénom et mot de passe alors que tout est mémorisé ; le
  // même bouton, devenu « Annuler », les referme sans rien conserver de ce
  // qu'on y a tapé. Le mot de passe reste volontairement vide à l'ouverture —
  // le gestionnaire de soumission retombe sur celui en mémoire quand le champ
  // l'est —, si bien qu'on peut corriger un prénom sans retaper le reste.
  formulaire.addEventListener('click', (evenement) => {
    if (!evenement.target.closest('[data-action="changer-identite"]')) return;
    const champAuteur = formulaire.querySelector('[name="auteur"]');
    const champMotDePasse = formulaire.querySelector('[name="motDePasse"]');

    if (identiteDepliee) {
      // Retour à l'état d'avant le clic : les champs se referment et
      // retrouvent ce que la mémoire contient, non ce qu'on venait d'y taper.
      identiteDepliee = false;
      if (champAuteur) {
        champAuteur.value = localStorage.getItem(CLE_AUTEUR) || '';
        champAuteur.hidden = true;
      }
      if (champMotDePasse) {
        champMotDePasse.value = '';
        champMotDePasse.hidden = true;
      }
      majStatut();
      return;
    }

    identiteDepliee = true;
    if (champAuteur) {
      champAuteur.hidden = false;
      champAuteur.value = localStorage.getItem(CLE_AUTEUR) || '';
      champAuteur.focus({ preventScroll: true });
      champAuteur.select();
    }
    if (champMotDePasse) champMotDePasse.hidden = false;
    majStatut();
  });

  // Les fichiers choisis vivent ici, et non dans `champFichier.files` : un
  // `<input type="file">` REMPLACE sa sélection à chaque ouverture du sélecteur.
  // Sans cette liste, choisir trois photos dans la pellicule puis revenir
  // ajouter une vidéo effacerait les trois premières sans un mot.
  let fichiersChoisis = [];

  function rendreFichiersChoisis() {
    if (!fichiersChoisis.length) {
      listeFichiers.hidden = true;
      listeFichiers.innerHTML = '';
      nomChoisi.textContent = '';
      return;
    }
    const total = fichiersChoisis.reduce((somme, f) => somme + (f.size || 0), 0);
    listeFichiers.hidden = false;
    listeFichiers.innerHTML = fichiersChoisis.map((f, i) => `
      <li class="souvenir-form__fichier-ligne">
        <span class="souvenir-form__fichier-nom">${echapper(f.name || 'fichier')}</span>
        <span class="souvenir-form__fichier-poids">${poidsLisible(f.size)}</span>
        <button type="button" class="souvenir-form__retirer" data-retirer="${i}"
                aria-label="Retirer ${echapper(f.name || 'ce fichier')}">×</button>
      </li>`).join('');
    // Le total est le garde-fou qui remplace un plafond en nombre : une
    // sélection malheureuse dans la pellicule se voit tout de suite, avant
    // d'occuper la connexion de la soirée.
    nomChoisi.textContent = `${fichiersChoisis.length} fichier${fichiersChoisis.length > 1 ? 's' : ''} · ${poidsLisible(total)}`;
  }

  champFichier.addEventListener('change', () => {
    for (const fichier of champFichier.files) {
      // Même nom, même taille : l'a déjà choisi. Évite le doublon d'un
      // deuxième passage dans la pellicule.
      const deja = fichiersChoisis.some((f) => f.name === fichier.name && f.size === fichier.size);
      if (!deja) fichiersChoisis.push(fichier);
    }
    champFichier.value = ''; // libère le champ pour une prochaine sélection
    rendreFichiersChoisis();
  });

  listeFichiers.addEventListener('click', (evenement) => {
    const bouton = evenement.target.closest('[data-retirer]');
    if (!bouton) return;
    fichiersChoisis.splice(Number(bouton.dataset.retirer), 1);
    rendreFichiersChoisis();
  });

  // Ajout de fichiers à un souvenir déjà publié. Les mêmes règles que la
  // publication — vidéos vérifiées avant toute compression, photos
  // recompressées — puis la file d'attente s'en charge, avec la même reprise
  // fichier par fichier. Le mot de passe de groupe n'est pas redemandé : c'est
  // le jeton d'auteur qui autorise.
  champAjout.addEventListener('change', async () => {
    const cible = contributionAComplete;
    const choisis = [...champAjout.files];
    contributionAComplete = null;
    champAjout.value = '';
    if (!cible || !choisis.length) return;

    for (const f of choisis) {
      if (!f.type.startsWith('video/')) continue;
      const refus = verifierVideo(f);
      if (refus) { alert(`${f.name || 'Une vidéo'} : ${refus}`); return; }
    }

    const fichiers = [];
    for (const f of choisis) {
      if (!f.type.startsWith('image/')) { fichiers.push(f); continue; }
      try {
        fichiers.push(await compresserImage(f));
      } catch {
        fichiers.push(f);
      }
    }

    try {
      await mettreEnFile({
        type: 'ajout',
        jour,
        auteur: localStorage.getItem(CLE_AUTEUR) || '',
        texte: '',
        fichiers,
        // Renseigné dès la mise en file : la file saute alors la création
        // d'une contribution et n'envoie que les fichiers.
        contributionId: cible.id,
        jeton: cible.jeton,
        idempotence: creerCleIdempotence(),
      });
    } catch (probleme) {
      alert(`Enregistrement impossible pour le moment (${probleme?.message || 'erreur inconnue'}).`);
      return;
    }

    renvoyerMaintenant();
    await rafraichir();
  });

  formulaire.addEventListener('submit', async (evenement) => {
    evenement.preventDefault();
    souci.hidden = true;

    const donnees = new FormData(formulaire);
    const auteur = (donnees.get('auteur') || localStorage.getItem(CLE_AUTEUR) || '').trim();
    const motDePasse = donnees.get('motDePasse') || localStorage.getItem(CLE_MOT_DE_PASSE) || '';
    const texte = (donnees.get('texte') || '').trim();
    const choisis = [...fichiersChoisis];

    if (!auteur || !motDePasse) {
      souci.textContent = 'Indique ton prénom et le mot de passe du groupe.';
      souci.hidden = false;
      // Les champs d'identité peuvent être repliés parce qu'une carte bloquée
      // se charge du mot de passe (voir `ajusterChampsIdentite`). Publier un
      // NOUVEAU souvenir en a besoin quand même : on les rouvre ici plutôt que
      // de reprocher une saisie manquante dans des cases invisibles.
      const champAuteur = formulaire.querySelector('[name="auteur"]');
      const champMotDePasse = formulaire.querySelector('[name="motDePasse"]');
      if (champAuteur) champAuteur.hidden = false;
      if (champMotDePasse) {
        champMotDePasse.hidden = false;
        champMotDePasse.focus({ preventScroll: true });
      }
      return;
    }
    if (!texte && !choisis.length) {
      souci.textContent = 'Écris une note ou choisis une photo.';
      souci.hidden = false;
      return;
    }

    // Toutes les vidéos sont vérifiées AVANT d'en compresser une seule : rien
    // n'est plus décourageant que d'attendre la compression de huit photos
    // pour se voir refuser la neuvième. Le refus nomme le fichier fautif, sans
    // quoi il faudrait deviner lequel des neuf est trop lourd.
    for (const f of choisis) {
      if (!f.type.startsWith('video/')) continue;
      const refus = verifierVideo(f);
      if (refus) {
        souci.textContent = `${f.name || 'Une vidéo'} : ${refus}`;
        souci.hidden = false;
        return;
      }
    }

    const fichiers = [];
    for (const f of choisis) {
      if (!f.type.startsWith('image/')) { fichiers.push(f); continue; }
      try {
        fichiers.push(await compresserImage(f));
      } catch {
        fichiers.push(f); // la compression a échoué : l'original plutôt que rien
      }
    }

    localStorage.setItem(CLE_AUTEUR, auteur);
    localStorage.setItem(CLE_MOT_DE_PASSE, motDePasse);
    // `formulaire.reset()`, plus bas, ramène chaque champ à son `defaultValue`
    // — la valeur cuite dans l'attribut au montage du formulaire. Sans cette
    // synchronisation, un prénom corrigé via « Changer » repartirait bien
    // cette fois-ci, puis serait silencieusement remplacé par l'ancien à la
    // publication suivante, le champ masqué ayant retrouvé sa valeur d'origine.
    const champAuteurMemoire = formulaire.querySelector('[name="auteur"]');
    if (champAuteurMemoire) champAuteurMemoire.defaultValue = auteur;

    const entree = {
      type: fichiers.length ? 'media' : 'note',
      jour, auteur, texte, fichiers, motDePasse,
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
      souci.textContent = `Enregistrement impossible pour le moment (${probleme?.message || 'erreur inconnue'}). Le texte est conservé, réessaie.`;
      souci.hidden = false;
      return;
    }

    // Les champs rouverts par « Changer » ont fait leur office : la prochaine
    // passe d'ajustement peut les replier.
    identiteDepliee = false;
    formulaire.reset();
    fichiersChoisis = [];
    rendreFichiersChoisis();

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

  // Le champ de reprise vit hors du formulaire : « Entrée » n'y déclenche
  // rien tout seul. Sans ça, taper son mot de passe puis valider au clavier —
  // le réflexe de tout le monde, et le seul geste commode au pouce sur un
  // téléphone — ne ferait absolument rien.
  liste.addEventListener('keydown', (evenement) => {
    if (evenement.key !== 'Enter') return;
    if (!evenement.target.classList?.contains('souvenir__mot-de-passe')) return;
    evenement.preventDefault();
    evenement.target.closest('[data-local]')
      ?.querySelector('button[data-action="reessayer"]')?.click();
  });

  // Les flèches restent dans le souvenir cliqué : c'est lui qu'on regarde.
  brancherVisionneuse(liste);

  // Les commandes d'un souvenir, déléguées à la liste : elle est reconstruite
  // à chaque rafraîchissement, brancher chaque carte reviendrait à rebrancher
  // sans fin. Cet écouteur a été supprimé par inadvertance avec la mosaïque
  // (c635086), qui vivait juste au-dessus : ×, Ajouter, Modifier, Supprimer,
  // Réessayer et Abandonner s'affichaient alors sans plus rien faire.
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
      // Ordre de priorité : le champ de la carte elle-même (celui qu'on vient
      // de remplir sous les yeux du texte concerné), puis celui du formulaire
      // du bas — il reste la source quand l'entrée est bloquée pour une autre
      // raison que le mot de passe et n'a donc pas de champ à elle —, puis
      // enfin le mot de passe mémorisé.
      const champCarte = carte.querySelector('.souvenir__mot-de-passe');
      const champFormulaire = formulaire.querySelector('[name="motDePasse"]');
      const motDePasseCourant = (champCarte && champCarte.value.trim())
        || (champFormulaire && !champFormulaire.hidden && champFormulaire.value.trim())
        || localStorage.getItem(CLE_MOT_DE_PASSE) || '';
      // Une entrée qui a déjà sa contribution n'envoie plus que des fichiers,
      // autorisés par le jeton d'auteur : lui réclamer le mot de passe du
      // groupe reviendrait à refuser de repartir pour un secret dont elle ne
      // fera rien — le cas exact d'une photo ajoutée à un souvenir publié.
      if (!motDePasseCourant && carte.dataset.besoinMdp !== '0') {
        // Le message du formulaire s'affiche sous le bouton Publier, très loin
        // du « Réessayer » qu'on vient de cliquer et hors de l'écran sur un
        // téléphone. Quand la carte a son propre champ, on parle donc dans la
        // carte ; le pied de formulaire ne sert plus que de repli.
        const champ = champCarte || champFormulaire;
        if (champCarte) {
          const consigne = carte.querySelector('.souvenir__consigne');
          if (consigne) consigne.textContent = 'Tape le mot de passe du groupe ci-dessous, puis « Réessayer ».';
        } else {
          souci.textContent = 'Indique le mot de passe du groupe avant de réessayer.';
          souci.hidden = false;
        }
        if (champ) {
          champ.hidden = false;
          champ.focus({ preventScroll: true });
          champ.scrollIntoView({ block: 'center' });
        }
        return;
      }
      if (motDePasseCourant) localStorage.setItem(CLE_MOT_DE_PASSE, motDePasseCourant);
      await reprendreEntree(carte.dataset.local, motDePasseCourant);
      renvoyerMaintenant();
      await rafraichir();
      return;
    }

    const id = carte.dataset.id;
    const jeton = jetons()[id];
    if (!jeton) return;

    if (action === 'ajouter-media') {
      // Le sélecteur de fichiers ne peut s'ouvrir que depuis un geste de
      // l'utilisateur : on mémorise la cible, puis on clique le champ caché
      // dans la foulée du clic en cours.
      contributionAComplete = { id, jeton };
      champAjout.value = '';
      champAjout.click();
      return;
    }

    if (action === 'retirer-media') {
      if (!confirm('Retirer ce fichier de la note ?')) return;
      try {
        await supprimerFichier({ idMedia: bouton.dataset.media, jeton });
      } catch (probleme) {
        alert(probleme instanceof ErreurService ? probleme.message : 'Retrait impossible pour le moment.');
      }
      await rafraichir();
      return;
    }

    if (action === 'supprimer') {
      if (!confirm('Supprimer cette note ?')) return;
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
