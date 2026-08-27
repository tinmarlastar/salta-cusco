/* Consommation Cloudflare : ce que le compte a dépensé, et ce que l'offre
   gratuite laisse dépenser.

   Fonctions pures, sans accès réseau — testables directement, comme
   lib/securite.js et lib/position.js. Les appels à l'API GraphQL vivent dans
   index.js ; ici on ne fait que FORMER les requêtes et LIRE les réponses.

   UNE REQUÊTE PAR JEU DE DONNÉES, et non une seule qui les demande tous.
   La raison est arrivée en production : une requête GraphQL dont un seul champ
   est inconnu est rejetée EN ENTIER, avant d'être exécutée. Un `max` de trop
   sur le jeu D1 effaçait donc aussi les compteurs Workers et R2, qui eux
   étaient justes — et le panneau n'affichait plus rien du tout. Séparées, les
   mesures vivent chacune leur vie : celles qui répondent s'affichent, celle
   qui échoue dit pourquoi, à sa place. Le coût est de cinq appels au lieu
   d'un, lancés de front. */

/* Les forfaits de l'offre gratuite, en un seul endroit.

   ATTENTION : valeurs relevées dans la documentation Cloudflare en août 2026.
   Elles bougent, et rien ici ne les vérifie. Si le panneau annonce un jour une
   marge qui ne correspond plus au tableau de bord, c'est cette table qu'il faut
   revoir en premier, et non le calcul.

   Le giga-octet vaut 10⁹ octets et non 2³⁰. Cloudflare écrit « 10 GB-month »
   sans jamais préciser lequel : on choisit la lecture la plus sévère, qui rend
   le forfait plus petit de 7 % et fait monter la jauge plus vite. Se tromper de
   ce côté fait s'inquiéter un peu tôt ; se tromper de l'autre ferait annoncer
   de la marge qui n'existe pas. */
export const SEUILS = {
  workersRequetesParJour: 100_000,
  d1LignesLuesParJour: 5_000_000,
  d1LignesEcritesParJour: 100_000,
  d1TailleOctets: 5_000_000_000,
  r2StockageOctets: 10_000_000_000,
  r2OperationsAParMois: 1_000_000,
  r2OperationsBParMois: 10_000_000,
};

/* Quatre cinquièmes du forfait : le seuil où l'on prévient. Assez tôt pour
   qu'il reste de quoi réagir — effacer des vidéos, passer à l'offre payante —
   et assez tard pour que l'alerte ne soit pas le régime permanent. */
const PART_ALERTE = 0.8;

/** Où en est une mesure : tranquille, proche du plafond, ou dessus. */
export function niveau(part) {
  if (part >= 1) return 'depasse';
  if (part >= PART_ALERTE) return 'proche';
  return 'calme';
}

/* Les trois classes d'opérations R2, telles que Cloudflare les facture.
   Les listes sont recopiées de sa page de tarifs plutôt que devinées d'après
   le verbe : `ListBuckets` est une lecture qui coûte le prix d'une écriture,
   et `DeleteObject` une écriture qui ne coûte rien. Deviner aurait mis les
   deux du mauvais côté. */
const R2_CLASSE_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject',
  'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition',
  'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
  'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
const R2_CLASSE_B = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary',
  'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
const R2_GRATUITES = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

/** La classe de facturation d'une opération R2 : 'A', 'B' ou 'gratuite'.

    Une opération que Cloudflare inventera demain tombe en classe A, la moins
    dotée : l'estimation penche alors du côté prudent plutôt que de laisser
    grossir en silence un poste qu'on ne compte pas. */
export function classeOperationR2(actionType) {
  if (R2_GRATUITES.has(actionType)) return 'gratuite';
  if (R2_CLASSE_B.has(actionType)) return 'B';
  return 'A';
}

