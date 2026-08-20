/* File d'attente des envois qui n'ont pas abouti.

   C'est la réponse au réseau des Andes : rien ne se perd quand ça ne passe pas.
   IndexedDB, et non localStorage, parce qu'elle seule stocke les fichiers
   binaires tels quels. */

import {
  envoyerNote, envoyerMedia, ErreurService, creerCleIdempotence,
} from './souvenirs.js';

const BASE = 'souvenirs-salta-cusco';
const MAGASIN = 'attente';

const ATTENTE_MIN = 2000;       // premier réessai après 2 s
const ATTENTE_MAX = 5 * 60_000; // plafonné à 5 min : en zone blanche, insister vide la batterie
const PERIODE = 2 * 60_000;     // relance périodique tant que l'onglet est ouvert

// Trois délais de garde distincts, sur le modèle de `DELAI_RESEAU_MS` dans
// `souvenirs.js` : aucune promesse IndexedDB ne doit dépendre d'un événement
// dont l'émission n'est pas garantie (une transaction peut avorter en
// silence, une ouverture peut rester pendue).
//   - Ouverture et lecture : aucune raison légitime de traîner, un délai
//     court suffit.
//   - Écriture : peut porter le fichier d'un souvenir — une photo
//     compressée, voire une vidéo de plusieurs dizaines de Mo — et rester
//     lente sans être en panne sur un stockage saturé. Un délai aussi court
//     que celui de la lecture ferait échouer des `put` légitimes.
const DELAI_OUVERTURE_MS = 8000;
const DELAI_LECTURE_MS = 8000;
const DELAI_ECRITURE_MS = 30_000;

let signaler = () => {};
let enCours = false;

// Connexion IndexedDB unique, réutilisée par toutes les transactions.
// Rouvrir à chaque opération (comme le faisait la première version) ouvre
// des milliers de connexions sur plusieurs semaines et, surtout, bloque tout
// futur changement de version du schéma tant qu'une seule reste ouverte.
let basePromise = null;

function ouvrir() {
  if (!basePromise) {
    basePromise = new Promise((resoudre, rejeter) => {
      let reglee = false;

      function regler(fn, valeur) {
        if (reglee) return;
        reglee = true;
        clearTimeout(minuteurGarde);
        fn(valeur);
      }

      // Une ouverture peut rester pendue indéfiniment sans jamais émettre
      // `onsuccess` ni `onerror` (cas connu sur WebKit/iOS après restauration
      // de page, précisément la plateforme visée) : sans ce garde, `enCours`
      // et `mettreEnFile` resteraient bloqués pour la vie de l'onglet, et la
      // mémoïsation de la connexion (voir plus bas) aggraverait le problème
      // en empoisonnant tous les appels futurs avec la même ouverture morte.
      const minuteurGarde = setTimeout(() => {
        basePromise = null; // qu'un futur appel puisse retenter une ouverture propre
        regler(rejeter, new Error('Ouverture IndexedDB sans réponse (délai dépassé)'));
      }, DELAI_OUVERTURE_MS);

      const requete = indexedDB.open(BASE, 1);
      requete.onupgradeneeded = () => {
        const base = requete.result;
        if (!base.objectStoreNames.contains(MAGASIN)) {
          base.createObjectStore(MAGASIN, { keyPath: 'idLocal' });
        }
      };
      requete.onsuccess = () => {
        const base = requete.result;
        if (reglee) {
          // Le délai de garde (ou `onblocked`) a déjà réglé cette promesse,
          // et personne ne référence donc cette connexion qui arrive après
          // coup. La laisser ouverte bloquerait un futur changement de
          // schéma — exactement ce que la mémoïsation cherche à éviter — on
          // la referme donc aussitôt plutôt que de la laisser fuiter.
          base.close();
          return;
        }
        // Le navigateur peut fermer la connexion de force pour récupérer du
        // stockage (base saturée de photos/vidéos, le cas visé sur le
        // terrain) : sans écouter `onclose`, la promesse mémoïsée resterait
        // tenue sur une base morte et TOUTE opération échouerait
        // définitivement — `mettreEnFile` comprise — jusqu'à rechargement
        // de la page. En réinitialisant `basePromise`, le prochain appel
        // rouvre proprement.
        base.onclose = () => { basePromise = null; };
        // Un autre onglet (ou un futur déploiement avec un schéma v2) peut
        // demander une version supérieure : on ferme alors proprement notre
        // connexion pour ne pas la bloquer indéfiniment derrière `onblocked`.
        base.onversionchange = () => {
          base.close();
          basePromise = null;
        };
        regler(resoudre, base);
      };
      requete.onerror = () => {
        basePromise = null;
        regler(rejeter, requete.error);
      };
      requete.onblocked = () => {
        basePromise = null;
        regler(rejeter, new Error("Ouverture d'IndexedDB bloquée par un autre onglet"));
      };
    });
  }
  return basePromise;
}

