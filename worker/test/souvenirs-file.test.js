/* Tests de `js/souvenirs-file.js` exécutés sous `fake-indexeddb`, plutôt que
   simplement relus : c'est le stockage, pas le réseau, qui casse sur le
   terrain (base saturée par des photos, connexion fermée de force par le
   navigateur pour récupérer de la place), et c'est là que se logeaient les
   défauts que ces tests ciblent.

   `fake-indexeddb` n'est une dépendance que de `worker/` (devDependencies) :
   le site publié n'en a jamais connaissance. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  indexedDB as indexedDBReel, IDBRequest, forceCloseDatabase,
} from 'fake-indexeddb';

// Espion posé sur `indexedDB.open` : il laisse fake-indexeddb faire tout le
// travail, mais retient la dernière connexion obtenue pour que le test « base
// fermée de force » puisse la fermer explicitement (fake-indexeddb ferme une
// connexion précise, pas « la base » en général — il faut donc la référence
// exacte que le module a obtenue).
let derniereConnexion = null;
const indexedDBEspion = {
  open(...args) {
    const requete = indexedDBReel.open(...args);
    requete.addEventListener('success', () => { derniereConnexion = requete.result; });
    return requete;
  },
  cmp: (...args) => indexedDBReel.cmp(...args),
  databases: (...args) => indexedDBReel.databases(...args),
  deleteDatabase: (...args) => indexedDBReel.deleteDatabase(...args),
};

globalThis.indexedDB = indexedDBEspion;
globalThis.IDBRequest = IDBRequest;

// `souvenirs.js` (importé par `souvenirs-file.js`) ne touche au réseau que
// par `fetch` : un faux contrôlable par test suffit, pas besoin de mocker le
// module lui-même (interdit de toute façon : la consigne est de ne pas le
// modifier, et Node 20 ne propose pas encore de mock de module ESM stable).
let reponseFetch = () => new Response('{}', { status: 200 });
globalThis.fetch = async (url, options) => {
  const chemin = String(url);
  if (chemin.endsWith('config.json')) {
    return new Response(JSON.stringify({ serviceUrl: 'http://test.local' }), { status: 200 });
  }
  return reponseFetch(chemin, options);
};

const s = await import('../../js/souvenirs.js');
await s.chargerConfig();
const f = await import('../../js/souvenirs-file.js');

/** Attend que la file d'un jour soit vide, ou abandonne après `tentativesMax`. */
async function attendreFileVide(jour, tentativesMax = 40) {
  for (let i = 0; i < tentativesMax; i += 1) {
    if ((await f.listerFile(jour)).length === 0) return;
    await new Promise((resoudre) => { setTimeout(resoudre, 25); });
  }
}

test('lecture introuvable → undefined, pas de résurrection d\'une entrée supprimée en vol (Important 2)', async () => {
  const jour = 22;
  const idLocal = await f.mettreEnFile({
    jour, type: 'note', auteur: 'EnVol', texte: 'abandonné en vol',
    motDePasse: 'x', idempotence: 'idem-envol-1',
  });

  // L'envoi reste « en vol » : on contrôle nous-mêmes quand le réseau répond.
  let rejeterFetch;
  reponseFetch = () => new Promise((_resoudre, rejeter) => { rejeterFetch = rejeter; });

  const messagesErreur = [];
  const origConsoleError = console.error;
  console.error = (...args) => { messagesErreur.push(args.map(String).join(' ')); };

  const passe = f.renvoyerMaintenant(); // volontairement pas attendu tout de suite

  // Laisse le temps à `traiterEntree` d'atteindre l'appel réseau (en attente
  // de notre promesse contrôlée) avant de simuler l'abandon par l'auteur.
  await new Promise((resoudre) => { setTimeout(resoudre, 50); });

  // L'auteur clique « abandonner » pendant l'envoi (jusqu'à 120 s possibles
  // en réel pour une vidéo) : la tâche 8 appellerait `viderEntree` ici.
  await f.viderEntree(idLocal);

  // Le réseau finit par échouer : c'est ce qui déclenche le rattrapage, donc
  // la relecture protégée par le garde de l'Important 2.
  rejeterFetch(new TypeError('panne simulée pendant l\'envoi'));

  await passe;
  console.error = origConsoleError;

  const restantes = await f.listerFile(jour);
  assert.equal(restantes.length, 0, "l'entrée supprimée pendant l'envoi ne doit pas réapparaître");

  // Avec le contrat de retour non corrigé, `magasin.get(idLocal)` sur une clé
  // absente rendait l'objet IDBRequest lui-même (toujours "truthy") au lieu
  // de `undefined` : le garde `if (!actuelle) return;` ne se déclenchait
  // jamais, le `put` recréait l'entrée, et l'échec du `put` qui en découlait
  // (spreading d'un IDBRequest) finissait journalisé comme un « échec du
  // rattrapage ». Aucun log de ce genre ne doit apparaître ici : il n'y avait
  // rien à rattraper.
  assert.equal(messagesErreur.length, 0, `aucun log inattendu, reçu : ${JSON.stringify(messagesErreur)}`);
});

