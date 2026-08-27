/* Calcul de la position automatique des motards : à partir d'une date de
   départ et d'un décalage, quelle journée du voyage (1 à 15) montrer.

   Fonctions pures, sans accès réseau ni base — testables directement, comme
   lib/securite.js. À tenir en phase avec `JOURS` dans worker/index.js si le
   voyage change un jour de longueur. */

const JOURS_VOYAGE = 15;

/* La première journée ROULÉE, et le repère de tout ce calendrier.

   J1 n'en est pas une : `ride: false`, zéro kilomètre, Salta → Salta — c'est la
   journée de rassemblement sur place. Elle se lit comme les autres sur le site,
   mais n'est jamais une position : le compteur ne s'y arrête pas et le menu de
   l'admin ne la propose pas.

   `depart` désigne donc la date où l'on QUITTE Salta, celle de J2. Faire partir
   le calendrier de J1 revenait à annoncer un départ de Salta le jour même où
   l'on y arrive — c'est le défaut que ce repère corrige. */
export const PREMIER_JOUR_ROULE = 2;
const MS_PAR_JOUR = 24 * 60 * 60 * 1000;

/** La date du jour à Paris, au format AAAA-MM-JJ.

    Le voyage traverse plusieurs fuseaux (Argentine à -3, Pérou à -5) :
    aucun n'est plus « juste » qu'un autre pour dire quand on change de
    journée. Paris est le fuseau de ceux qui suivent le voyage.
    `Intl.DateTimeFormat` gère l'heure d'été sans bibliothèque, et le
    calendrier canadien (`en-CA`) produit directement AAAA-MM-JJ. */
export function dateParisDuJour(maintenant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(maintenant);
}

function versInstant(aaaaMmJj) {
  const [annee, mois, jour] = aaaaMmJj.split('-').map(Number);
  return Date.UTC(annee, mois - 1, jour); // `mois - 1` : Date.UTC compte les mois à partir de 0
}

// Minuit UTC en entrée comme en sortie : les deux conversions se répondent, et
// `toISOString` recrache exactement la date posée, sans dérive de fuseau.
function versDate(instant) {
  return new Date(instant).toISOString().slice(0, 10);
}

/** Jours entiers entre deux dates AAAA-MM-JJ (positif si `arrivee` suit `depart`). */
export function joursEntre(depart, arrivee) {
  return Math.round((versInstant(arrivee) - versInstant(depart)) / MS_PAR_JOUR);
}

/** La date (AAAA-MM-JJ) à laquelle le voyage en sera à sa journée `jour`.

    L'inverse de `calculerPositionAuto` : celle-ci part de la date du jour et
    trouve la journée, celle-là part d'une journée et retrouve sa date. Elle
    sert à annoncer les deux extrémités du voyage — « Départ de Salta le… »
    avant d'être partis, « Nous sommes arrivés le… » une fois J15 atteint.

    Le décalage joue en sens INVERSE ici : deux jours d'avance, c'est une
    journée atteinte deux jours plus tôt. Sans ce signe, la frise annoncerait
    un départ le 1er septembre tout en attendant le 3 pour passer à J1 — elle
    se contredirait à l'écran. */
export function dateDuJourVoyage({ depart, decalage = 0, jour }) {
  return versDate(versInstant(depart) + (jour - PREMIER_JOUR_ROULE - decalage) * MS_PAR_JOUR);
}

/** La journée à montrer (2 à 15), ou `null` tant qu'on n'a pas quitté Salta.

    `depart` : la date où l'on quitte Salta, AAAA-MM-JJ. `decalage` : jours
    d'avance (positif) ou de retard (négatif) — un décalage négatif peut
    repousser avant le départ. `maintenant` : injectable pour les tests, sinon
    l'instant présent. Au-delà du quinzième jour, plafonne à 15 : le voyage est
    fini, les motos restent à Cusco plutôt que de disparaître.

    Ne rend JAMAIS J1 : voir `PREMIER_JOUR_ROULE`. Avant le départ la frise
    annonce la date à venir, elle ne prétend pas qu'on est déjà quelque part. */
export function calculerPositionAuto({ depart, decalage = 0, maintenant = new Date() }) {
  const aujourdhui = dateParisDuJour(maintenant);
  const ecoules = joursEntre(depart, aujourdhui);
  const jour = ecoules + PREMIER_JOUR_ROULE + decalage;
  if (jour < PREMIER_JOUR_ROULE) return null;
  if (jour > JOURS_VOYAGE) return JOURS_VOYAGE;
  return jour;
}
