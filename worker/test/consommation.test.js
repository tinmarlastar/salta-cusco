import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEUILS, niveau, classeOperationR2, requeteGraphQL, normaliser,
} from '../lib/consommation.js';

/* Une réponse de l'API GraphQL de Cloudflare telle qu'elle arrive : le compte
   est un tableau d'un seul élément, chaque jeu de données un tableau de
   groupes. Les valeurs sont plausibles pour ce voyage — quelques milliers de
   requêtes, trois giga-octets de photos et de vidéos. */
const CHARGE = {
  data: {
    viewer: {
      accounts: [{
        workersInvocationsAdaptive: [{ sum: { requests: 4210 } }],
        d1AnalyticsAdaptiveGroups: [{
          sum: { rowsRead: 120000, rowsWritten: 3400 },
          max: { databaseSizeBytes: 262144 },
        }],
        r2StorageAdaptiveGroups: [{ max: { payloadSize: 3221225472, objectCount: 412 } }],
        r2OperationsAdaptiveGroups: [
          { dimensions: { actionType: 'PutObject' }, sum: { requests: 900 } },
          { dimensions: { actionType: 'GetObject' }, sum: { requests: 51000 } },
          { dimensions: { actionType: 'ListObjects' }, sum: { requests: 40 } },
        ],
      }],
    },
  },
};

const RELEVE_LE = '2026-08-27T09:00:00.000Z';

function mesure(rapport, nomService, libelle) {
  const service = rapport.services.find((s) => s.nom === nomService);
  assert.ok(service, `service ${nomService} absent`);
  const trouvee = service.mesures.find((m) => m.libelle === libelle);
  assert.ok(trouvee, `mesure « ${libelle} » absente de ${nomService}`);
  return trouvee;
}

// ------------------------------------------------------------------ niveau

test('niveau reste calme tant qu\'on est loin du plafond', () => {
  assert.equal(niveau(0), 'calme');
  assert.equal(niveau(0.42), 'calme');
  assert.equal(niveau(0.799), 'calme');
});

test('niveau alerte à partir de quatre cinquièmes du plafond', () => {
  assert.equal(niveau(0.8), 'proche');
  assert.equal(niveau(0.99), 'proche');
});

test('niveau distingue le dépassement de la simple approche', () => {
  assert.equal(niveau(1), 'depasse');
  assert.equal(niveau(3.5), 'depasse');
});

// ------------------------------------------------- classement des opérations

test('classeOperationR2 range les écritures en classe A et les lectures en B', () => {
  for (const action of ['PutObject', 'ListObjects', 'CopyObject', 'UploadPart',
    'CreateMultipartUpload', 'CompleteMultipartUpload', 'ListBuckets']) {
    assert.equal(classeOperationR2(action), 'A', action);
  }
  for (const action of ['GetObject', 'HeadObject', 'HeadBucket', 'UsageSummary']) {
    assert.equal(classeOperationR2(action), 'B', action);
  }
});

/* Trois classes et non deux : Cloudflare facture les suppressions ZÉRO, et les
   compter en A aurait fait monter une jauge sur des opérations qui ne coûtent
   rien. Le carnet en fait à chaque modération. */
test('classeOperationR2 reconnaît les opérations que Cloudflare ne facture pas', () => {
  for (const action of ['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']) {
    assert.equal(classeOperationR2(action), 'gratuite', action);
  }
});

/* Cloudflare peut nommer demain une opération que ce module ne connaît pas.
   La ranger en A — la classe la plus chère et la moins dotée — fait pencher
   l'estimation du côté prudent : on s'alarmera un peu tôt plutôt que d'annoncer
   à tort qu'il reste de la marge. */
test('classeOperationR2 range une opération inconnue du côté prudent', () => {
  assert.equal(classeOperationR2('OperationQueCloudflareInventera'), 'A');
});

// ------------------------------------------------------------- la requête

test('requeteGraphQL vise le compte et les deux fenêtres de temps', () => {
  const { query, variables } = requeteGraphQL({
    idCompte: 'abc123',
    debutJour: '2026-08-27T00:00:00Z',
    debutMois: '2026-08-01T00:00:00Z',
    maintenant: '2026-08-27T09:00:00Z',
  });

  assert.equal(variables.compte, 'abc123');
  assert.equal(variables.debutJour, '2026-08-27T00:00:00Z');
  assert.equal(variables.debutMois, '2026-08-01T00:00:00Z');
  assert.equal(variables.maintenant, '2026-08-27T09:00:00Z');

  // Les quatre jeux de données doivent être demandés : sans l'un d'eux, le
  // panneau afficherait un service muet sans dire pourquoi.
  for (const jeu of ['workersInvocationsAdaptive', 'd1AnalyticsAdaptiveGroups',
    'r2StorageAdaptiveGroups', 'r2OperationsAdaptiveGroups']) {
    assert.ok(query.includes(jeu), `${jeu} absent de la requête`);
  }
});

// --------------------------------------------------------- normalisation

test('normaliser rend les trois services et l\'heure du relevé', () => {
  const rapport = normaliser(CHARGE, { releveLe: RELEVE_LE });
  assert.deepEqual(rapport.services.map((s) => s.nom), ['Workers', 'D1', 'R2']);
  assert.equal(rapport.releveLe, RELEVE_LE);
});

test('normaliser situe les requêtes Workers dans le forfait du jour', () => {
  const m = mesure(normaliser(CHARGE, { releveLe: RELEVE_LE }), 'Workers', 'Requêtes');
  assert.equal(m.valeur, 4210);
  assert.equal(m.plafond, SEUILS.workersRequetesParJour);
  assert.equal(m.periode, 'jour');
  assert.equal(m.unite, 'nombre');
  assert.equal(m.niveau, 'calme');
});

