/* Tests de la phrase du repère de la frise — « où en sont les motos ».

   C'est la seule phrase du site qui change toute seule, sans que personne ne la
   relise : elle suit la position posée dans l'admin et la traverse des quatre
   moments du voyage. Une faute y reste visible des jours durant, sur la page
   d'accueil, au-dessus de la carte.

   `js/profil.js` n'est importé que pour cette fonction ; tout ce qui touche au
   DOM y est appelé depuis `dessinerFrise`, jamais au chargement du module. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { motDeLaFrise } from '../../js/profil.js';

const VILLES = { depart: 'Salta', arrivee: 'Cusco', courante: 'Tahua' };

// ------------------------------------------------------- avant le départ

test('sans position ni date, la phrase dit l\'attente et ne nomme aucune ville', () => {
  const { phrase } = motDeLaFrise({
    positionJour: null, departPrevuLe: null, arriveeLe: null, villes: VILLES,
  });
  assert.equal(phrase, 'Nous ne sommes pas encore partis !');
});

/* Volontaire : avant le départ, personne n'est nulle part. Écrire « Nous sommes
   à Salta ! » la veille annoncerait une présence qui n'existe pas — les motards
   sont encore chez eux. La flèche montre déjà le kilomètre zéro ; le mot n'a pas
   à prétendre qu'on y est. */
test('sans position, la ville de départ ne s\'invite pas dans la phrase', () => {
  const { phrase } = motDeLaFrise({
    positionJour: null, departPrevuLe: null, arriveeLe: null, villes: VILLES,
  });
  assert.doesNotMatch(phrase, /Salta/);
});

test('une date annoncée nomme la ville d\'où l\'on partira', () => {
  const { phrase, description } = motDeLaFrise({
    positionJour: null, departPrevuLe: '2026-08-29', arriveeLe: null, villes: VILLES,
  });
  assert.equal(phrase, 'Départ de Salta le 29/08/26 !');
  assert.equal(description, 'Départ de Salta le 29 août 2026');
});

// ---------------------------------------------------------- en chemin

test('en chemin, la phrase dit la ville plutôt que « ici »', () => {
  const { phrase } = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null, villes: VILLES,
  });
  assert.equal(phrase, 'Nous sommes à Tahua !');
});

test('en chemin, la version parlée rappelle la journée', () => {
  const { description } = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null, villes: VILLES,
  });
  assert.equal(description, 'Nous sommes à Tahua, au jour 7 du voyage');
});

/* La date de départ ne doit plus rien annoncer une fois qu'on roule : elle
   reste posée dans les réglages pour tout le voyage, et sans cette priorité la
   frise aurait continué d'annoncer un départ déjà eu lieu. */
test('une fois en route, la position l\'emporte sur la date de départ', () => {
  const { phrase } = motDeLaFrise({
    positionJour: 7, departPrevuLe: '2026-08-29', arriveeLe: null, villes: VILLES,
  });
  assert.equal(phrase, 'Nous sommes à Tahua !');
});

// ------------------------------------------------------------- arrivés

test('à l\'arrivée, la phrase nomme la ville et la date', () => {
  const { phrase, description } = motDeLaFrise({
    positionJour: 15, departPrevuLe: '2026-08-29', arriveeLe: '2026-09-12', villes: VILLES,
  });
  assert.equal(phrase, 'Nous sommes arrivés à Cusco le 12/09/26');
  assert.equal(description, 'Nous sommes arrivés à Cusco le 12 septembre 2026');
});

// ------------------------------------------------- quand la ville manque

/* `data/etapes.json` est modifiable à la main : une clé absente ou renommée ne
   doit pas produire « Nous sommes à undefined ! » sur la page d'accueil. La
   phrase retombe alors sur sa forme d'avant les villes, qui reste vraie. */
test('sans ville connue, la phrase du chemin retombe sur « ici »', () => {
  const { phrase } = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null,
    villes: { depart: 'Salta', arrivee: 'Cusco', courante: null },
  });
  assert.equal(phrase, 'Nous sommes ici !');
});

test('sans ville de départ connue, la date s\'annonce seule', () => {
  const { phrase } = motDeLaFrise({
    positionJour: null, departPrevuLe: '2026-08-29', arriveeLe: null,
    villes: { depart: null, arrivee: 'Cusco', courante: null },
  });
  assert.equal(phrase, 'Départ prévu le 29/08/26 !');
});

test('sans ville d\'arrivée connue, l\'arrivée s\'annonce seule', () => {
  const { phrase } = motDeLaFrise({
    positionJour: 15, departPrevuLe: null, arriveeLe: '2026-09-12',
    villes: { depart: 'Salta', arrivee: null, courante: null },
  });
  assert.equal(phrase, 'Nous sommes arrivés le 12/09/26');
});

test('motDeLaFrise ne suppose pas qu\'on lui passe des villes', () => {
  const { phrase } = motDeLaFrise({ positionJour: 7, departPrevuLe: null, arriveeLe: null });
  assert.equal(phrase, 'Nous sommes ici !');
});

// ------------------------------------------------------- le premier du mois

/* `Intl` écrit « 1 septembre » là où le français dit « 1er ». Seul le premier
   du mois est ordonné, et c'est la version LUE à voix haute qui le trahissait. */
test('la version parlée ordonne le premier du mois', () => {
  const { description } = motDeLaFrise({
    positionJour: null, departPrevuLe: '2026-09-01', arriveeLe: null, villes: VILLES,
  });
  assert.match(description, /1er septembre/);
});
