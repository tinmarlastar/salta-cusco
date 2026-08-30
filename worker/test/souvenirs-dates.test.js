/* Tests de l'heure affichée sur une note du carnet.

   Le service enregistre l'instant en UTC ; l'affichage le rendait dans le
   fuseau de CELUI QUI REGARDE. Une note écrite le 28 août à 21h34 sur le salar
   d'Uyuni s'affichait donc « 29 août, 03:34 » pour un lecteur français — elle
   semblait dater du lendemain, et paraissait rangée dans la mauvaise journée
   alors qu'elle était à sa place.

   Elle se lit désormais dans le fuseau de l'ÉTAPE à laquelle elle appartient :
   la même heure pour tout le monde, celle qu'il était là-bas quand elle a été
   écrite. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dateDeLaNote, journeeDesMotos } from '../../js/souvenirs-vue.js';

// 28 août 2026, 21h34 sur le salar (UTC-4) ; 29 août, 03h34 à Paris.
const INSTANT = '2026-08-29T01:34:00Z';

test('une note se lit à l\'heure de l\'étape, pas à celle du lecteur', () => {
  assert.equal(dateDeLaNote(INSTANT, 'America/La_Paz'), '28 août, 21:34');
});

test('chaque pays traversé a son heure', () => {
  assert.equal(dateDeLaNote(INSTANT, 'America/Lima'), '28 août, 20:34');
  assert.equal(dateDeLaNote(INSTANT, 'America/Argentina/Salta'), '28 août, 22:34');
});

/* Le fuseau arrive du service avec la note. Un service pas encore redéployé
   n'en envoie pas : l'affichage retombe alors sur le fuseau du lecteur, comme
   avant. Une note sans heure du tout serait pire que la mauvaise. */
test('sans fuseau, l\'heure reste lisible', () => {
  const rendu = dateDeLaNote(INSTANT, null);
  assert.match(rendu, /août/);
  assert.match(rendu, /\d{2}:\d{2}/);
});

/* Un fuseau que le navigateur ne connaît pas ferait lever `Intl` : sur un
   téléphone un peu ancien, ça vaudrait une carte de note vide au lieu d'une
   heure approximative. */
test('un fuseau inconnu ne fait pas tomber l\'affichage', () => {
  const rendu = dateDeLaNote(INSTANT, 'Mars/Olympus_Mons');
  assert.match(rendu, /août/);
});

test('une date illisible ne rend rien plutôt qu\'« Invalid Date »', () => {
  assert.equal(dateDeLaNote(null, 'America/La_Paz'), '');
  assert.equal(dateDeLaNote('pas une date', 'America/La_Paz'), '');
});

// ------------------------------------- « tu écris sur la journée d'à côté »

/* La journée d'une note est celle dont le carnet est ouvert — rien ne la
   déduit d'une horloge. Un motard qui arrive par un lien gardé de la veille
   écrit donc sur la veille sans s'en apercevoir, alors que le curseur a
   basculé le soir même. Le formulaire le lui dit avant qu'il tape. */

test('rien à signaler quand on écrit sur la journée où sont les motos', () => {
  assert.equal(journeeDesMotos({ jour: 7, positionJour: 7 }), null);
});

/* Tant que personne n'a dit où sont les motos — avant le départ, ou service
   injoignable — il n'y a rien à proposer : renvoyer sur une journée inconnue
   serait pire que se taire. */
test('rien à signaler quand la position est inconnue', () => {
  assert.equal(journeeDesMotos({ jour: 7, positionJour: null }), null);
});

test('la journée des motos est signalée quand on écrit ailleurs', () => {
  assert.deepEqual(journeeDesMotos({ jour: 7, positionJour: 8 }), { jour: 8 });
});

test('elle est signalée aussi quand on écrit sur une journée à venir', () => {
  assert.deepEqual(journeeDesMotos({ jour: 9, positionJour: 8 }), { jour: 8 });
});