/* Deux façons de borner le temps, imposées par Cloudflare et non choisies :
   ses jeux D1 ne se filtrent que par DATE (`date_geq`, en AAAA-MM-JJ), les
   autres par instant (`datetime_geq`, en ISO complet). C'est un `datetime_geq`
   posé sur D1 qui a fait rejeter la première version. */
const envoi = (cle, jeu, corps, { parDate = false, debut, fin }) => ({
  cle,
  query: `
    query Consommation($compte: String!, $debut: ${parDate ? 'Date' : 'Time'}!, $fin: ${parDate ? 'Date' : 'Time'}!) {
      viewer {
        accounts(filter: { accountTag: $compte }) {
          ${jeu}(
            limit: ${jeu === 'r2OperationsAdaptiveGroups' ? 100 : 1}
            filter: { ${parDate ? 'date_geq: $debut, date_leq: $fin' : 'datetime_geq: $debut, datetime_leq: $fin'} }
          ) ${corps}
        }
      }
    }`,
  variables: { compte: null, debut, fin },
  jeu,
});

/** Les cinq envois à faire, un par jeu de données.

    Chacun porte sa clé — celle sous laquelle `normaliser` ira chercher sa
    réponse — sa requête et ses variables. Les fenêtres diffèrent parce que les
    forfaits ne se remettent pas à zéro au même rythme : Workers et D1 à la
    journée, le stockage et les opérations R2 au mois. */
export function requetes({ idCompte, debutJour, debutMois, maintenant, jour, mois }) {
  const liste = [
    envoi('workers', 'workersInvocationsAdaptive', '{ sum { requests } }',
      { debut: debutJour, fin: maintenant }),
    envoi('d1Lignes', 'd1AnalyticsAdaptiveGroups', '{ sum { rowsRead rowsWritten } }',
      { parDate: true, debut: jour, fin: jour }),
    envoi('d1Taille', 'd1StorageAdaptiveGroups', '{ max { databaseSizeBytes } }',
      { parDate: true, debut: jour, fin: jour }),
    envoi('r2Stockage', 'r2StorageAdaptiveGroups', '{ max { payloadSize objectCount } }',
      { debut: debutMois, fin: maintenant }),
    envoi('r2Operations', 'r2OperationsAdaptiveGroups',
      '{ dimensions { actionType } sum { requests } }',
      { debut: debutMois, fin: maintenant }),
  ];
  // Le compte est le même partout : posé ici plutôt que répété cinq fois.
  for (const e of liste) e.variables.compte = idCompte;
  // `mois` n'est pas utilisé : les jeux R2 se filtrent par instant, pas par
  // date. Il reste accepté en entrée pour que l'appelant calcule ses bornes
  // d'un seul tenant, sans avoir à savoir lesquelles serviront.
  void mois;
  return liste;
}

/* Lecture défensive : un jeu peut manquer, un champ être renommé, un compte
   n'avoir aucun trafic depuis minuit et rendre un tableau vide plutôt que des
   zéros. Toutes ces formes doivent donner un nombre. */
const nombre = (valeur) => (Number.isFinite(valeur) ? valeur : 0);

/** Extrait le premier groupe d'une réponse, ou dit pourquoi il n'y en a pas.

    Rend `{ groupe }` ou `{ erreur }`. La distinction compte : un tableau vide
    est un vrai zéro — personne n'a rien consommé — là où une réponse sans
    compte est une panne de configuration. Les confondre afficherait « 0 »
    rassurant sur un compteur qui n'a simplement pas été lu. */
function lire(reponse, jeu) {
  if (!reponse) return { erreur: 'Aucune réponse pour ce jeu de données.' };
  if (reponse.erreur) return { erreur: reponse.erreur };
  const comptes = reponse.charge?.data?.viewer?.accounts;
  if (!Array.isArray(comptes) || !comptes.length) {
    return { erreur: "Aucun compte dans la réponse : l'identifiant de compte est-il le bon ?" };
  }
  const groupes = comptes[0][jeu];
  return { groupe: (Array.isArray(groupes) ? groupes[0] : null) || {}, groupes: groupes || [] };
}

