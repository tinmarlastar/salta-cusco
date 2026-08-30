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

import { dateDeLaNote, journeeDesMotos, paysDeLaJournee } from '../../js/souvenirs-vue.js';

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

// ------------------------------------------ le drapeau posé sur une note

/* Chaque note porte le drapeau du pays où la journée ARRIVE — celui où l'on
   dort ce soir-là, donc celui dont l'heure est affichée juste à côté. Une
   journée qui franchit une frontière en porte deux dans `data/etapes.json` :
   J4 part d'Argentine et arrive au Chili, et c'est le Chili qui compte.

   Le drapeau et le nom viennent du contenu éditorial, jamais d'une table
   écrite dans le code : `data/etapes.json` les tient déjà pour l'en-tête des
   fiches d'étape. */
const ETAPES = [
  { jour: 1, pays: ['AR'] },
  { jour: 4, pays: ['AR', 'CL'] },
  { jour: 11, pays: ['BO', 'PE'] },
  { jour: 13, pays: [] },
];
const PAYS = [
  { code: 'AR', nom: 'Argentine', drapeau: '🇦🇷' },
  { code: 'CL', nom: 'Chili', drapeau: '🇨🇱' },
  { code: 'PE', nom: 'Pérou', drapeau: '🇵🇪' },
];

test('le pays d\'une journée est celui où elle arrive', () => {
  assert.equal(paysDeLaJournee(ETAPES, PAYS, 1).nom, 'Argentine');
  assert.equal(paysDeLaJournee(ETAPES, PAYS, 4).nom, 'Chili');
  assert.equal(paysDeLaJournee(ETAPES, PAYS, 11).drapeau, '🇵🇪');
});

/* `data/etapes.json` se modifie à la main : une journée inconnue, une liste de
   pays vide ou un code absent de la table ne doivent pas produire « undefined »
   sous une note. Pas de drapeau vaut mieux qu'un faux. */
test('pas de pays trouvé ne rend rien plutôt qu\'un drapeau faux', () => {
  assert.equal(paysDeLaJournee(ETAPES, PAYS, 99), null);
  assert.equal(paysDeLaJournee(ETAPES, PAYS, 13), null);
  assert.equal(paysDeLaJournee(ETAPES, [], 1), null);
  assert.equal(paysDeLaJournee(null, PAYS, 1), null);
  assert.equal(paysDeLaJournee(ETAPES, null, 1), null);
});
