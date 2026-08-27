import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEUILS, niveau, classeOperationR2, requetes, normaliser,
} from '../lib/consommation.js';

const FENETRE = {
  idCompte: 'abc123',
  debutJour: '2026-08-27T00:00:00Z',
  debutMois: '2026-08-01T00:00:00Z',
  maintenant: '2026-08-27T09:00:00Z',
  jour: '2026-08-27',
  mois: '2026-08-01',
};

const RELEVE_LE = '2026-08-27T09:00:00.000Z';

/* Ce que Cloudflare renvoie, une réponse par jeu de données. Chaque valeur est
   soit `{ charge }` — la réponse GraphQL telle quelle — soit `{ erreur }`,
   quand ce jeu-là n'a pas répondu. */
const REPONSES = {
  workers: { charge: compte({ workersInvocationsAdaptive: [{ sum: { requests: 4210 } }] }) },
  d1Lignes: { charge: compte({ d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 120000, rowsWritten: 3400 } }] }) },
  d1Taille: { charge: compte({ d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 262144 } }] }) },
  r2Stockage: { charge: compte({ r2StorageAdaptiveGroups: [{ max: { payloadSize: 3221225472, objectCount: 412 } }] }) },
  r2Operations: {
    charge: compte({
      r2OperationsAdaptiveGroups: [
        { dimensions: { actionType: 'PutObject' }, sum: { requests: 900 } },
        { dimensions: { actionType: 'GetObject' }, sum: { requests: 51000 } },
        { dimensions: { actionType: 'ListObjects' }, sum: { requests: 40 } },
      ],
    }),
  },
};

function compte(jeux) {
  return { data: { viewer: { accounts: [jeux] } } };
}

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

// ------------------------------------------------------------- les requêtes

/* Une requête par jeu de données, et non une seule qui les demande tous.

   La raison est arrivée en production : une requête GraphQL dont UN champ est
   inconnu est rejetée EN ENTIER, avant d'être exécutée. Un `max` de trop sur
   le jeu D1 effaçait donc aussi les compteurs Workers et R2, qui eux étaient
   justes. Séparées, chaque mesure vit sa vie : celles qui répondent
   s'affichent, celle qui échoue dit pourquoi, à sa place. */
test('requetes rend un envoi par jeu de données', () => {
  const envois = requetes(FENETRE);
  assert.deepEqual(envois.map((e) => e.cle).sort(),
    ['d1Lignes', 'd1Taille', 'r2Operations', 'r2Stockage', 'workers']);
});

test('chaque envoi vise le compte et ne demande qu\'un seul jeu de données', () => {
  const jeux = {
    workers: 'workersInvocationsAdaptive',
    d1Lignes: 'd1AnalyticsAdaptiveGroups',
    d1Taille: 'd1StorageAdaptiveGroups',
    r2Stockage: 'r2StorageAdaptiveGroups',
    r2Operations: 'r2OperationsAdaptiveGroups',
  };
  for (const envoi of requetes(FENETRE)) {
    assert.equal(envoi.variables.compte, 'abc123', envoi.cle);
    assert.ok(envoi.query.includes(jeux[envoi.cle]), `${envoi.cle} ne demande pas son jeu`);
    for (const [cle, autre] of Object.entries(jeux)) {
      if (cle !== envoi.cle) {
        assert.ok(!envoi.query.includes(autre), `${envoi.cle} demande aussi ${autre}`);
      }
    }
  }
});

/* D1 se filtre par DATE, les autres par instant. Ce n'est pas un caprice : la
   documentation de Cloudflare ne montre que `date_geq` pour ses jeux D1, et
   c'est un `datetime_geq` posé là qui a fait rejeter la première version. */
test('les jeux D1 se filtrent par date, les autres par instant', () => {
  const parCle = Object.fromEntries(requetes(FENETRE).map((e) => [e.cle, e]));

  for (const cle of ['d1Lignes', 'd1Taille']) {
    assert.ok(parCle[cle].query.includes('date_geq'), `${cle} devrait filtrer par date`);
    assert.ok(!parCle[cle].query.includes('datetime_geq'), `${cle} ne doit pas filtrer par instant`);
    assert.equal(parCle[cle].variables.debut, '2026-08-27');
  }
  for (const cle of ['workers', 'r2Stockage', 'r2Operations']) {
    assert.ok(parCle[cle].query.includes('datetime_geq'), `${cle} devrait filtrer par instant`);
  }
});

test('R2 se compte sur le mois, Workers et D1 sur la journée', () => {
  const parCle = Object.fromEntries(requetes(FENETRE).map((e) => [e.cle, e]));
  assert.equal(parCle.workers.variables.debut, '2026-08-27T00:00:00Z');
  assert.equal(parCle.r2Stockage.variables.debut, '2026-08-01T00:00:00Z');
  assert.equal(parCle.r2Operations.variables.debut, '2026-08-01T00:00:00Z');
});

// --------------------------------------------------------- normalisation

test('normaliser rend les trois services et l\'heure du relevé', () => {
  const rapport = normaliser(REPONSES, { releveLe: RELEVE_LE });
  assert.deepEqual(rapport.services.map((s) => s.nom), ['Workers', 'D1', 'R2']);
  assert.equal(rapport.releveLe, RELEVE_LE);
});

test('normaliser situe les requêtes Workers dans le forfait du jour', () => {
  const m = mesure(normaliser(REPONSES, { releveLe: RELEVE_LE }), 'Workers', 'Requêtes');
  assert.equal(m.valeur, 4210);
  assert.equal(m.plafond, SEUILS.workersRequetesParJour);
  assert.equal(m.periode, 'jour');
  assert.equal(m.unite, 'nombre');
  assert.equal(m.niveau, 'calme');
});

