/* Calcul de la position automatique des motards : à partir d'une date de
   départ et d'un décalage, quelle journée du voyage (1 à 15) montrer.

   Fonctions pures, sans accès réseau ni base — testables directement, comme
   lib/securite.js. À tenir en phase avec `JOURS` dans worker/index.js si le
   voyage change un jour de longueur. */

const JOURS_VOYAGE = 15;

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

/** Jours entiers entre deux dates AAAA-MM-JJ (positif si `arrivee` suit `depart`). */
export function joursEntre(depart, arrivee) {
  const MS_PAR_JOUR = 24 * 60 * 60 * 1000;
  return Math.round((versInstant(arrivee) - versInstant(depart)) / MS_PAR_JOUR);
}

/** La journée à montrer (1 à 15), ou `null` avant le départ.

    `depart` : date AAAA-MM-JJ. `decalage` : jours d'avance (positif) ou de
    retard (négatif) — un décalage négatif peut repousser sous J1 même après
    le départ. `maintenant` : injectable pour les tests, sinon l'instant
    présent. Au-delà du quinzième jour, plafonne à 15 : le voyage est fini,
    les motos restent à Cusco plutôt que de disparaître. */
export function calculerPositionAuto({ depart, decalage = 0, maintenant = new Date() }) {
  const aujourdhui = dateParisDuJour(maintenant);
  const ecoules = joursEntre(depart, aujourdhui);
  const jour = ecoules + 1 + decalage;
  if (jour < 1) return null;
  if (jour > JOURS_VOYAGE) return JOURS_VOYAGE;
  return jour;
}
