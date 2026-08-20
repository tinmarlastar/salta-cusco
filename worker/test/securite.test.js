import { test } from 'node:test';
import assert from 'node:assert/strict';

import { creerId, creerJeton, hacherJeton, memeSecret } from '../lib/securite.js';

test('creerId se trie chronologiquement comme une chaîne', () => {
  const tot = creerId(1_000_000_000_000);
  const tard = creerId(1_900_000_000_000);
  assert.ok(tot < tard, `${tot} devrait précéder ${tard}`);
});

test('creerId reste unique au même instant', () => {
  const instant = 1_700_000_000_000;
  const identifiants = new Set(Array.from({ length: 500 }, () => creerId(instant)));
  assert.equal(identifiants.size, 500);
});

test('creerJeton produit un secret de 32 caractères hexadécimaux', () => {
  const jeton = creerJeton();
  assert.match(jeton, /^[0-9a-f]{32}$/);
  assert.notEqual(jeton, creerJeton());
});

test('hacherJeton est stable et ne renvoie pas le jeton en clair', async () => {
  const empreinte = await hacherJeton('secret-de-test');
  assert.equal(empreinte, await hacherJeton('secret-de-test'));
  assert.match(empreinte, /^[0-9a-f]{64}$/);
  assert.ok(!empreinte.includes('secret'));
});

test('hacherJeton distingue deux jetons différents', async () => {
  assert.notEqual(await hacherJeton('a'), await hacherJeton('b'));
});

test('memeSecret compare correctement', () => {
  assert.equal(memeSecret('motdepasse', 'motdepasse'), true);
  assert.equal(memeSecret('motdepasse', 'motdepassX'), false);
  assert.equal(memeSecret('court', 'beaucoup-plus-long'), false);
});

test('memeSecret refuse les valeurs absentes', () => {
  assert.equal(memeSecret('', ''), false);
  assert.equal(memeSecret(undefined, 'x'), false);
  assert.equal(memeSecret('x', null), false);
});
