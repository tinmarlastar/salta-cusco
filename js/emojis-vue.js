/* Sélecteur d'emoji : le panneau qui s'ouvre au « + » sous une note.

   Ce module possède le DOM du panneau, et rien d'autre. Il ne parle ni au
   réseau, ni à la base : il rend un emoji à qui l'a ouvert, charge à celui-là
   d'en faire un vote (js/souvenirs-vue.js).

   Les emoji viennent de js/vendor/emojis.js, engendré par
   tools/construire_emojis.py depuis le fichier officiel d'Unicode : les mêmes
   neuf familles, dans le même ordre, que le clavier d'un téléphone.

   Le chargement de cette liste est DIFFÉRÉ, par un `import()` au premier
   clic : 18 Ko qu'on ne doit pas faire payer à quelqu'un qui vient lire une
   étape sans jamais ouvrir le sélecteur. */

const CLE_RECENTS = 'souvenirs.emojisRecents';
const RECENTS_MAX = 24;

// Au-delà, l'ancrage sous le bouton n'a plus de sens : le panneau prend toute
// la largeur et vient du bas, comme le clavier qu'il imite.
const LARGEUR_FEUILLE = 620;

let groupes = null;      // la liste, une fois chargée
let panneau = null;      // le DOM, construit une seule fois par onglet
let surChoix = null;     // à qui rendre l'emoji choisi
let famille = 0;         // index de l'onglet ouvert, -1 pour les récents
let rendeurAncre = null; // le bouton qui a ouvert, pour lui rendre le focus

