import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dateParisDuJour, joursEntre, dateDuJourVoyage } from '../lib/position.js';

/* `calculerPositionAuto` n'est plus testée ici : depuis qu'elle bascule à 20 h
   dans le fuseau de la ville d'arrivée, son comportement ne se décrit plus par
   une date seule. Voir `fuseaux.test.js`, qui l'éprouve heure par heure sur les
   quatre pays du voyage. Ce fichier garde les fonctions de date pures. */

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

/* `depart` est la date où l'on QUITTE SALTA, c'est-à-dire celle de J2.

   J1 n'est pas une étape roulée — `ride: false`, zéro kilomètre, Salta → Salta :
   c'est la journée de rassemblement sur place. Elle se lit comme les autres sur
   le site, mais n'est jamais une position : le compteur ne s'en sert pas, et le
   menu de l'admin ne la propose pas. Faire partir le calendrier de J1 revenait
   à annoncer un départ de Salta le jour où l'on y arrive. */

/* La veille compte comme « pas encore partis », et non comme J1 : c'est bien
   le jour du rassemblement à Salta, mais le site n'en fait pas une position —
   il continue d'annoncer le départ à venir. */

test('dateDuJourVoyage rend la date de départ pour J2, et J15 treize jours plus tard', () => {
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', jour: 2 }), '2026-09-01');
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', jour: 15 }), '2026-09-14');
});

test('dateDuJourVoyage franchit les fins de mois', () => {
  assert.equal(dateDuJourVoyage({ depart: '2026-08-25', jour: 15 }), '2026-09-07');
  assert.equal(dateDuJourVoyage({ depart: '2026-12-28', jour: 15 }), '2027-01-10');
});

test('dateDuJourVoyage recule la date quand le voyage a de l\'avance', () => {
  // Deux jours d'avance : on quitte Salta deux jours avant la date posée.
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', decalage: 2, jour: 2 }), '2026-08-30');
  // Deux jours de retard : le départ de Salta glisse de deux jours.
  assert.equal(dateDuJourVoyage({ depart: '2026-09-01', decalage: -2, jour: 2 }), '2026-09-03');
});

// Le garde-fou qui compte : la date annoncée doit être celle où la frise
// bascule pour de bon. Les deux fonctions se lisent l'une l'autre, décalage
// compris — c'est ce que la contradiction à l'écran coûterait le plus cher.
/* L'aller-retour entre les deux fonctions, sur TOUTES les journées roulées et
   non plus sur les deux bouts : J1 ayant quitté le domaine, autant balayer ce
   qui reste — quatorze journées coûtent le même temps que deux. */