async function transaction(mode, action) {
  const base = await ouvrir();
  const delaiGarde = mode === 'readonly' ? DELAI_LECTURE_MS : DELAI_ECRITURE_MS;
  return new Promise((resoudre, rejeter) => {
    let reglee = false;
    let tx;

    function regler(fn, valeur) {
      if (reglee) return;
      reglee = true;
      clearTimeout(minuteurGarde);
      fn(valeur);
    }

    const minuteurGarde = setTimeout(() => {
      // Abandonner l'attente ne suffit pas : sans `abort()`, la transaction
      // continue en arrière-plan et peut committer après coup, ce qui
      // romprait la garantie « un échec signifie que rien n'a été écrit » et
      // ouvrirait la porte au doublon que ce module existe pour empêcher —
      // un `mettreEnFile` qu'on croit raté mais que l'auteur retente avec
      // une nouvelle clé d'idempotence, alors que le premier a bien été
      // enregistré.
      try { tx?.abort(); } catch { /* déjà terminée, rien à faire */ }
      regler(rejeter, new Error('Transaction IndexedDB sans réponse (délai dépassé)'));
    }, delaiGarde);

    try {
      tx = base.transaction(MAGASIN, mode);
    } catch (erreurTransaction) {
      // La connexion mémoïsée peut être morte (fermée de force par le
      // navigateur) sans que `onclose` ait encore eu l'occasion de la
      // réinitialiser : on force la réouverture dès maintenant, pour que le
      // PROCHAIN appel — celui-ci échoue — reparte sur une base saine plutôt
      // que de rester bloqué sur une connexion morte jusqu'à rechargement.
      basePromise = null;
      regler(rejeter, erreurTransaction);
      return;
    }

    let resultat;
    try {
      resultat = action(tx.objectStore(MAGASIN));
    } catch (erreurAction) {
      regler(rejeter, erreurAction);
      return;
    }

    tx.oncomplete = () => {
      // Contrat de retour net : quand l'action rend une IDBRequest (get,
      // getAll…), on renvoie SA valeur — `.result`, même `undefined` quand
      // rien n'a été trouvé — jamais la requête elle-même. L'ancienne forme
      // `resultat?.result ?? resultat` retombait sur l'objet IDBRequest
      // (toujours "truthy") dès que `.result` valait `undefined`, ce qui
      // rendait par exemple un garde `if (!actuelle) return;` sur
      // `magasin.get(...)` inopérant : la vérification passait toujours,
      // quel que soit le contenu réel de la base.
      const valeur = resultat instanceof IDBRequest ? resultat.result : resultat;
      regler(resoudre, valeur);
    };
    tx.onerror = () => regler(rejeter, tx.error);
    // Une transaction peut avorter sans passer par onerror (quota dépassé,
    // fermeture forcée par le navigateur) : sans onabort, la promesse ne se
    // règlerait jamais et resterait suspendue derrière le seul délai de garde.
    tx.onabort = () => regler(rejeter, tx.error || new Error('Transaction IndexedDB interrompue'));
  });
}

