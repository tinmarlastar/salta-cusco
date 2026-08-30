/* Réactions : les smileys posés sous une note du carnet.

   Fonctions pures, sans accès réseau ni base — testables directement, comme
   lib/securite.js, lib/position.js et lib/visites.js.

   Ce qui n'est PAS enregistré, et c'est délibéré : rien n'identifie qui a
   réagi. La base ne connaît qu'un compteur par couple (note, smiley), comme le
   module des visites ne connaît qu'un compteur par journée. C'est le
   navigateur qui retient chez lui le smiley qu'il a posé, pour pouvoir le
   reprendre ou le déplacer ; le service, lui, ne peut pas distinguer deux
   lecteurs — ni savoir que le même est revenu. */

import { GROUPES } from '../../js/vendor/emojis.js';

/* La liste d'autorisation est la liste affichée. Le sélecteur du carnet et ce
   contrôle lisent le même fichier engendré : un emoji proposé à l'écran est
   forcément accepté ici, et réciproquement. Une liste recopiée d'un côté et de
   l'autre aurait fini par diverger — et la divergence se serait vue comme un
   clic sans effet, la pire panne à diagnostiquer. */
const AUTORISES = new Set(GROUPES.flatMap((groupe) => groupe.emojis));

/** Borne un smiley reçu de l'extérieur : l'emoji lui-même, ou `null`.

    La route d'écriture est publique — c'est un site public. Sans ce filtre,
    une requête forgée ferait écrire n'importe quelle chaîne en base, et cette
    chaîne ressortirait telle quelle sous une note à la place d'un smiley.
    L'appartenance à la liste tranche tout d'un coup : le texte, la chaîne
    vide, deux emoji collés, une variante de teinte que le sélecteur ne propose
    pas — rien de tout cela n'y figure. */
export function normaliserSmiley(valeur) {
  if (typeof valeur !== 'string') return null;
  return AUTORISES.has(valeur) ? valeur : null;
}

/** Traduit un vote reçu en deux gestes de base : un compteur à décrémenter,
    un à incrémenter. Rend `null` si le vote est irrecevable.

    Le navigateur envoie ce qu'il VEUT (`smiley`, ou rien pour retirer) et ce
    qu'il AVAIT (`precedent`), qu'il est seul à connaître : le service ne garde
    rien qui permette de savoir qui a déjà réagi. Il en découle que ce couple
    est déclaratif, donc à traiter avec méfiance — d'où les deux cas
    ci-dessous. */
export function interpreterVote(corps) {
  const demande = corps?.smiley ?? null;
  const poser = demande === null ? null : normaliserSmiley(demande);
  // Un smiley demandé mais hors liste est un refus franc : le navigateur doit
  // l'apprendre plutôt que voir son clic traité comme un retrait.
  if (demande !== null && poser === null) return null;

  // `precedent` ne vient pas d'un clic mais du stockage local, où il peut
  // dater d'une version antérieure de la liste. On l'ignore au lieu de refuser
  // le vote entier : sinon un lecteur dont le navigateur garde un vieux smiley
  // resterait bloqué sans comprendre. Un smiley hors liste n'a jamais pu
  // entrer en base, il n'y a donc rien à décrémenter.
  const precedent = normaliserSmiley(corps?.precedent ?? null);

  // Redemander le smiley déjà posé n'est pas un second vote : c'est un envoi
  // en double, ou un onglet resté ouvert sur le même état. Sans ce cas, le
  // compteur monterait d'un cran à chaque fois.
  if (poser !== null && poser === precedent) return { retirer: null, poser: null };

  return { retirer: precedent, poser };
}

/** Range les lignes de `reactions` par note, du smiley le plus posé au moins.

    Le navigateur ne recalcule rien : il reçoit les boutons dans l'ordre où il
    doit les peindre. */
export function assemblerReactions(lignes) {
  const par = new Map();

  for (const ligne of lignes || []) {
    const compte = Number(ligne.compte);
    // Retirer sa réaction décrémente le compteur sans supprimer la ligne (le
    // vote suivant n'a ainsi pas à choisir entre insérer et mettre à jour).
    // Un zéro reste donc en base, mais n'est plus une réaction : il n'a rien à
    // faire à l'écran sous la forme d'un bouton « 0 ».
    if (!Number.isFinite(compte) || compte <= 0) continue;
    if (!par.has(ligne.contribution_id)) par.set(ligne.contribution_id, []);
    par.get(ligne.contribution_id).push({ smiley: ligne.smiley, compte });
  }

  for (const liste of par.values()) {
    // À égalité, l'emoji lui-même départage. Sans ce second critère, l'ordre
    // dépendrait de celui où SQLite a rendu les lignes, et les boutons
    // changeraient de place d'un rafraîchissement à l'autre sans que personne
    // n'ait rien posté.
    liste.sort((a, b) => b.compte - a.compte
      || (a.smiley < b.smiley ? -1 : a.smiley > b.smiley ? 1 : 0));
  }

  return par;
}
