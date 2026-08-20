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

/** Rouvre une connexion fraîche et dédiée, dont on n'attend rien d'autre :
    force la fermeture de la connexion mémoïsée courante (s'il y en a une),
    puis met en file une entrée jetable pour déclencher une réouverture, afin
    que les tests de course ci-dessous ne dépendent pas de l'état laissé par
    les tests précédents. Renvoie la connexion fraîchement ouverte. */
async function connexionFraiche(jourChauffe) {
  if (derniereConnexion) {
    try { forceCloseDatabase(derniereConnexion); } catch { /* déjà fermée, tant mieux */ }
  }
  await f.mettreEnFile({
    jour: jourChauffe, type: 'note', auteur: 'Chauffe', texte: 'réveil connexion',
    motDePasse: 'x', idempotence: `idem-chauffe-${jourChauffe}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return derniereConnexion;
}

test('transaction qui commite exactement au moment où le garde écriture expire → mettreEnFile réussit, ne rejette pas (Important 1, 3e tour)', async () => {
  // Ce test attend réellement un peu plus de 30 s (DELAI_ECRITURE_MS, non
  // modifié, non simulé) : c'est le prix d'une preuve par exécution réelle
  // plutôt que par minuteur simulé, comme demandé. fake-indexeddb n'a pas de
  // latence disque réelle (tout est en mémoire) : un `put` y aboutit
  // naturellement en quelques millisecondes, jamais assez lentement pour
  // atteindre un vrai garde de 30 s tout seul. On fige donc délibérément son
  // ordonnancement interne (voir plus bas) pour recréer, à un instant choisi
  // avec précision, la situation qu'un téléphone sur un stockage saturé
  // produirait de lui-même : une transaction qui vient tout juste de
  // committer pile au moment où le garde se déclenche.
  const jour = 24;
  reponseFetch = () => new Promise(() => {}); // sans importance ici

  const baseReelle = await connexionFraiche(jour);
  assert.ok(baseReelle, 'connexion capturée pour ce test');

  // Capture la transaction que `mettreEnFile` va créer sur CETTE connexion,
  // pour pouvoir appeler `commit()` nous-mêmes au bon moment — un appel
  // légitime et conforme à la spec IndexedDB (un vrai navigateur l'expose
  // aussi), qui bascule l'état de la transaction sans dépendre du temps que
  // met fake-indexeddb à la terminer naturellement.
  const origTransaction = baseReelle.transaction.bind(baseReelle);
  let txCapturee = null;
  baseReelle.transaction = (...args) => {
    const tx = origTransaction(...args);
    txCapturee = tx;
    return tx;
  };

  // Gèle le traitement interne de fake-indexeddb : les callbacks qu'il
  // programme via `setImmediate` (démarrage et avancement de la
  // transaction) sont retenus plutôt qu'exécutés, ce qui la fige à l'état
  // "active" jusqu'à ce qu'on les relâche nous-mêmes, plus bas. Le module
  // sous test, lui, continue d'utiliser le VRAI `setTimeout` pour son garde
  // (on ne touche pas à `setTimeout`) : c'est ce qui rend la course réelle.
  const enAttente = [];
  let geler = true;
  const origSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = (fn) => {
    if (!geler) return origSetImmediate(fn);
    enAttente.push(fn);
    return 0;
  };

  const t0 = Date.now();
  const attendreJusqua = async (cibleMs) => {
    const restant = cibleMs - (Date.now() - t0);
    if (restant > 0) await new Promise((resoudre) => { setTimeout(resoudre, restant); });
  };

  const promesseMettreEnFile = f.mettreEnFile({
    jour, type: 'note', auteur: 'Course', texte: 'commit pile au garde',
    motDePasse: 'x', idempotence: 'idem-race-1',
  });

  // Laisse le temps à `mettreEnFile` d'atteindre `base.transaction(...)`.
  await attendreJusqua(50);
  assert.ok(txCapturee, 'la transaction aurait dû être capturée avant le premier setImmediate gelé');

  // Juste avant le garde écriture réel (DELAI_ECRITURE_MS = 30 000 ms) :
  // on commite nous-mêmes, plaçant la transaction en état "committing" —
  // exactement ce qu'un vrai navigateur aurait fait en train de finir
  // d'écrire, à ce point précis du délai.
  await attendreJusqua(29700);
  txCapturee.commit();

  // Continue d'attendre jusqu'un peu après le déclenchement réel du garde.
  await attendreJusqua(30400);

  // Relâche le traitement interne figé plus haut : la transaction, déjà en
  // "committing", peut désormais terminer naturellement et déclencher
  // `oncomplete`.
  geler = false;
  globalThis.setImmediate = origSetImmediate;
  for (const fn of enAttente.splice(0)) origSetImmediate(fn);

  // Avec le bug (rejet inconditionnel par le garde), cette promesse aurait
  // rejeté ici alors que l'entrée est bel et bien écrite : l'appelant
  // aurait retenté avec une nouvelle clé d'idempotence, donc un doublon.
  const idLocal = await promesseMettreEnFile;
  assert.equal(typeof idLocal, 'string');

  const liste = await f.listerFile(jour);
  assert.ok(
    liste.some((e) => e.idLocal === idLocal),
    "l'entrée doit être dans la file : le put a bien été écrit malgré le déclenchement du garde",
  );

  await Promise.all(liste.map((e) => f.viderEntree(e.idLocal)));
});

test('fermeture tardive d\'une ancienne connexion n\'efface pas une nouvelle connexion déjà mémoïsée (Important 2, 3e tour)', async () => {
  const jour = 25;
  reponseFetch = () => new Promise(() => {}); // sans importance ici

  // Connexion A, fraîche et dédiée à ce test.
  const connA = await connexionFraiche(jour);
  assert.ok(connA);

  // Simule ce qu'un navigateur ferait en interne : la fermeture de A est
  // déjà entamée (toute transaction suivante sur A est vouée à échouer),
  // MAIS l'événement `close` ne lui est pas encore parvenu — exactement le
  // décalage que décrit la revue. `_closePending` est un détail d'implémen-
  // tation de fake-indexeddb (pas de l'API publique IndexedDB), utilisé ici
  // en connaissance de cause pour placer précisément cette course.
  connA._closePending = true;

  // Le prochain appel qui tente d'utiliser A échoue immédiatement
  // (`InvalidStateError` sur `base.transaction(...)`), ce qui déclenche le
  // rattrapage déjà en place (reset de `basePromise`, s'il porte encore sur
  // A) — comportement déjà couvert par un test précédent, pas celui-ci.
  await assert.rejects(() => f.mettreEnFile({
    jour, type: 'note', auteur: 'Echoue', texte: 'x', motDePasse: 'x', idempotence: 'idem-late-fail',
  }));

  // L'appel suivant rouvre : une nouvelle connexion B, saine, est désormais
  // mémoïsée à la place de A.
  await f.mettreEnFile({
    jour, type: 'note', auteur: 'B-chauffe', texte: 'x', motDePasse: 'x', idempotence: 'idem-late-b',
  });
  const connB = derniereConnexion;
  assert.ok(connB && connB !== connA, 'une connexion B distincte doit avoir été ouverte');

  // MAINTENANT — plus tard, « sur une tâche distincte » — l'événement
  // `close` de A arrive enfin.
  forceCloseDatabase(connA);

  // La mémoïsation de B ne doit PAS avoir été effacée par cet événement
  // tardif : l'appel suivant doit réutiliser B sans rouvrir (si `basePromise`
  // avait été effacé à tort, cet appel aurait dû rouvrir une connexion C,
  // et `derniereConnexion` ne vaudrait plus `connB`).
  await f.mettreEnFile({
    jour, type: 'note', auteur: 'Verif', texte: 'x', motDePasse: 'x', idempotence: 'idem-late-verif',
  });
  assert.equal(
    derniereConnexion,
    connB,
    "aucune réouverture : B est toujours la connexion mémoïsée, l'événement tardif de A ne l'a pas effacée",
  );

  // Nettoyage.
  const liste = await f.listerFile(jour);
  await Promise.all(liste.map((e) => f.viderEntree(e.idLocal)));
});