export async function mettreEnFile(entree) {
  const idLocal = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const enregistrement = {
    ...entree,
    // Une entrée sans clé d'idempotence enverrait littéralement "undefined"
    // en en-tête, et comme cette clé doit être unique côté service, chaque
    // envoi suivant serait pris pour un rejeu du précédent puis supprimé de
    // la file sans avoir été transmis : perte silencieuse en cascade. La
    // tâche 8 fournira bien la clé en pratique, mais le module qui porte la
    // garantie « rien n'est perdu » ne doit pas en dépendre.
    idempotence: entree.idempotence ?? creerCleIdempotence(),
    idLocal,
    tentatives: 0,
    prochaineTentative: 0,
    dernierSouci: null,
    bloque: false,
  };
  await transaction('readwrite', (magasin) => magasin.put(enregistrement));
  signaler();
  return idLocal;
}

export async function listerFile(jour) {
  const toutes = await transaction('readonly', (magasin) => magasin.getAll());
  return (toutes || []).filter((e) => e.jour === jour);
}

export async function viderEntree(idLocal) {
  await transaction('readwrite', (magasin) => magasin.delete(idLocal));
  signaler();
}

/** Envoie une entrée, ou consigne pourquoi ça n'a pas marché.

    Ne lève jamais : tout incident (réseau, service, stockage local) est
    rattrapé à l'intérieur de cette fonction. C'est ce qui permet à
    `renvoyerMaintenant` de traiter chaque entrée indépendamment des autres
    (voir son commentaire). */
async function traiterEntree(entree) {
  if (Date.now() < entree.prochaineTentative) return;

  let envoiReussi = false;
  let erreurEnvoi = null;
  try {
    if (entree.type === 'media') {
      await envoyerMedia(entree);
    } else {
      await envoyerNote(entree);
    }
    envoiReussi = true;
  } catch (souci) {
    erreurEnvoi = souci;
  }

  if (envoiReussi) {
    // Le serveur a confirmé l'enregistrement : l'entrée a rempli son rôle,
    // il ne reste qu'un rangement local. Si CE rangement échoue (stockage
    // saturé, transaction interrompue), ce n'est pas un échec d'envoi — rien
    // n'a été perdu, un futur passage retentera le `delete` et l'idempotence
    // empêche tout doublon côté serveur en attendant. On journalise donc à
    // part, sans réécrire l'entrée avec un motif réseau qui mentirait sur ce
    // qui s'est réellement passé.
    try {
      await transaction('readwrite', (magasin) => magasin.delete(entree.idLocal));
      signaler();
    } catch (souciRangement) {
      console.error(
        `Souvenir ${entree.idLocal} envoyé avec succès, mais le retrait local a échoué (sera retenté) :`,
        souciRangement,
      );
    }
    return;
  }

  // L'envoi a réellement échoué.
  const definitif = erreurEnvoi instanceof ErreurService;
  const tentatives = entree.tentatives + 1;
  // Premier réessai après ATTENTE_MIN (2 s), puis doublement à chaque échec.
  const attente = Math.min(ATTENTE_MIN * 2 ** (tentatives - 1), ATTENTE_MAX);

  try {
    // L'auteur a pu abandonner cet envoi entretemps (`viderEntree`, appelée
    // par la tâche 8) pendant les jusqu'à 120 s que peut prendre un envoi
    // média : réécrire aveuglément la copie mémoire avec `put` recréerait
    // l'entrée qu'il croyait avoir supprimée. On relit donc l'état actuel —
    // `undefined` si elle n'existe plus, grâce au contrat de retour net de
    // `transaction()` — et on n'écrit que si l'entrée existe encore.
    const actuelle = await transaction('readonly', (magasin) => magasin.get(entree.idLocal));
    if (!actuelle) return;
    await transaction('readwrite', (magasin) => magasin.put({
      ...actuelle,
      tentatives,
      prochaineTentative: definitif ? Number.MAX_SAFE_INTEGER : Date.now() + attente,
      dernierSouci: erreurEnvoi.message,
      bloque: definitif,
    }));
    signaler();
  } catch (souciEcriture) {
    // Le rattrapage lui-même a échoué (ex. stockage saturé pendant le put).
    // Conformément à la garantie structurelle de `renvoyerMaintenant`, on ne
    // relance rien : on journalise et l'entrée reste dans l'état où elle
    // était avant cette tentative. Comme son `prochaineTentative` d'origine
    // est déjà passée, elle sera retentée dès le prochain passage.
    console.error(
      `Souvenir ${entree.idLocal} : échec du rattrapage après un envoi manqué, nouvelle tentative au prochain passage.`,
      souciEcriture,
    );
  }
}

