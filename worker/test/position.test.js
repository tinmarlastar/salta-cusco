import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dateParisDuJour, joursEntre, calculerPositionAuto } from '../lib/position.js';

test('dateParisDuJour formate en AAAA-MM-JJ', () => {
  assert.match(dateParisDuJour(new Date('2026-09-01T10:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dateParisDuJour(new Date('2026-09-01T21:59:00Z')), '2026-09-01'); // 23:59 Paris (CEST, UTC+2)
  assert.equal(dateParisDuJour(new Date('2026-09-01T22:00:00Z')), '2026-09-02'); // 00:00 Paris (CEST, UTC+2)
});

test('joursEntre compte les jours calendaires entre deux dates', () => {
  assert.equal(joursEntre('2026-09-01', '2026-09-01'), 0);
  assert.equal(joursEntre('2026-09-01', '2026-09-08'), 7);
  assert.equal(joursEntre('2026-09-01', '2026-08-31'), -1);
});

test('calculerPositionAuto place J1 le jour du départ', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-09-01T10:00:00Z'),
  });
  assert.equal(jour, 1);
});

test('calculerPositionAuto avance d\'une journée par jour écoulé', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-09-08T10:00:00Z'),
  });
  assert.equal(jour, 8);
});

test('calculerPositionAuto renvoie null avant le départ', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-08-31T10:00:00Z'),
  });
  assert.equal(jour, null);
});

test('calculerPositionAuto plafonne à 15 une fois le voyage fini', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', maintenant: new Date('2026-09-25T10:00:00Z'),
  });
  assert.equal(jour, 15);
});

test('calculerPositionAuto applique un décalage positif', () => {
  const jour = calculerPositionAuto({
    depart: '2026-09-01', decalage: 2, maintenant: new Date('2026-09-01T10:00:00Z'),
  });
  assert.equal(jour, 3);
});

test('calculerPositionAuto applique un décalage négatif, jusqu\'à repasser sous J1', () => {
  assert.equal(calculerPositionAuto({
    depart: '2026-09-01', decalage: -1, maintenant: new Date('2026-09-01T10:00:00Z'),
  }), null);
  assert.equal(calculerPositionAuto({
    depart: '2026-09-01', decalage: -1, maintenant: new Date('2026-09-02T10:00:00Z'),
  }), 1);
});
