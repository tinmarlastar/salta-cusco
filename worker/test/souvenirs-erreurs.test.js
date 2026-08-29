/* Tests du classement des erreurs de `js/souvenirs.js`, exécutés sous node avec
   un `fetch` de doublure.

   Ce qui se joue ici : le service répond parfois en 5xx avec une phrase
   française qui NOMME la cause — une base injoignable, un réglage absent. Une
   panne de réseau, elle, ne dit rien d'utile (« Failed to fetch »). Les deux
   passaient jusqu'ici par la même `ErreurReseau`, indiscernables : l'appelant
   devait choisir entre montrer un charabia de navigateur ou perdre le
   diagnostic du service. La page d'administration a besoin de faire la
   différence.

   `lireVisites` sert de véhicule : n'importe quelle lecture d'administration
   ferait l'affaire, elles passent toutes par le même `appeler`.

   `js/souvenirs.js` n'est importé que pour ses appels réseau : ses fonctions
   qui touchent au DOM (compression d'image) ne sont jamais atteintes ici. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lireVisites, ErreurReseau, ErreurService } from '../../js/souvenirs.js';

/* Le module lit `data/config.json` avant tout appel, puis frappe le service.
   La doublure répond aux deux, dans cet ordre. */
function doublerFetch(reponseService) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('config.json')) {
      return new Response(JSON.stringify({ serviceUrl: 'https://exemple.test' }), { status: 200 });
    }
    return reponseService();
  };
}

const corps = (objet, statut) => () => new Response(JSON.stringify(objet), { status: statut });

test('un 5xx porteur d\'un message garde le statut du service', async () => {
  doublerFetch(corps({ erreur: 'La base de données ne répond pas.' }, 503));

  const souci = await lireVisites('mdp').then(() => null, (e) => e);

  assert.ok(souci instanceof ErreurReseau, 'un 5xx reste une panne, donc renvoyable');
  assert.equal(souci.statut, 503, 'sans statut, l\'appelant ne peut pas distinguer une vraie panne réseau');
  assert.match(souci.message, /base de données ne répond pas/);
});

test('une panne de transport n\'invente pas de statut', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('config.json')) {
      return new Response(JSON.stringify({ serviceUrl: 'https://exemple.test' }), { status: 200 });
    }
    throw new TypeError('Failed to fetch');
  };

  const souci = await lireVisites('mdp').then(() => null, (e) => e);

  assert.ok(souci instanceof ErreurReseau);
  assert.equal(souci.statut, undefined,
    'un statut ici ferait afficher « Failed to fetch » à la place du message d\'attente');
});

test('un refus d\'authentification reste une erreur de service', async () => {
  doublerFetch(corps({ erreur: 'Mot de passe incorrect' }, 401));

  const souci = await lireVisites('mauvais').then(() => null, (e) => e);

  assert.ok(souci instanceof ErreurService);
  assert.equal(souci.statut, 401);
  assert.equal(souci.message, 'Mot de passe incorrect');
});

test('une lecture qui aboutit rend le rapport tel que le service le calcule', async () => {
  const rapport = { total: { visiteurs: 12, pages: 40 }, jours: [], etapes: [] };
  doublerFetch(corps(rapport, 200));

  assert.deepEqual(await lireVisites('mdp'), rapport);
});
