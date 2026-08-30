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

// ------------------------------------------- l'heure qu'il est chez eux

/* « Nous sommes à Tahua, il est 7h20 » : l'heure LOCALE des motards, celle du
   fuseau de la ville où ils arrivent ce soir-là.

   Elle est calculée à partir d'un instant passé en paramètre, jamais de
   `Date.now()` pris à l'intérieur : sans ça, la seule phrase du site qui
   change toute seule serait aussi la seule qu'on ne saurait pas éprouver. */
const INSTANT = new Date('2026-09-05T11:20:00Z'); // 7 h 20 à La Paz, 6 h 20 à Lima

test('en chemin, la phrase dit l\'heure qu\'il est chez les motards', () => {
  const { phrase, heure } = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    fuseau: 'America/La_Paz', maintenant: INSTANT,
  });
  // Deux champs, parce que le mot s'écrit sur deux lignes : mises bout à bout,
  // ces trente-trois lettres débordaient de la frise sur un téléphone, où le
  // garde-fou du hors-champ effaçait alors le mot entier. Sur deux lignes, la
  // largeur du mot reste celle de sa plus longue ligne.
  assert.equal(phrase, 'Nous sommes à Tahua,');
  assert.equal(heure, 'il est 7h20');
});

test('sans ville connue, l\'heure s\'ajoute quand même à « ici »', () => {
  const { phrase, heure } = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null,
    villes: { depart: 'Salta', arrivee: 'Cusco', courante: null },
    fuseau: 'America/La_Paz', maintenant: INSTANT,
  });
  assert.equal(phrase, 'Nous sommes ici,');
  assert.equal(heure, 'il est 7h20');
});

test('l\'heure suit le fuseau, pas l\'instant seul', () => {
  const aLima = motDeLaFrise({
    positionJour: 12, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    fuseau: 'America/Lima', maintenant: INSTANT,
  });
  assert.equal(aLima.heure, 'il est 6h20');
});

/* Le Chili passe à l'heure d'été le premier dimanche de septembre, en plein
   voyage. Un décalage écrit en dur se serait trompé d'une heure sur toute la
   fin du raid : le fuseau est NOMMÉ, et c'est le navigateur qui sait. */
test('l\'heure suit le changement d\'heure chilien', () => {
  const avant = motDeLaFrise({
    positionJour: 4, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    fuseau: 'America/Santiago', maintenant: new Date('2026-09-05T15:00:00Z'),
  });
  const apres = motDeLaFrise({
    positionJour: 4, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    fuseau: 'America/Santiago', maintenant: new Date('2026-09-07T15:00:00Z'),
  });
  assert.equal(avant.heure, 'il est 11h00');
  assert.equal(apres.heure, 'il est 12h00');
});

/* Les minutes gardent leur zéro, l'heure n'en prend pas : on écrit « 7h05 » et
   « 0h20 », comme on le dit. */
test('les minutes s\'écrivent sur deux chiffres, l\'heure sans zéro devant', () => {
  const cinq = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    fuseau: 'America/La_Paz', maintenant: new Date('2026-09-05T11:05:00Z'),
  });
  const minuit = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    fuseau: 'America/La_Paz', maintenant: new Date('2026-09-05T04:20:00Z'),
  });
  assert.equal(cinq.heure, 'il est 7h05');
  assert.equal(minuit.heure, 'il est 0h20');
});

test('la description lue à voix haute dit l\'heure aussi', () => {
  const { description } = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    fuseau: 'America/La_Paz', maintenant: INSTANT,
  });
  assert.match(description, /7h20/);
});

/* Le fuseau arrive du service, qui peut être injoignable ou pas encore
   redéployé. La phrase retombe alors exactement sur celle d'avant : pas de
   « il est » suivi d'un blanc, ni d'heure du lecteur passée pour celle des
   motards. */
test('sans fuseau, la phrase reste celle d\'avant, sans seconde ligne', () => {
  const { phrase, heure } = motDeLaFrise({
    positionJour: 7, departPrevuLe: null, arriveeLe: null, villes: VILLES,
    maintenant: INSTANT,
  });
  assert.equal(phrase, 'Nous sommes à Tahua !');
  // Pas de seconde ligne du tout, pas même vide : une ligne blanche sous le
  // mot décaleraient le dessin sans rien dire.
  assert.ok(!heure);
});

/* Avant le départ et après l'arrivée, les motards sont chez eux : « chez nous
   il est » y afficherait l'heure du lecteur lui-même, présentée comme la
   leur. Ces deux phrases ne portent donc jamais d'heure, fuseau ou pas. */
test('avant le départ, aucune heure ne s\'affiche', () => {
  const { phrase } = motDeLaFrise({
    positionJour: null, departPrevuLe: '2026-08-29', arriveeLe: null, villes: VILLES,
    fuseau: 'America/Argentina/Salta', maintenant: INSTANT,
  });
  assert.equal(phrase, 'Départ de Salta le 29/08/26 !');
});

test('une fois arrivés, aucune heure ne s\'affiche', () => {
  const { phrase } = motDeLaFrise({
    positionJour: 15, departPrevuLe: null, arriveeLe: '2026-09-12', villes: VILLES,
    fuseau: 'America/Lima', maintenant: INSTANT,
  });
  assert.equal(phrase, 'Nous sommes arrivés à Cusco le 12/09/26');
});
