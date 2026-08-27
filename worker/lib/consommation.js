/* Consommation Cloudflare : ce que le compte a dépensé, et ce que l'offre
   gratuite laisse dépenser.

   Fonctions pures, sans accès réseau — testables directement, comme
   lib/securite.js et lib/position.js. L'appel à l'API GraphQL de Cloudflare
   vit dans index.js ; ici on ne fait que FORMER la requête et LIRE la réponse.
   Cette coupure a une raison pratique : la réponse de Cloudflare est un
   empilement de tableaux imbriqués dont chaque niveau peut manquer, et c'est
   exactement le genre de code qu'on veut éprouver sous `node --test` plutôt
   qu'en production, à 4 000 mètres, sur la seule page qui dit si le service
   tient encore. */

/* Les forfaits de l'offre gratuite, en un seul endroit.

   ATTENTION : ces valeurs sont celles relevées dans la documentation
   Cloudflare en août 2026. Elles bougent — Cloudflare les a déjà relevées
   plusieurs fois — et rien ici ne les vérifie automatiquement. Si le panneau
   annonce un jour une marge qui ne correspond plus au tableau de bord, c'est
   cette table qu'il faut revoir en premier, et non le calcul.

   Le giga-octet est pris pour 10⁹ octets et non 2³⁰. Cloudflare écrit
   « 10 GB-month » sans jamais préciser lequel des deux : on choisit donc la
   lecture la plus sévère, qui rend le forfait plus petit de 7 % et fait monter
   la jauge plus vite. Se tromper de ce côté fait s'inquiéter un peu tôt ; se
   tromper de l'autre ferait annoncer de la marge qui n'existe pas. */
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

/** La requête posée à l'API GraphQL de Cloudflare.

    Deux fenêtres de temps, parce que les forfaits ne se remettent pas à zéro
    au même rythme : Workers et D1 se comptent à la journée, le stockage et les
    opérations R2 au mois. Les demander en une seule requête évite trois
    allers-retours depuis un Worker qui a dix millisecondes de processeur.

    `limit` vaut 1 pour les jeux qu'on agrège en bloc, et 100 pour les
    opérations R2, dont on veut le détail par type d'action — c'est lui qui
    permet de les répartir par classe. */
export function requeteGraphQL({ idCompte, debutJour, debutMois, maintenant }) {
  const query = `
    query Consommation($compte: String!, $debutJour: Time!, $debutMois: Time!, $maintenant: Time!) {
      viewer {
        accounts(filter: { accountTag: $compte }) {
          workersInvocationsAdaptive(
            limit: 1
            filter: { datetime_geq: $debutJour, datetime_leq: $maintenant }
          ) {
            sum { requests }
          }
          d1AnalyticsAdaptiveGroups(
            limit: 1
            filter: { datetime_geq: $debutJour, datetime_leq: $maintenant }
          ) {
            sum { rowsRead rowsWritten }
            max { databaseSizeBytes }
          }
          r2StorageAdaptiveGroups(
            limit: 1
            filter: { datetime_geq: $debutMois, datetime_leq: $maintenant }
          ) {
            max { payloadSize objectCount }
          }
          r2OperationsAdaptiveGroups(
            limit: 100
            filter: { datetime_geq: $debutMois, datetime_leq: $maintenant }
          ) {
            dimensions { actionType }
            sum { requests }
          }
        }
      }
    }`;
  return { query, variables: { compte: idCompte, debutJour, debutMois, maintenant } };
}

/* Lecture défensive de la réponse. Chaque niveau peut manquer : un jeu de
   données qu'une offre ne sert pas, un champ renommé, un compte sans trafic
   depuis minuit qui rend un tableau vide plutôt que des zéros. Toutes ces
   formes doivent donner un nombre, sans quoi le panneau entier disparaîtrait
   pour un champ absent. */
const nombre = (valeur) => (Number.isFinite(valeur) ? valeur : 0);
const premierGroupe = (compte, jeu) => (Array.isArray(compte[jeu]) ? compte[jeu][0] : null) || {};

function mesurer(libelle, valeur, plafond, { unite = 'nombre', periode = 'jour' } = {}) {
  const part = plafond > 0 ? valeur / plafond : 0;
  return { libelle, valeur, plafond, unite, periode, part, niveau: niveau(part) };
}

/** Traduit la réponse de Cloudflare en trois services et leurs mesures.

    La forme rendue est celle que le panneau d'administration affiche
    directement : chaque mesure porte sa valeur, son plafond, la part
    consommée, sa période de remise à zéro et son niveau d'alerte. Le
    navigateur n'a plus rien à calculer, et surtout plus aucun seuil à
    connaître — ils vivent ici, en un seul endroit. */
export function normaliser(charge, { releveLe }) {
  const comptes = charge?.data?.viewer?.accounts;
  if (!Array.isArray(comptes) || !comptes.length) {
    throw new Error("La réponse de Cloudflare ne contient aucun compte : l'identifiant de compte est-il le bon ?");
  }
  const compte = comptes[0];

  const workers = premierGroupe(compte, 'workersInvocationsAdaptive');
  const d1 = premierGroupe(compte, 'd1AnalyticsAdaptiveGroups');
  const r2 = premierGroupe(compte, 'r2StorageAdaptiveGroups');

  // Les opérations arrivent en une ligne par type d'action : on les replie sur
  // les deux classes facturées, en laissant tomber les gratuites.
  const operations = { A: 0, B: 0 };
  for (const groupe of compte.r2OperationsAdaptiveGroups || []) {
    const classe = classeOperationR2(groupe?.dimensions?.actionType);
    if (classe === 'gratuite') continue;
    operations[classe] += nombre(groupe?.sum?.requests);
  }

  return {
    releveLe,
    services: [
      {
        nom: 'Workers',
        mesures: [
          mesurer('Requêtes', nombre(workers.sum?.requests), SEUILS.workersRequetesParJour),
        ],
      },
      {
        nom: 'D1',
        mesures: [
          mesurer('Lignes lues', nombre(d1.sum?.rowsRead), SEUILS.d1LignesLuesParJour),
          mesurer('Lignes écrites', nombre(d1.sum?.rowsWritten), SEUILS.d1LignesEcritesParJour),
          mesurer('Taille de la base', nombre(d1.max?.databaseSizeBytes), SEUILS.d1TailleOctets,
            { unite: 'octets', periode: 'instantane' }),
        ],
      },
      {
        nom: 'R2',
        mesures: [
          mesurer('Stockage', nombre(r2.max?.payloadSize), SEUILS.r2StockageOctets,
            { unite: 'octets', periode: 'mois' }),
          mesurer('Fichiers', nombre(r2.max?.objectCount), 0,
            { unite: 'nombre', periode: 'instantane' }),
          mesurer('Opérations classe A', operations.A, SEUILS.r2OperationsAParMois,
            { periode: 'mois' }),
          mesurer('Opérations classe B', operations.B, SEUILS.r2OperationsBParMois,
            { periode: 'mois' }),
        ],
      },
    ],
  };
}