test('normaliser sépare les lignes lues des lignes écrites de D1', () => {
  const rapport = normaliser(CHARGE, { releveLe: RELEVE_LE });
  assert.equal(mesure(rapport, 'D1', 'Lignes lues').valeur, 120000);
  assert.equal(mesure(rapport, 'D1', 'Lignes écrites').valeur, 3400);
  assert.equal(mesure(rapport, 'D1', 'Lignes écrites').plafond, SEUILS.d1LignesEcritesParJour);
});

test('normaliser donne la taille de la base en octets', () => {
  const m = mesure(normaliser(CHARGE, { releveLe: RELEVE_LE }), 'D1', 'Taille de la base');
  assert.equal(m.valeur, 262144);
  assert.equal(m.unite, 'octets');
  assert.equal(m.periode, 'instantane');
});

/* Cloudflare écrit « 10 GB-month » sans jamais dire si son GB vaut 10⁹ ou 2³⁰.
   Le module tranche pour le décimal, c'est-à-dire pour la lecture la plus
   SÉVÈRE : elle rend le forfait plus petit de 7 %, donc la jauge monte plus
   vite. Se tromper dans ce sens fait s'inquiéter un peu tôt ; se tromper dans
   l'autre ferait annoncer de la marge qui n'existe pas. Ce test épingle le
   choix pour qu'une retouche future soit délibérée. */
test('les forfaits de stockage se comptent en unités décimales', () => {
  assert.equal(SEUILS.r2StockageOctets, 10_000_000_000);
  assert.equal(SEUILS.d1TailleOctets, 5_000_000_000);
});

test('normaliser rapporte le stockage R2 à son forfait', () => {
  const m = mesure(normaliser(CHARGE, { releveLe: RELEVE_LE }), 'R2', 'Stockage');
  assert.equal(m.valeur, 3221225472);
  assert.equal(m.plafond, SEUILS.r2StockageOctets);
  assert.equal(m.unite, 'octets');
  assert.equal(m.part, 3221225472 / SEUILS.r2StockageOctets);
});

test('normaliser additionne les opérations R2 par classe', () => {
  const rapport = normaliser(CHARGE, { releveLe: RELEVE_LE });
  // PutObject (900) et ListObjects (40) sont en classe A ; GetObject seul en B.
  assert.equal(mesure(rapport, 'R2', 'Opérations classe A').valeur, 940);
  assert.equal(mesure(rapport, 'R2', 'Opérations classe B').valeur, 51000);
  assert.equal(mesure(rapport, 'R2', 'Opérations classe A').periode, 'mois');
});

/* Les suppressions ne coûtent rien : les faire entrer dans une jauge aurait
   donné à croire qu'une séance de modération entame le forfait. */
test('normaliser laisse les opérations gratuites hors des deux jauges', () => {
  const avecSuppressions = structuredClone(CHARGE);
  avecSuppressions.data.viewer.accounts[0].r2OperationsAdaptiveGroups.push({
    dimensions: { actionType: 'DeleteObject' }, sum: { requests: 7000 },
  });
  const rapport = normaliser(avecSuppressions, { releveLe: RELEVE_LE });
  assert.equal(mesure(rapport, 'R2', 'Opérations classe A').valeur, 940);
  assert.equal(mesure(rapport, 'R2', 'Opérations classe B').valeur, 51000);
});

test('normaliser marque une mesure qui frôle son plafond', () => {
  const presqueDepasse = structuredClone(CHARGE);
  presqueDepasse.data.viewer.accounts[0].r2StorageAdaptiveGroups[0].max.payloadSize
    = Math.round(SEUILS.r2StockageOctets * 0.9);
  const m = mesure(normaliser(presqueDepasse, { releveLe: RELEVE_LE }), 'R2', 'Stockage');
  assert.equal(m.niveau, 'proche');
});

/* Un compte qui n'a rien consommé depuis minuit renvoie des tableaux vides, et
   non des zéros. Sans ce cas, le panneau tombait en marche le matin — au moment
   précis où l'on ouvre la page pour vérifier que tout va bien. */
test('normaliser lit un compte sans trafic comme des zéros', () => {
  const vide = {
    data: {
      viewer: {
        accounts: [{
          workersInvocationsAdaptive: [],
          d1AnalyticsAdaptiveGroups: [],
          r2StorageAdaptiveGroups: [],
          r2OperationsAdaptiveGroups: [],
        }],
      },
    },
  };
  const rapport = normaliser(vide, { releveLe: RELEVE_LE });
  assert.equal(mesure(rapport, 'Workers', 'Requêtes').valeur, 0);
  assert.equal(mesure(rapport, 'D1', 'Lignes lues').valeur, 0);
  assert.equal(mesure(rapport, 'R2', 'Stockage').valeur, 0);
  assert.equal(mesure(rapport, 'R2', 'Opérations classe B').valeur, 0);
});

/* Cloudflare peut renommer un champ ou en retirer un d'une offre à l'autre.
   Le panneau doit alors afficher les mesures qu'il a comprises plutôt que de
   refuser d'apparaître : une jauge manquante se voit, une page blanche
   n'apprend rien. */
test('normaliser survit à un jeu de données absent de la réponse', () => {
  const partielle = {
    data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 12 } }] }] } },
  };
  const rapport = normaliser(partielle, { releveLe: RELEVE_LE });
  assert.equal(mesure(rapport, 'Workers', 'Requêtes').valeur, 12);
  assert.equal(mesure(rapport, 'R2', 'Stockage').valeur, 0);
});

test('normaliser refuse une réponse sans compte plutôt que d\'inventer des zéros', () => {
  assert.throws(() => normaliser({ data: { viewer: { accounts: [] } } }, { releveLe: RELEVE_LE }),
    /compte/i);
});
