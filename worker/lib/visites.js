/* Fréquentation du site : combien de personnes, combien de pages, et quelles
   étapes elles ouvrent.

   Fonctions pures, sans accès réseau ni base — testables directement, comme
   lib/securite.js et lib/position.js.

   Ce qui n'est PAS compté, et c'est délibéré : aucune adresse IP, aucun cookie,
   aucune empreinte de navigateur. Le navigateur retient chez lui qu'il a déjà
   été compté aujourd'hui et n'envoie qu'un « +1 » anonyme. Rien de ce qui
   arrive au service ne permet de distinguer un lecteur d'un autre — ni de
   savoir qu'un même lecteur est revenu. Un compteur de visites sur le carnet
   de route d'un voyage entre amis n'a pas à en savoir davantage. */

const ETAPES_VOYAGE = 15; // le voyage entier ; 0 désigne l'accueil

/** Borne une étape reçue de l'extérieur : 0 (l'accueil) à 15, ou `null`.

    La route d'écriture est publique — c'est un site public — donc ce qu'elle
    reçoit doit être borné AVANT de toucher à la base. Sans ce filtre, une
    requête forgée ferait créer autant de lignes qu'il y a d'entiers. */
export function normaliserEtape(valeur) {
  const nombre = typeof valeur === 'string' ? Number(valeur) : valeur;
  if (!Number.isInteger(nombre)) return null;
  if (nombre < 0 || nombre > ETAPES_VOYAGE) return null;
  return nombre;
}

const entier = (valeur) => (Number.isFinite(valeur) ? valeur : 0);

/** Met les lignes de la base en forme pour le module d'administration.

    `jours` : une ligne par jour calendaire (`date`, `visiteurs`, `pages`).
    `etapes` : une ligne par journée du voyage (`etape`, `pages`).

    Le navigateur ne recalcule rien : totaux, journée en cours, série
    chronologique et classement des étapes arrivent prêts à afficher. */
export function assemblerStatistiques({ jours = [], etapes = [] } = {}, { aujourdhui }) {
  const total = { visiteurs: 0, pages: 0 };
  for (const ligne of jours) {
    total.visiteurs += entier(ligne.visiteurs);
    total.pages += entier(ligne.pages);
  }

  // Avant la première visite du jour, la base n'a pas encore de ligne pour
  // aujourd'hui : zéro est alors la vérité, pas une absence à afficher comme un
  // trou dans le module.
  const ligneDuJour = jours.find((l) => l.date === aujourdhui);
  const duJour = {
    visiteurs: entier(ligneDuJour?.visiteurs),
    pages: entier(ligneDuJour?.pages),
  };

  // Les dates sont en AAAA-MM-JJ : l'ordre alphabétique EST l'ordre du
  // calendrier, sans jamais fabriquer de `Date` ni de fuseau.
  const serie = [...jours]
    .map((l) => ({ date: l.date, visiteurs: entier(l.visiteurs), pages: entier(l.pages) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // La part se rapporte à l'étape LA PLUS LUE et non au total : rapportée au
  // total, la première barre d'un classement de seize lignes n'aurait jamais
  // dépassé le tiers de la largeur, et les dernières auraient été invisibles.
  const classement = [...etapes]
    .map((l) => ({ etape: l.etape, pages: entier(l.pages) }))
    .sort((a, b) => b.pages - a.pages);
  const sommet = classement.length ? classement[0].pages : 0;
  for (const ligne of classement) {
    ligne.part = sommet > 0 ? ligne.pages / sommet : 0;
  }

  return { total, aujourdhui: duJour, jours: serie, etapes: classement };
}
