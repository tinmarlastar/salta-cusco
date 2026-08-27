/* Compteur de fréquentation : un « +1 » anonyme envoyé au service.

   Ce module ne touche pas au DOM et n'a qu'une fonction publique. Il décide
   CHEZ LE LECTEUR de ce qu'il y a à compter, et le service se contente
   d'additionner — c'est ce qui permet au compteur de ne rien savoir de
   personne.

   Ce qui n'est jamais envoyé : aucune adresse IP, aucun cookie, aucune
   empreinte de navigateur, aucun identifiant d'aucune sorte. Le service reçoit
   un numéro d'étape et un booléen. Il ne peut donc ni reconnaître un lecteur
   d'un jour à l'autre, ni savoir combien de fois la même personne est revenue —
   et c'est très bien ainsi pour le carnet de route d'un voyage entre amis.

   Deux mémoires locales, deux durées :

   - `localStorage` retient le dernier JOUR où ce navigateur s'est annoncé, ce
     qui rend « visiteurs uniques par jour » sans rien stocker côté service ;
   - `sessionStorage` retient les étapes déjà comptées PENDANT CETTE VISITE, si
     bien qu'aller et venir entre le jour 7 et l'accueil ne gonfle pas les
     chiffres. Une étape rouverte demain sera recomptée : c'est une nouvelle
     lecture, et c'est ce qu'on veut savoir.

   Rien ici ne doit pouvoir casser le site : le carnet fonctionne sans le
   service, et un compteur encore moins critique que lui n'a aucun droit
   d'empêcher une page de s'afficher. Toutes les erreurs sont donc avalées. */

import { compterVisite } from './souvenirs.js';

const CLE_JOUR = 'salta-cusco.visite-jour';
const CLE_ETAPES = 'salta-cusco.visite-etapes';

/* Le jour est celui de Paris, exactement comme côté service (voir
   `dateParisDuJour` dans worker/lib/position.js) : c'est le fuseau de ceux qui
   suivent le voyage. Les deux règles doivent coïncider, sinon un lecteur au
   Pérou basculerait de jour à un moment où le service compte encore la veille,
   et se ferait compter deux fois dans la même journée. `en-CA` produit
   directement AAAA-MM-JJ. */
function jourDeParis() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/* Navigation privée, stockage refusé, quota plein : le compteur se dégrade en
   silence plutôt que d'échouer. Sans mémoire, un lecteur sera compté comme
   nouveau à chaque page — c'est faux, mais c'est le seul défaut acceptable
   entre fausser un chiffre et casser une page. */
function lire(stockage, cle) {
  try {
    return stockage.getItem(cle);
  } catch {
    return null;
  }
}

function ecrire(stockage, cle, valeur) {
  try {
    stockage.setItem(cle, valeur);
  } catch {
    // Tant pis : le compteur perdra en précision, la page continue.
  }
}

/** Signale une page vue, et un visiteur s'il ne s'est pas encore annoncé.

    `etape` vaut 0 pour l'accueil, 1 à 15 pour une journée. Ne rend rien et
    n'attend rien : l'appelant continue son travail sans savoir si l'envoi a
    abouti. */
export function signalerVisite(etape) {
  const cle = String(etape);

  // Une étape déjà vue dans cette visite ne compte pas deux fois : sans ce
  // garde, un aller-retour entre l'accueil et le jour 7 doublait les deux
  // compteurs, et « les étapes les plus lues » aurait surtout classé les
  // journées voisines de celle qu'on regarde.
  let vues = [];
  try {
    vues = JSON.parse(lire(sessionStorage, CLE_ETAPES) || '[]');
    if (!Array.isArray(vues)) vues = [];
  } catch {
    vues = [];
  }
  if (vues.includes(cle)) return;
  vues.push(cle);
  ecrire(sessionStorage, CLE_ETAPES, JSON.stringify(vues));

  const aujourdhui = jourDeParis();
  const visiteur = lire(localStorage, CLE_JOUR) !== aujourdhui;
  if (visiteur) ecrire(localStorage, CLE_JOUR, aujourdhui);

  // Lancé sans être attendu, et son échec est sans conséquence : une panne du
  // service ou une origine refusée ne doit pas se voir sur la page.
  compterVisite({ etape, visiteur }).catch(() => {});
}
