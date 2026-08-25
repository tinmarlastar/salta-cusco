import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dateParisDuJour, joursEntre, calculerPositionAuto, dateDuJourVoyage,
} from '../lib/position.js';

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

test('dateDuJourVoyage rend la date de départ pour J1, et J15 quatorze jours plus tard', () => {
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', jour: 1 }), '2026-09-01');
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', jour: 15 }), '2026-09-15');
});

test('dateDuJourVoyage franchit les fins de mois', () => {
  assert.equal(dateDuJourVoyage({ depart: '2026-08-25', jour: 15 }), '2026-09-08');
  assert.equal(dateDuJourVoyage({ depart: '2026-12-28', jour: 15 }), '2027-01-11');
});

test('dateDuJourVoyage recule la date quand le voyage a de l\'avance', () => {
  // Deux jours d'avance : on en est à J1 deux jours avant la date posée.
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', decalage: 2, jour: 1 }), '2026-08-30');
  // Deux jours de retard : J1 arrive deux jours plus tard.
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', decalage: -2, jour: 1 }), '2026-09-03');
});

// Le garde-fou qui compte : la date annoncée doit être celle où la frise
// bascule pour de bon. Les deux fonctions se lisent l'une l'autre, décalage
// compris — c'est ce que la contradiction à l'écran coûterait le plus cher.
test('dateDuJourVoyage désigne bien le jour où calculerPositionAuto bascule', () => {
  for (const decalage of [-3, 0, 3]) {
    for (const jour of [1, 15]) {
      const date = dateDuJourVoyage({ depart: '2026-09-01', decalage, jour });
      assert.equal(calculerPositionAuto({
        depart: '2026-09-01', decalage, maintenant: new Date(`${date}T10:00:00Z`),
      }), jour, `décalage ${decalage}, jour ${jour}`);
    }
  }
});