test('normaliser sépare les lignes lues des lignes écrites de D1', () => {
  const rapport = normaliser(REPONSES, { releveLe: RELEVE_LE });
  assert.equal(mesure(rapport, 'D1', 'Lignes lues').valeur, 120000);
  assert.equal(mesure(rapport, 'D1', 'Lignes écrites').valeur, 3400);
  assert.equal(mesure(rapport, 'D1', 'Lignes écrites').plafond, SEUILS.d1LignesEcritesParJour);
});

test('normaliser lit la taille de la base dans son jeu de données à elle', () => {
  const m = mesure(normaliser(REPONSES, { releveLe: RELEVE_LE }), 'D1', 'Taille de la base');
  assert.equal(m.valeur, 262144);
  assert.equal(m.unite, 'octets');
  assert.equal(m.periode, 'instantane');
});

/* Cloudflare écrit « 10 GB-month » sans jamais dire si son GB vaut 10⁹ ou 2³⁰.
   Le module tranche pour le décimal, c'est-à-dire pour la lecture la plus
   SÉVÈRE : elle rend le forfait plus petit de 7 %, donc la jauge monte plus
   vite. Se tromper dans ce sens fait s'inquiéter un peu tôt ; se tromper dans
   l'autre ferait annoncer de la marge qui n'existe pas. */
test('les forfaits de stockage se comptent en unités décimales', () => {
  assert.equal(SEUILS.r2StockageOctets, 10_000_000_000);
  assert.equal(SEUILS.d1TailleOctets, 5_000_000_000);
});

test('normaliser rapporte le stockage R2 à son forfait', () => {
  const m = mesure(normaliser(REPONSES, { releveLe: RELEVE_LE }), 'R2', 'Stockage');
  assert.equal(m.valeur, 3221225472);
  assert.equal(m.part, 3221225472 / SEUILS.r2StockageOctets);
});

test('normaliser additionne les opérations R2 par classe', () => {
  const rapport = normaliser(REPONSES, { releveLe: RELEVE_LE });
  assert.equal(mesure(rapport, 'R2', 'Opérations classe A').valeur, 940);
  assert.equal(mesure(rapport, 'R2', 'Opérations classe B').valeur, 51000);
  assert.equal(mesure(rapport, 'R2', 'Opérations classe A').periode, 'mois');
});

test('normaliser laisse les opérations gratuites hors des deux jauges', () => {
  const avec = structuredClone(REPONSES);
  avec.r2Operations.charge.data.viewer.accounts[0].r2OperationsAdaptiveGroups.push({
    dimensions: { actionType: 'DeleteObject' }, sum: { requests: 7000 },
  });
  const rapport = normaliser(avec, { releveLe: RELEVE_LE });
  assert.equal(mesure(rapport, 'R2', 'Opérations classe A').valeur, 940);
  assert.equal(mesure(rapport, 'R2', 'Opérations classe B').valeur, 51000);
});

test('normaliser marque une mesure qui frôle son plafond', () => {
  const presque = structuredClone(REPONSES);
  presque.r2Stockage.charge.data.viewer.accounts[0].r2StorageAdaptiveGroups[0].max.payloadSize
    = Math.round(SEUILS.r2StockageOctets * 0.9);
  assert.equal(mesure(normaliser(presque, { releveLe: RELEVE_LE }), 'R2', 'Stockage').niveau, 'proche');
});

// ------------------------------------------------- ce qui n'a pas répondu

/* Le cœur de la reprise : un jeu de données en erreur n'emporte plus les
   autres. C'est exactement ce qui est arrivé en production — un `max` inconnu
   sur D1 effaçait Workers et R2, qui eux répondaient. */
test('un jeu en erreur laisse vivre les autres services', () => {
  const partiel = { ...REPONSES, d1Lignes: { erreur: 'unknown field "rowsRead"' } };
  const rapport = normaliser(partiel, { releveLe: RELEVE_LE });

  assert.equal(mesure(rapport, 'Workers', 'Requêtes').valeur, 4210);
  assert.equal(mesure(rapport, 'R2', 'Stockage').valeur, 3221225472);
  assert.equal(mesure(rapport, 'D1', 'Taille de la base').valeur, 262144);
});

test('une mesure en erreur porte le message plutôt qu\'un faux zéro', () => {
  const partiel = { ...REPONSES, d1Lignes: { erreur: 'unknown field "rowsRead"' } };
  const m = mesure(normaliser(partiel, { releveLe: RELEVE_LE }), 'D1', 'Lignes lues');

  assert.equal(m.erreur, 'unknown field "rowsRead"');
  assert.equal(m.valeur, null, 'un zéro affirmerait à tort que rien n\'a été consommé');
});

test('normaliser lit un jeu sans trafic comme des zéros, pas comme une erreur', () => {
  const vide = { ...REPONSES, workers: { charge: compte({ workersInvocationsAdaptive: [] }) } };
  const m = mesure(normaliser(vide, { releveLe: RELEVE_LE }), 'Workers', 'Requêtes');
  assert.equal(m.valeur, 0);
  assert.equal(m.erreur, undefined);
});

test('normaliser signale un compte absent sur le jeu concerné, sans tout perdre', () => {
  const sansCompte = { ...REPONSES, workers: { charge: { data: { viewer: { accounts: [] } } } } };
  const rapport = normaliser(sansCompte, { releveLe: RELEVE_LE });

  assert.match(mesure(rapport, 'Workers', 'Requêtes').erreur, /compte/i);
  assert.equal(mesure(rapport, 'R2', 'Stockage').valeur, 3221225472);
});
