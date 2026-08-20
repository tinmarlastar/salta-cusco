/* File d'attente des envois qui n'ont pas abouti.

   C'est la réponse au réseau des Andes : rien ne se perd quand ça ne passe pas.
   IndexedDB, et non localStorage, parce qu'elle seule stocke les fichiers
   binaires tels quels. */

import {
  envoyerNote, envoyerMedia, ErreurReseau, ErreurService,
} from './souvenirs.js';

const BASE = 'souvenirs-salta-cusco';
const MAGASIN = 'attente';

const ATTENTE_MIN = 2000;       // premier réessai après 2 s
const ATTENTE_MAX = 5 * 60_000; // plafonné à 5 min : en zone blanche, insister vide la batterie
const PERIODE = 2 * 60_000;     // relance périodique tant que l'onglet est ouvert

let signaler = () => {};
let enCours = false;

function ouvrir() {
  return new Promise((resoudre, rejeter) => {
    const requete = indexedDB.open(BASE, 1);
    requete.onupgradeneeded = () => {
      const base = requete.result;
      if (!base.objectStoreNames.contains(MAGASIN)) {
        base.createObjectStore(MAGASIN, { keyPath: 'idLocal' });
      }
    };
    requete.onsuccess = () => resoudre(requete.result);
    requete.onerror = () => rejeter(requete.error);
  });
}

async function transaction(mode, action) {
  const base = await ouvrir();
  return new Promise((resoudre, rejeter) => {
    const tx = base.transaction(MAGASIN, mode);
    const resultat = action(tx.objectStore(MAGASIN));
    tx.oncomplete = () => resoudre(resultat?.result ?? resultat);
    tx.onerror = () => rejeter(tx.error);
  });
}

export async function mettreEnFile(entree) {
  const idLocal = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const enregistrement = {
    ...entree,
    idLocal,
    tentatives: 0,
    prochaineTentative: 0,
    dernierSouci: null,
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

/** Réessaie tous les envois dont l'heure est venue. */
export async function renvoyerMaintenant() {
  if (enCours) return;
  enCours = true;
  try {
    const toutes = (await transaction('readonly', (magasin) => magasin.getAll())) || [];
    for (const entree of toutes) {
      if (Date.now() < entree.prochaineTentative) continue;
      try {
        if (entree.type === 'media') {
          await envoyerMedia(entree);
        } else {
          await envoyerNote(entree);
        }
        await transaction('readwrite', (magasin) => magasin.delete(entree.idLocal));
        signaler();
      } catch (souci) {
        // Refus explicite (mot de passe faux, fichier trop lourd) : réessayer
        // ne servirait à rien, on garde l'entrée avec son motif pour que
        // l'auteur voie ce qui bloque.
        const definitif = souci instanceof ErreurService;
        const tentatives = entree.tentatives + 1;
        const attente = Math.min(ATTENTE_MIN * 2 ** tentatives, ATTENTE_MAX);
        await transaction('readwrite', (magasin) => magasin.put({
          ...entree,
          tentatives,
          prochaineTentative: definitif ? Number.MAX_SAFE_INTEGER : Date.now() + attente,
          dernierSouci: souci.message,
          bloque: definitif,
        }));
        signaler();
        // Ici, la version d'origine relançait toute erreur qui n'était ni un
        // ErreurReseau ni un refus définitif du service. Ce bloc vit dans une
        // boucle for qui parcourt TOUTES les entrées en attente, elle-même
        // dans un try/finally sans autre filet : relancer l'erreur aurait
        // fait sortir de la boucle et abandonné le traitement de toutes les
        // entrées suivantes. Sur le terrain, un seul enregistrement corrompu
        // aurait alors suffi à bloquer le renvoi automatique de tous les
        // autres souvenirs en attente — inacceptable pour une file censée les
        // protéger. On choisit donc de ne jamais laisser une entrée en
        // interrompre d'autres : l'anomalie est journalisée, l'entrée reste
        // en file avec son motif (elle pourra être réexaminée), et le
        // traitement continue avec l'entrée suivante.
        if (!(souci instanceof ErreurReseau) && !definitif) {
          console.error("Souci inattendu au renvoi d'un souvenir en attente :", souci);
        }
      }
    }
  } finally {
    enCours = false;
  }
}

/** Arme les trois déclencheurs de renvoi : réseau retrouvé, onglet revu, minuterie. */
export function demarrerRenvoi({ surChangement } = {}) {
  if (surChangement) signaler = surChangement;
  addEventListener('online', renvoyerMaintenant);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renvoyerMaintenant();
  });
  setInterval(renvoyerMaintenant, PERIODE);
  renvoyerMaintenant();
}
