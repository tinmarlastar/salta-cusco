import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliserEtape, assemblerStatistiques } from '../lib/visites.js';

/* Ce que la base rend : une ligne par jour calendaire, une ligne par étape.
   Les jours arrivent dans l'ordre où SQLite les a trouvés, pas forcément dans
   l'ordre du calendrier — c'est au module de les ranger. */
const JOURS = [
  { date: '2026-08-29', visiteurs: 12, pages: 48 },
  { date: '2026-08-27', visiteurs: 5, pages: 11 },
  { date: '2026-08-28', visiteurs: 9, pages: 30 },
];

const ETAPES = [
  { etape: 0, pages: 40 },
  { etape: 7, pages: 25 },
  { etape: 1, pages: 24 },
];

const AUJOURDHUI = '2026-08-29';

// ------------------------------------------------- bornage de l'entrée

/* La route d'écriture est publique — c'est un site public. Ce qu'elle reçoit
   doit donc être borné AVANT de toucher à la base : sans ça, n'importe qui
   pourrait faire créer autant de lignes qu'il y a d'entiers. */
test('normaliserEtape accepte l\'accueil et les quinze journées', () => {
  assert.equal(normaliserEtape(0), 0);
  assert.equal(normaliserEtape(1), 1);
  assert.equal(normaliserEtape(15), 15);
  assert.equal(normaliserEtape('7'), 7, 'le JSON d\'un navigateur peut envoyer une chaîne');
});

test('normaliserEtape refuse ce qui sort du voyage', () => {
  assert.equal(normaliserEtape(16), null);
  assert.equal(normaliserEtape(-1), null);
  assert.equal(normaliserEtape(1.5), null);
  assert.equal(normaliserEtape('j7'), null);
  assert.equal(normaliserEtape(null), null);
  assert.equal(normaliserEtape(undefined), null);
  assert.equal(normaliserEtape(Number.MAX_SAFE_INTEGER), null);
});

// ------------------------------------------------------------- totaux

test('assemblerStatistiques additionne tous les jours', () => {
  const stats = assemblerStatistiques({ jours: JOURS, etapes: ETAPES }, { aujourdhui: AUJOURDHUI });
  assert.equal(stats.total.visiteurs, 26);
  assert.equal(stats.total.pages, 89);
});

test('assemblerStatistiques isole la journée en cours', () => {
  const stats = assemblerStatistiques({ jours: JOURS, etapes: ETAPES }, { aujourdhui: AUJOURDHUI });
  assert.deepEqual(stats.aujourdhui, { visiteurs: 12, pages: 48 });
});

/* Avant la première visite du jour, la base n'a pas encore de ligne pour
   aujourd'hui. Zéro est alors la vérité — pas une absence à afficher comme un
   trou dans le module. */
test('assemblerStatistiques rend zéro pour un jour sans aucune visite', () => {
  const stats = assemblerStatistiques({ jours: JOURS, etapes: ETAPES }, { aujourdhui: '2026-09-01' });
  assert.deepEqual(stats.aujourdhui, { visiteurs: 0, pages: 0 });
});

test('assemblerStatistiques range les jours dans l\'ordre du calendrier', () => {
  const stats = assemblerStatistiques({ jours: JOURS, etapes: ETAPES }, { aujourdhui: AUJOURDHUI });
  assert.deepEqual(stats.jours.map((j) => j.date),
    ['2026-08-27', '2026-08-28', '2026-08-29']);
});

// ------------------------------------------------------------- étapes

test('assemblerStatistiques classe les étapes de la plus lue à la moins lue', () => {
  const stats = assemblerStatistiques({ jours: JOURS, etapes: ETAPES }, { aujourdhui: AUJOURDHUI });
  assert.deepEqual(stats.etapes.map((e) => e.etape), [0, 7, 1]);
});

/* La part sert à dessiner une barre : elle se rapporte à l'étape la PLUS lue,
   et non au total. Rapportée au total, la première barre d'un classement de
   seize lignes n'aurait jamais dépassé le tiers de la largeur, et les
   dernières auraient été invisibles. */
test('assemblerStatistiques rapporte chaque étape à la plus lue', () => {
  const stats = assemblerStatistiques({ jours: JOURS, etapes: ETAPES }, { aujourdhui: AUJOURDHUI });
  assert.equal(stats.etapes[0].part, 1);
  assert.equal(stats.etapes[1].part, 25 / 40);
  assert.equal(stats.etapes[2].part, 24 / 40);
});

test('assemblerStatistiques ne divise pas par zéro quand rien n\'a été lu', () => {
  const stats = assemblerStatistiques({ jours: [], etapes: [{ etape: 3, pages: 0 }] },
    { aujourdhui: AUJOURDHUI });
  assert.equal(stats.etapes[0].part, 0);
});

// --------------------------------------------------------- cas limites

test('assemblerStatistiques survit à une base encore vide', () => {
  const stats = assemblerStatistiques({ jours: [], etapes: [] }, { aujourdhui: AUJOURDHUI });
  assert.deepEqual(stats.total, { visiteurs: 0, pages: 0 });
  assert.deepEqual(stats.aujourdhui, { visiteurs: 0, pages: 0 });
  assert.deepEqual(stats.jours, []);
  assert.deepEqual(stats.etapes, []);
});

test('assemblerStatistiques accepte des tableaux absents', () => {
  const stats = assemblerStatistiques({}, { aujourdhui: AUJOURDHUI });
  assert.deepEqual(stats.total, { visiteurs: 0, pages: 0 });
});
