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

/* L'heure à laquelle une journée bascule sur la suivante, dans le fuseau de la
   ville où l'on ARRIVE ce soir-là.

   20 h et non minuit : à minuit la frise nommait la ville d'arrivée alors que
   la journée de route n'avait pas commencé. À 20 h, les motos sont posées, et
   la phrase « Nous sommes à Humahuaca ! » dit quelque chose de vrai.

   Le fuseau est celui de l'arrivée, pas du départ : c'est là qu'on est quand
   la bascule a lieu. */
const HEURE_BASCULE = 20;

/* Le fuseau de la ville d'arrivée de chaque journée roulée.

   Recopié de `data/etapes.json`, que ce service ne peut pas lire — c'est un
   fichier du site. Un test compare les deux à chaque exécution
   (`test/fuseaux.test.js`) : sans lui, une étape déplacée d'un pays à l'autre
   laisserait cette table mentir en silence, et la frise changerait de jour à
   la mauvaise heure pendant tout le voyage.

   Les fuseaux sont NOMMÉS et non écrits en décalage horaire : le Chili passe à
   l'heure d'été le premier dimanche de septembre, en plein voyage. */
export const FUSEAU_PAR_JOUR = {
  2: 'America/Argentina/Salta',
  3: 'America/Argentina/Salta',
  4: 'America/Santiago',
  5: 'America/La_Paz',
  6: 'America/La_Paz',
  7: 'America/La_Paz',
  8: 'America/La_Paz',
  9: 'America/La_Paz',
  10: 'America/La_Paz',
  11: 'America/Lima',
  12: 'America/Lima',
  13: 'America/Lima',
  14: 'America/Lima',
  15: 'America/Lima',
};

/** L'instant réel où il est telle heure, tel jour, dans tel fuseau.

    `Date` ne sait pas construire un instant à partir d'une heure locale dans un
    fuseau arbitraire : il ne connaît que l'UTC et le fuseau de la machine — ici
    celui d'un serveur Cloudflare, qui n'a rien à voir avec les Andes. On part
    donc de l'instant UTC naïf, on demande à `Intl` quel décalage s'applique
    LÀ-BAS à ce moment, et on corrige.

    Deux passes : le décalage se lit à un instant, et l'instant dépend du
    décalage. La première approximation suffit à tomber dans le bon jour, la
    seconde règle le cas des quelques heures qui suivent un changement d'heure. */
export function instantLocal(dateIso, heure, fuseau) {
  const [annee, mois, jour] = dateIso.split('-').map(Number);
  const naif = Date.UTC(annee, mois - 1, jour, heure);
  let instant = naif;
  for (let passe = 0; passe < 2; passe += 1) {
    instant = naif - decalageFuseau(instant, fuseau);
  }
  return new Date(instant);
}

/* Le décalage d'un fuseau à un instant donné, en millisecondes. `en-CA` rend
   une date en AAAA-MM-JJ, ce qui se recompose sans ambiguïté. */
function decalageFuseau(instant, fuseau) {
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseau,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const p = Object.fromEntries(parties.map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return local - instant;
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
  // On descend depuis la fin : la journée à montrer est la DERNIÈRE dont
  // l'heure de bascule est passée. Parcourir dans l'autre sens obligerait à
  // regarder la journée suivante pour savoir si l'on s'arrête — et à gérer à
  // part le bout du voyage, où il n'y en a pas.
  for (let jour = JOURS_VOYAGE; jour >= PREMIER_JOUR_ROULE; jour -= 1) {
    const date = dateDuJourVoyage({ depart, decalage, jour });
    if (maintenant >= instantLocal(date, HEURE_BASCULE, FUSEAU_PAR_JOUR[jour])) return jour;
  }
  return null;
}