test('base fermée de force → l\'opération suivante rouvre et réussit (Critique A)', async () => {
  const jour = 23;
  reponseFetch = () => new Promise(() => {}); // sans importance : aucun envoi n'est déclenché ici

  await f.mettreEnFile({
    jour, type: 'note', auteur: 'Avant', texte: 'avant fermeture forcée',
    motDePasse: 'x', idempotence: 'idem-fermeture-1',
  });

  assert.ok(derniereConnexion, 'la connexion aurait dû être capturée par l\'espion sur indexedDB.open');

  // Simule ce que fait le navigateur pour récupérer du stockage : fermer la
  // connexion de force, sans passer par `onversionchange`. C'est l'événement
  // `close`, pas `versionchange`, qui doit être écouté pour guérir de ça.
  forceCloseDatabase(derniereConnexion);

  // L'opération suivante doit rouvrir toute seule plutôt qu'échouer
  // définitivement (avant le correctif : `InvalidStateError` sur
  // `base.transaction(...)` pour toujours, jusqu'à rechargement de la page).
  const idApres = await f.mettreEnFile({
    jour, type: 'note', auteur: 'Apres', texte: 'après réouverture',
    motDePasse: 'x', idempotence: 'idem-fermeture-2',
  });
  const liste = await f.listerFile(jour);
  assert.equal(liste.length, 2, 'les deux entrées (avant et après la fermeture forcée) doivent être lisibles');
  assert.ok(liste.some((e) => e.idLocal === idApres));

  // Nettoyage.
  await Promise.all(liste.map((e) => f.viderEntree(e.idLocal)));
});

test('demarrerRenvoi : un seul armement malgré plusieurs appels, mais une tentative à chaque appel (Important 1 + bricole 3)', async () => {
  const jour = 21;
  globalThis.document = { visibilityState: 'visible' };

  let compteAddEventListener = 0;
  let compteSetInterval = 0;
  const origAddEventListener = globalThis.addEventListener;
  const origSetInterval = globalThis.setInterval;
  globalThis.addEventListener = () => { compteAddEventListener += 1; };
  // On neutralise le vrai setInterval : sinon une minuterie de 2 min réelle
  // resterait armée et empêcherait `node --test` de terminer proprement.
  globalThis.setInterval = () => { compteSetInterval += 1; return 0; };

  reponseFetch = () => new Response(
    JSON.stringify({ contribution: { id: 'c' }, jeton: null }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );

  try {
    // Chaque appel met en file une entrée FRAÎCHE juste avant : si l'appel ne
    // déclenchait pas sa propre tentative immédiate, elle resterait en file
    // (rien d'autre, dans ce test, ne fait avancer la file).
    for (let i = 1; i <= 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await f.mettreEnFile({
        jour, type: 'note', auteur: 'D', texte: `essai ${i}`,
        motDePasse: 'x', idempotence: `idem-demarrer-${i}`,
      });
      f.demarrerRenvoi({ surChangement: () => {} });
      // eslint-disable-next-line no-await-in-loop
      await attendreFileVide(jour);
      // eslint-disable-next-line no-await-in-loop
      const restantes = await f.listerFile(jour);
      assert.equal(restantes.length, 0, `l'appel n°${i} à demarrerRenvoi doit avoir traité l'entrée`);
    }

    assert.equal(compteSetInterval, 1, 'une seule minuterie malgré 3 appels à demarrerRenvoi');
    assert.equal(compteAddEventListener, 2, 'un seul armement des écouteurs (online + visibilitychange)');
  } finally {
    globalThis.addEventListener = origAddEventListener;
    globalThis.setInterval = origSetInterval;
  }
});
