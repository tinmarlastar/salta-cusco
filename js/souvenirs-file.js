/* File d'attente des envois qui n'ont pas abouti.

   C'est la réponse au réseau des Andes : rien ne se perd quand ça ne passe pas.
   IndexedDB, et non localStorage, parce qu'elle seule stocke les fichiers
   binaires tels quels. */

import {
  envoyerNote, envoyerMedia, ErreurReseau, ErreurService, creerCleIdempotence,
} from './souvenirs.js';

const BASE = 'souvenirs-salta-cusco';
const MAGASIN = 'attente';

const ATTENTE_MIN = 2000;       // premier réessai après 2 s
const ATTENTE_MAX = 5 * 60_000; // plafonné à 5 min : en zone blanche, insister vide la batterie
const PERIODE = 2 * 60_000;     // relance périodique tant que l'onglet est ouvert

// Une transaction IndexedDB peut rester pendue sans jamais émettre ni
// `oncomplete` ni `onerror` — c'est ce qui arrive quand le navigateur ferme
// de force la connexion pour récupérer du stockage, précisément le sort
// d'une base pleine de photos sur un téléphone qui sature. `souvenirs.js`
// borne déjà ses appels réseau pour la même raison (`DELAI_RESEAU_MS`) ; le
// stockage local a besoin de la même garantie, sans quoi le verrou
// `enCours` pourrait rester bloqué pour toute la durée de vie de l'onglet.
const DELAI_STOCKAGE_MS = 8000;

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
      const requete = indexedDB.open(BASE, 1);
      requete.onupgradeneeded = () => {
        const base = requete.result;
        if (!base.objectStoreNames.contains(MAGASIN)) {
          base.createObjectStore(MAGASIN, { keyPath: 'idLocal' });
        }
      };
      requete.onsuccess = () => {
        const base = requete.result;
        // Un autre onglet (ou un futur déploiement avec un schéma v2) peut
        // demander une version supérieure : on ferme alors proprement notre
        // connexion pour ne pas la bloquer indéfiniment derrière `onblocked`.
        base.onversionchange = () => {
          base.close();
          basePromise = null;
        };
        resoudre(base);
      };
      requete.onerror = () => {
        basePromise = null;
        rejeter(requete.error);
      };
      requete.onblocked = () => {
        basePromise = null;
        rejeter(new Error("Ouverture d'IndexedDB bloquée par un autre onglet"));
      };
    });
  }
  return basePromise;
}

async function transaction(mode, action) {
  const base = await ouvrir();
  return new Promise((resoudre, rejeter) => {
    let reglee = false;
    // Délai de garde : le verrou de la file ne doit jamais dépendre d'un
    // événement dont l'émission n'est pas garantie (voir commentaire de
    // DELAI_STOCKAGE_MS).
    const minuteurGarde = setTimeout(() => {
      regler(rejeter, new Error('Transaction IndexedDB sans réponse (délai dépassé)'));
    }, DELAI_STOCKAGE_MS);

    function regler(fn, valeur) {
      if (reglee) return;
      reglee = true;
      clearTimeout(minuteurGarde);
      fn(valeur);
    }

    let tx;
    try {
      tx = base.transaction(MAGASIN, mode);
    } catch (erreurOuverture) {
      regler(rejeter, erreurOuverture);
      return;
    }

    let resultat;
    try {
      resultat = action(tx.objectStore(MAGASIN));
    } catch (erreurAction) {
      regler(rejeter, erreurAction);
      return;
    }

    tx.oncomplete = () => regler(resoudre, resultat?.result ?? resultat);
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
    // l'entrée qu'il croyait avoir supprimée. On relit donc l'état actuel et
    // on n'écrit que si l'entrée existe encore.
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
let idIntervalle = null;

function surVisibiliteChangee() {
  if (document.visibilityState === 'visible') renvoyerMaintenant();
}

/** Arme les trois déclencheurs de renvoi : réseau retrouvé, onglet revu, minuterie.

    Idempotente : la tâche 8 rappelle cette fonction à chaque affichage de
    fiche d'étape pour renouveler `surChangement`, mais les écouteurs et la
    minuterie ne doivent être armés qu'une seule fois par onglet — sans quoi
    quinze étapes consultées dans la soirée laisseraient quinze minuteries et
    écouteurs `visibilitychange` tourner pour de bon, à gaspiller la batterie
    d'un téléphone qui doit tenir la journée à 4 400 m. */
export function demarrerRenvoi({ surChangement } = {}) {
  if (surChangement) signaler = surChangement;
  if (demarre) return;
  demarre = true;
  addEventListener('online', renvoyerMaintenant);
  addEventListener('visibilitychange', surVisibiliteChangee);
  idIntervalle = setInterval(renvoyerMaintenant, PERIODE);
  renvoyerMaintenant();
}
