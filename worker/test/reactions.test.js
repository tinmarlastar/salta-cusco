import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliserSmiley, interpreterVote, assemblerReactions } from '../lib/reactions.js';

// --------------------------------------------------- bornage de l'entrée

/* La route des réactions est publique, comme celle des visites : n'importe qui
   peut lui envoyer n'importe quoi. Ce qu'elle reçoit doit donc être borné
   AVANT d'atteindre la base, sinon une requête forgée y écrit le texte de son
   choix — et ce texte ressortirait tel quel sous une note, à la place d'un
   smiley. */
test('normaliserSmiley accepte un emoji de la liste Unicode', () => {
  assert.equal(normaliserSmiley('❤️'), '❤️');
  assert.equal(normaliserSmiley('😂'), '😂');
  assert.equal(normaliserSmiley('🏍️'), '🏍️');
});

test('normaliserSmiley refuse du texte', () => {
  assert.equal(normaliserSmiley('bonjour'), null);
  assert.equal(normaliserSmiley(':-)'), null);
  assert.equal(normaliserSmiley(''), null);
});

test('normaliserSmiley refuse ce qui n\'est pas une chaîne', () => {
  assert.equal(normaliserSmiley(null), null);
  assert.equal(normaliserSmiley(undefined), null);
  assert.equal(normaliserSmiley(42), null);
  assert.equal(normaliserSmiley(['❤️']), null);
});

/* Deux emoji collés forment une chaîne que rien n'interdit d'envoyer, et qui
   s'afficherait comme un seul bouton deux fois plus large. Un vote est un
   emoji, pas une phrase. */
test('normaliserSmiley refuse plusieurs emoji à la suite', () => {
  assert.equal(normaliserSmiley('❤️❤️'), null);
  assert.equal(normaliserSmiley('😂 '), null);
});

/* Le sélecteur ne propose pas les teintes de peau — la liste engendrée les
   écarte. Le service doit refuser ce que le sélecteur ne propose pas : la
   liste d'autorisation et ce qui est affiché sont le même fichier, et c'est
   tout l'intérêt de le faire engendrer plutôt que recopier. */
test('normaliserSmiley refuse une variante de teinte, absente du sélecteur', () => {
  assert.equal(normaliserSmiley('👍🏽'), null);
});

// ------------------------------------------------ mise en forme des lignes

/* Ce que la base rend : une ligne par couple (note, smiley). Les lignes
   arrivent dans l'ordre où SQLite les a trouvées ; c'est au module de les
   ranger par note et par popularité. */
const LIGNES = [
  { contribution_id: 'a1', smiley: '😂', compte: 2 },
  { contribution_id: 'b2', smiley: '❤️', compte: 1 },
  { contribution_id: 'a1', smiley: '❤️', compte: 5 },
];

test('assemblerReactions groupe par note, le plus posé en premier', () => {
  const par = assemblerReactions(LIGNES);
  assert.deepEqual(par.get('a1'), [
    { smiley: '❤️', compte: 5 },
    { smiley: '😂', compte: 2 },
  ]);
  assert.deepEqual(par.get('b2'), [{ smiley: '❤️', compte: 1 }]);
});

test('assemblerReactions rend une carte vide sans ligne', () => {
  assert.equal(assemblerReactions([]).size, 0);
  assert.equal(assemblerReactions(undefined).size, 0);
});

/* Retirer sa réaction décrémente le compteur : la ligne reste en base à zéro
   plutôt que d'être supprimée, pour que le vote suivant n'ait pas à décider
   entre insérer et mettre à jour. Un zéro n'est pas une réaction, il ne doit
   pas descendre jusqu'à l'écran sous la forme d'un bouton « 0 ». */
test('assemblerReactions écarte les compteurs retombés à zéro', () => {
  const par = assemblerReactions([
    { contribution_id: 'a1', smiley: '😂', compte: 0 },
    { contribution_id: 'a1', smiley: '❤️', compte: 3 },
  ]);
  assert.deepEqual(par.get('a1'), [{ smiley: '❤️', compte: 3 }]);
});