function mesurer(libelle, valeur, plafond, { unite = 'nombre', periode = 'jour', erreur } = {}) {
  // `valeur: null` et non zéro quand la lecture a échoué : un zéro affirmerait
  // que rien n'a été consommé, ce qu'on ne sait justement pas.
  if (erreur) return { libelle, valeur: null, plafond, unite, periode, part: 0, niveau: 'calme', erreur };
  const part = plafond > 0 ? valeur / plafond : 0;
  return { libelle, valeur, plafond, unite, periode, part, niveau: niveau(part) };
}

/** Traduit les cinq réponses en trois services et leurs mesures.

    `reponses` est un objet dont chaque clé est celle d'un envoi, et chaque
    valeur soit `{ charge }` — la réponse GraphQL — soit `{ erreur }`.

    La forme rendue est celle que le panneau affiche directement : chaque mesure
    porte sa valeur, son plafond, la part consommée, sa période de remise à zéro
    et son niveau d'alerte — ou son erreur. Le navigateur n'a plus rien à
    calculer, et surtout aucun seuil à connaître : ils vivent ici seulement. */
export function normaliser(reponses, { releveLe }) {
  const workers = lire(reponses.workers, 'workersInvocationsAdaptive');
  const d1Lignes = lire(reponses.d1Lignes, 'd1AnalyticsAdaptiveGroups');
  const d1Taille = lire(reponses.d1Taille, 'd1StorageAdaptiveGroups');
  const r2Stockage = lire(reponses.r2Stockage, 'r2StorageAdaptiveGroups');
  const r2Operations = lire(reponses.r2Operations, 'r2OperationsAdaptiveGroups');

  // Les opérations arrivent en une ligne par type d'action : on les replie sur
  // les deux classes facturées, en laissant tomber les gratuites.
  const ops = { A: 0, B: 0 };
  for (const groupe of r2Operations.groupes || []) {
    const classe = classeOperationR2(groupe?.dimensions?.actionType);
    if (classe === 'gratuite') continue;
    ops[classe] += nombre(groupe?.sum?.requests);
  }

  return {
    releveLe,
    services: [
      {
        nom: 'Workers',
        mesures: [
          mesurer('Requêtes', nombre(workers.groupe?.sum?.requests),
            SEUILS.workersRequetesParJour, { erreur: workers.erreur }),
        ],
      },
      {
        nom: 'D1',
        mesures: [
          mesurer('Lignes lues', nombre(d1Lignes.groupe?.sum?.rowsRead),
            SEUILS.d1LignesLuesParJour, { erreur: d1Lignes.erreur }),
          mesurer('Lignes écrites', nombre(d1Lignes.groupe?.sum?.rowsWritten),
            SEUILS.d1LignesEcritesParJour, { erreur: d1Lignes.erreur }),
          mesurer('Taille de la base', nombre(d1Taille.groupe?.max?.databaseSizeBytes),
            SEUILS.d1TailleOctets,
            { unite: 'octets', periode: 'instantane', erreur: d1Taille.erreur }),
        ],
      },
      {
        nom: 'R2',
        mesures: [
          mesurer('Stockage', nombre(r2Stockage.groupe?.max?.payloadSize),
            SEUILS.r2StockageOctets,
            { unite: 'octets', periode: 'mois', erreur: r2Stockage.erreur }),
          mesurer('Fichiers', nombre(r2Stockage.groupe?.max?.objectCount), 0,
            { periode: 'instantane', erreur: r2Stockage.erreur }),
          mesurer('Opérations classe A', ops.A, SEUILS.r2OperationsAParMois,
            { periode: 'mois', erreur: r2Operations.erreur }),
          mesurer('Opérations classe B', ops.B, SEUILS.r2OperationsBParMois,
            { periode: 'mois', erreur: r2Operations.erreur }),
        ],
      },
    ],
  };
}
