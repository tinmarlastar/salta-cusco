/* Tests de la partie calculatoire de `js/souvenirs-vue.js` : ce que devient la
   rangée de smileys d'une note quand on clique, AVANT que le service ait
   répondu.

   Le clic est peint sans attendre le réseau — c'est la seule façon d'avoir un
   bouton qui répond du tac au tac sur une connexion andine. Le prix, c'est que
   le navigateur doit refaire lui-même le calcul du service : décrémenter,
   incrémenter, remettre dans l'ordre. Un écart entre les deux se verrait comme
   un smiley qui saute de place à la seconde qui suit. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appliquerVote } from '../../js/souvenirs-vue.js';

test('appliquerVote pose un premier smiley sur une note sans réaction', () => {
  assert.deepEqual(appliquerVote([], null, '❤️'), [{ smiley: '❤️', compte: 1 }]);
});

test('appliquerVote ajoute un smiley que personne n\'avait encore posé', () => {
  assert.deepEqual(
    appliquerVote([{ smiley: '❤️', compte: 3 }], null, '😂'),
    [{ smiley: '❤️', compte: 3 }, { smiley: '😂', compte: 1 }],
  );
});

/* Déplacer son vote fait bouger deux compteurs à la fois, et peut donc
   renverser l'ordre des boutons — c'est voulu : la rangée dit toujours ce qui
   est le plus posé. */
test('appliquerVote déplace un vote et remet la rangée dans l\'ordre', () => {
  assert.deepEqual(
    appliquerVote([{ smiley: '❤️', compte: 2 }, { smiley: '😂', compte: 1 }], '❤️', '😂'),
    [{ smiley: '😂', compte: 2 }, { smiley: '❤️', compte: 1 }],
  );
});

test('appliquerVote retire le bouton du dernier smiley repris', () => {
  assert.deepEqual(appliquerVote([{ smiley: '❤️', compte: 1 }], '❤️', null), []);
});

/* Le smiley précédent vient du stockage local : il peut désigner une réaction
   que quelqu'un d'autre a fait tomber à zéro entre-temps, ou qui n'a jamais
   existé sur cette note. Rien à décrémenter, et surtout pas de compteur
   fantôme à −1. */
test('appliquerVote ignore un précédent absent de la rangée', () => {
  assert.deepEqual(
    appliquerVote([{ smiley: '❤️', compte: 2 }], '🔥', '❤️'),
    [{ smiley: '❤️', compte: 3 }],
  );
});

test('appliquerVote départage deux égalités comme le service', () => {
  assert.deepEqual(
    appliquerVote([{ smiley: '😂', compte: 1 }], null, '❤️'),
    [{ smiley: '❤️', compte: 1 }, { smiley: '😂', compte: 1 }],
  );
});

/* Ne pas toucher à la liste reçue : elle est encore celle de l'affichage
   courant, et c'est elle qu'on repeint si le service refuse le vote. */
test('appliquerVote laisse la rangée d\'origine intacte', () => {
  const avant = [{ smiley: '❤️', compte: 2 }];
  appliquerVote(avant, '❤️', '😂');
  assert.deepEqual(avant, [{ smiley: '❤️', compte: 2 }]);
});