/** Réessaie tous les envois dont l'heure est venue. */
export async function renvoyerMaintenant() {
  if (enCours) return;
  enCours = true;
  try {
    let toutes;
    try {
      toutes = (await transaction('readonly', (magasin) => magasin.getAll())) || [];
    } catch (souciListe) {
      // Impossible de seulement lire la file (ex. délai de garde atteint) :
      // rien à tenter ce passage-ci. `enCours` sera quand même libéré par le
      // `finally`, donc un futur déclencheur (réseau retrouvé, onglet
      // revisible, minuterie) retentera un passage complet plus tard.
      console.error("Impossible de lire la file d'attente :", souciListe);
      return;
    }
    for (const entree of toutes) {
      // Garantie STRUCTURELLE, et non dépendante du type d'erreur observée :
      // le traitement d'une entrée — envoi ET rattrapage d'échec compris —
      // se fait entièrement dans `traiterEntree`, elle-même entourée ici
      // d'un filet qui ne peut pas être court-circuité. Aucune exception,
      // qu'elle vienne du réseau, du stockage (quota dépassé) ou même du
      // rappel `signaler` fourni par l'appelant, ne doit pouvoir s'échapper
      // de cette itération et faire abandonner les entrées suivantes : une
      // entrée ne doit jamais pouvoir en bloquer une autre.
      try {
        await traiterEntree(entree);
      } catch (souciEntree) {
        console.error(
          `Souvenir ${entree.idLocal} : anomalie non rattrapée, entrée laissée en l'état pour un prochain passage.`,
          souciEntree,
        );
      }
    }
  } finally {
    enCours = false;
  }
}

let demarre = false;

function surVisibiliteChangee() {
  if (document.visibilityState === 'visible') renvoyerMaintenant();
}

/** Arme les trois déclencheurs de renvoi : réseau retrouvé, onglet revu, minuterie.

    Les écouteurs et la minuterie ne sont armés qu'une seule fois par onglet
    — la tâche 8 rappelle cette fonction à chaque affichage de fiche d'étape,
    et quinze étapes consultées dans la soirée ne doivent pas laisser quinze
    minuteries et écouteurs `visibilitychange` tourner pour de bon, à
    gaspiller la batterie d'un téléphone qui doit tenir la journée à 4 400 m.
    En revanche CHAQUE appel déclenche une tentative immédiate : revenir sur
    une étape déjà consultée doit relancer les envois en attente tout de
    suite, sans attendre le réseau, la visibilité ou la minuterie de 2 min. */
export function demarrerRenvoi({ surChangement } = {}) {
  if (surChangement) signaler = surChangement;
  if (!demarre) {
    demarre = true;
    addEventListener('online', renvoyerMaintenant);
    addEventListener('visibilitychange', surVisibiliteChangee);
    setInterval(renvoyerMaintenant, PERIODE);
  }
  renvoyerMaintenant();
}