test('assemblerReactions n\'inscrit pas une note dont tout est retombé à zéro', () => {
  const par = assemblerReactions([{ contribution_id: 'a1', smiley: '😂', compte: 0 }]);
  assert.equal(par.has('a1'), false);
});

/* Deux smileys à égalité : l'ordre doit rester le même d'un chargement à
   l'autre, sinon les boutons dansent sous la note à chaque rafraîchissement
   sans que rien n'ait changé. */
test('assemblerReactions départage deux égalités de façon stable', () => {
  const premier = assemblerReactions([
    { contribution_id: 'a1', smiley: '😂', compte: 2 },
    { contribution_id: 'a1', smiley: '❤️', compte: 2 },
  ]);
  const second = assemblerReactions([
    { contribution_id: 'a1', smiley: '❤️', compte: 2 },
    { contribution_id: 'a1', smiley: '😂', compte: 2 },
  ]);
  assert.deepEqual(premier.get('a1'), second.get('a1'));
});

// ------------------------------------------------------ lecture d'un vote

/* Le navigateur envoie ce qu'il VEUT (`smiley`, ou rien pour retirer) et ce
   qu'il AVAIT (`precedent`, retenu chez lui). Le service en déduit les deux
   seuls gestes qu'il sait faire : décrémenter un compteur, en incrémenter un
   autre. Cette traduction est la partie qui se trompe facilement — elle vit
   ici, testée, plutôt que dans la route. */
test('interpreterVote pose un premier smiley', () => {
  assert.deepEqual(interpreterVote({ smiley: '❤️' }), { retirer: null, poser: '❤️' });
});

test('interpreterVote déplace un vote d\'un smiley à l\'autre', () => {
  assert.deepEqual(
    interpreterVote({ smiley: '😂', precedent: '❤️' }),
    { retirer: '❤️', poser: '😂' },
  );
});

test('interpreterVote retire un vote quand aucun smiley n\'est demandé', () => {
  assert.deepEqual(
    interpreterVote({ smiley: null, precedent: '❤️' }),
    { retirer: '❤️', poser: null },
  );
});

/* Redemander le smiley déjà posé n'est pas un second vote : c'est un envoi en
   double, ou un second onglet resté sur le même état. Sans ce cas, le
   compteur monterait de un à chaque fois. */
test('interpreterVote ne fait rien si le smiley demandé est déjà le sien', () => {
  assert.deepEqual(
    interpreterVote({ smiley: '❤️', precedent: '❤️' }),
    { retirer: null, poser: null },
  );
});

test('interpreterVote refuse un smiley hors de la liste', () => {
  assert.equal(interpreterVote({ smiley: 'bonjour' }), null);
  assert.equal(interpreterVote({ smiley: '👍🏽' }), null);
});

/* Un vote qui ne demande rien ne vaut pas un refus : le cas se présente pour
   de bon quand un navigateur retire un smiley que la liste ne connaît plus —
   il n'y a alors rien à faire, mais rien de fautif non plus. Répondre par une
   erreur ferait apparaître une alerte pour une opération sans objet. */
test('interpreterVote laisse passer un vote sans objet', () => {
  assert.deepEqual(interpreterVote(undefined), { retirer: null, poser: null });
  assert.deepEqual(interpreterVote({}), { retirer: null, poser: null });
});

/* `precedent` vient du stockage local du navigateur, pas d'un clic : il peut
   dater d'une version où la liste des emoji n'était pas la même. On l'ignore
   plutôt que de refuser tout le vote — un lecteur dont le navigateur garde un
   vieux smiley doit pouvoir en poser un nouveau, sinon il reste bloqué sans
   comprendre pourquoi. Un smiley hors liste n'a de toute façon jamais pu
   entrer en base, donc il n'y a rien à décrémenter. */
test('interpreterVote ignore un precedent hors de la liste sans refuser le vote', () => {
  assert.deepEqual(
    interpreterVote({ smiley: '❤️', precedent: 'vieux-truc' }),
    { retirer: null, poser: '❤️' },
  );
});