const echapper = (texte) => String(texte ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Les emoji récemment choisis sur cet appareil, du plus récent au plus vieux.

    Comme le reste de ce que retient le carnet chez le lecteur : rien n'en sort
    jamais vers le service. C'est un confort local, et c'est ce qui évite de
    parcourir 386 personnages pour reposer le cœur qu'on pose à chaque note. */
export function recents() {
  try {
    const lus = JSON.parse(localStorage.getItem(CLE_RECENTS) || '[]');
    return Array.isArray(lus) ? lus.filter((e) => typeof e === 'string') : [];
  } catch {
    // Stockage illisible (navigation privée, quota) : pas de récents, et
    // surtout pas de sélecteur qui refuse de s'ouvrir pour si peu.
    return [];
  }
}

export function retenirRecent(emoji) {
  if (!emoji) return;
  const liste = [emoji, ...recents().filter((e) => e !== emoji)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(CLE_RECENTS, JSON.stringify(liste));
  } catch {
    // Pas de récents mémorisés vaut mieux qu'un clic qui échoue.
  }
}

async function charger() {
  if (!groupes) ({ GROUPES: groupes } = await import('./vendor/emojis.js'));
  return groupes;
}

function gabaritOnglets() {
  const memoire = recents();
  const onglets = memoire.length
    ? [`<button type="button" class="emojis__onglet${famille === -1 ? ' emojis__onglet--ouvert' : ''}"
          data-famille="-1" title="Récents" aria-label="Récents">🕘</button>`]
    : [];
  return onglets.concat(groupes.map((groupe, i) => `
    <button type="button" class="emojis__onglet${famille === i ? ' emojis__onglet--ouvert' : ''}"
            data-famille="${i}" title="${echapper(groupe.nom)}" aria-label="${echapper(groupe.nom)}"
    >${groupe.vignette}</button>`)).join('');
}

function gabaritGrille() {
  const emojis = famille === -1 ? recents() : groupes[famille].emojis;
  const titre = famille === -1 ? 'Récents' : groupes[famille].nom;
  return `<p class="emojis__famille">${echapper(titre)}</p>
    <div class="emojis__grille">${emojis.map((e) => `
      <button type="button" class="emojis__emoji" data-emoji="${echapper(e)}">${e}</button>`).join('')}</div>`;
}

function redessiner() {
  panneau.querySelector('.emojis__onglets').innerHTML = gabaritOnglets();
  panneau.querySelector('.emojis__corps').innerHTML = gabaritGrille();
  // Une famille se relit du début : garder le défilement de la précédente
  // donnerait à croire que l'onglet n'a pas changé sur les familles longues.
  panneau.querySelector('.emojis__corps').scrollTop = 0;
}

function fermer() {
  if (!panneau) return;
  panneau.hidden = true;
  surChoix = null;
  // Le focus revient au « + » : au clavier, le perdre au fond de la page
  // obligerait à refaire toute la tabulation pour retrouver la note.
  rendeurAncre?.focus?.({ preventScroll: true });
  rendeurAncre = null;
}

function choisir(emoji) {
  const rappel = surChoix;
  retenirRecent(emoji);
  fermer();
  rappel?.(emoji);
}

function construire() {
  panneau = document.createElement('div');
  panneau.className = 'emojis';
  panneau.hidden = true;
  panneau.innerHTML = `<div class="emojis__voile"></div>
    <div class="emojis__panneau" role="dialog" aria-modal="true" aria-label="Choisir un smiley">
      <div class="emojis__onglets"></div>
      <div class="emojis__corps"></div>
    </div>`;

  panneau.addEventListener('click', (evenement) => {
    if (evenement.target.closest('.emojis__voile')) { fermer(); return; }

    const onglet = evenement.target.closest('[data-famille]');
    if (onglet) {
      famille = Number(onglet.dataset.famille);
      redessiner();
      return;
    }

    const emoji = evenement.target.closest('[data-emoji]');
    if (emoji) choisir(emoji.dataset.emoji);
  });

  // Échap ferme, comme la visionneuse de photos : c'est le geste attendu de
  // tout ce qui se pose par-dessus la page.
  panneau.addEventListener('keydown', (evenement) => {
    if (evenement.key === 'Escape') { evenement.stopPropagation(); fermer(); }
  });

  /* Un écran qui change de taille pendant que le panneau est ouvert : rotation
     d'un téléphone, fenêtre redimensionnée, barre d'adresse qui se replie. Le
     placement est refait plutôt que le panneau fermé — se le voir disparaître
     sous les doigts parce qu'on a tourné l'appareil serait pris pour une
     panne. Sans ça, il gardait l'ancrage calculé pour l'écran d'avant et
     débordait du bord. */
  window.addEventListener('resize', () => {
    if (panneau.hidden || !rendeurAncre?.isConnected) return;
    placer(rendeurAncre);
  });

  document.body.appendChild(panneau);
}

/** Place le panneau sous le bouton qui l'ouvre, ou en bas de l'écran.

    Sur un téléphone, un panneau ancré à un bouton déborde d'un côté ou de
    l'autre selon la place restante ; il vient donc du bas, sur toute la
    largeur, là où le pouce l'attend — exactement comme le clavier d'emoji du
    système. Sur un écran large, il reste accroché à son bouton : le suivre du
    regard est plus simple que de descendre les yeux au bas de la fenêtre. */
function placer(ancre) {
  const boite = panneau.querySelector('.emojis__panneau');
  const feuille = window.innerWidth <= LARGEUR_FEUILLE;
  panneau.classList.toggle('emojis--feuille', feuille);
  if (feuille) {
    // Les trois propriétés posées par l'ancrage sont effacées, hauteur
    // comprise : un style en ligne l'emporterait sur le `max-height` de la
    // feuille de style, et le panneau garderait la taille calculée pour le
    // dernier écran large.
    boite.style.left = '';
    boite.style.top = '';
    boite.style.maxHeight = '';
    return;
  }

  const rect = ancre.getBoundingClientRect();
  const largeur = 320;
  const hauteur = 340;   // la hauteur souhaitée, celle de la feuille de style
  const marge = 8;

  // Le panneau va du côté où il y a le plus de place, et sa hauteur est bornée
  // à cette place. Sans ce plafond, une fenêtre courte le faisait déborder
  // par-dessus la note à laquelle il appartient : on ne voyait plus ce qu'on
  // était en train de commenter.
  const placeDessous = window.innerHeight - rect.bottom - marge * 2;
  const placeDessus = rect.top - marge * 2;
  const versLeBas = placeDessous >= Math.min(hauteur, placeDessus);
  const utile = Math.max(160, Math.min(hauteur, versLeBas ? placeDessous : placeDessus));

  boite.style.maxHeight = `${utile}px`;
  boite.style.left = `${Math.max(marge, Math.min(rect.left, window.innerWidth - largeur - marge))}px`;
  boite.style.top = versLeBas
    ? `${rect.bottom + marge}px`
    : `${Math.max(marge, rect.top - utile - marge)}px`;
}

/** Ouvre le sélecteur ancré à `ancre` ; `rappel` reçoit l'emoji choisi.

    Rien n'est rendu si le lecteur referme sans choisir : le rappel n'est
    appelé que sur un vrai choix. */
export async function ouvrirSelecteur(ancre, rappel) {
  await charger();
  if (!panneau) construire();

  surChoix = rappel;
  rendeurAncre = ancre;
  // On rouvre sur les récents dès qu'il y en a : neuf fois sur dix, le smiley
  // qu'on veut poser est un de ceux qu'on a déjà posés.
  famille = recents().length ? -1 : 0;

  redessiner();
  panneau.hidden = false;
  placer(ancre);
  panneau.querySelector('.emojis__onglet')?.focus({ preventScroll: true });
}
