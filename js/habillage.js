/* Habillage : le jeu de couleurs de la page, choisi par un attribut sur <html>.

   Quatre jeux, et le choix tient d'une visite à l'autre : comparer suppose de
   vivre avec chacun un moment, pas de le voir trois secondes.

   Ce module est partagé entre le site et la page de modération, qui portent les
   mêmes quatre habillages. Il vivait dans `app.js` ; le recopier dans
   `admin.js` aurait mis en double la clé de stockage et la règle de la barre du
   navigateur — deux valeurs qui auraient divergé au premier ajustement, et un
   habillage choisi sur le site ne se serait plus retrouvé sur l'admin.

   Il ne suppose rien de la page qui l'appelle : s'il n'y a pas de groupe
   `.habillages`, il pose quand même l'habillage mémorisé. */

const CLE_HABILLAGE = 'salta-cusco.habillage';

function appliquerHabillage(nom) {
  if (nom) document.documentElement.dataset.habillage = nom;
  else delete document.documentElement.dataset.habillage;

  for (const bouton of document.querySelectorAll('[data-habillage]')) {
    bouton.setAttribute('aria-pressed', String(bouton.dataset.habillage === nom));
  }

  // La barre du navigateur suit l'habillage. Elle était écrite en dur dans
  // l'entête HTML, sur la valeur de « Nations » : passer en « Nuit » laissait
  // donc un bandeau blanc coiffer une page bleu nuit — exactement le défaut
  // que cette balise était censée éviter, mais dans l'autre sens.
  //
  // La couleur se relit sur le document plutôt que d'être recopiée ici :
  // quatre valeurs de plus à tenir d'accord avec la CSS auraient divergé au
  // premier habillage retouché. `--nuit` est le fond de la page, c'est-à-dire
  // ce que la barre doit prolonger.
  const barre = document.querySelector('meta[name="theme-color"]');
  if (barre) {
    const fond = getComputedStyle(document.documentElement).getPropertyValue('--nuit').trim();
    if (fond) barre.setAttribute('content', fond);
  }
  try {
    // « Nuit » n'a pas de nom d'attribut — c'est le :root — mais il lui faut un
    // nom en mémoire. Sans lui, le choisir revenait à effacer la clé, donc à
    // retrouver « Nations » à la visite suivante : le seul des quatre
    // habillages qu'on ne pouvait pas garder.
    localStorage.setItem(CLE_HABILLAGE, nom || 'nuit');
  } catch {
    // Navigation privée, stockage refusé : l'habillage vaut pour cette visite.
  }
}

export function brancherHabillages() {
  for (const bouton of document.querySelectorAll('.habillages [data-habillage]')) {
    bouton.addEventListener('click', () => appliquerHabillage(bouton.dataset.habillage));
  }
  // « Nations » par défaut : c'est l'habillage qui distingue le plus ce site,
  // la couleur y portant une information plutôt qu'un décor.
  let garde = 'nations';
  try {
    const memoire = localStorage.getItem(CLE_HABILLAGE);
    if (memoire) garde = memoire === 'nuit' ? '' : memoire;
  } catch {
    // Stockage refusé : la visite commence sur l'habillage par défaut.
  }
  appliquerHabillage(garde);
}
