/* File d'attente des envois qui n'ont pas abouti.

   C'est la réponse au réseau des Andes : rien ne se perd quand ça ne passe pas.
   IndexedDB, et non localStorage, parce qu'elle seule stocke les fichiers
   binaires tels quels. */

import {
  envoyerNote, envoyerFichier, ErreurService, creerCleIdempotence,
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
// Depuis I3 (revue finale), le jeton d'auteur est en général déjà connu :
// généré par la vue à la mise en file (`entree.jeton`), il voyage avec
// l'entrée à travers ses éventuelles tentatives et survit donc à une réponse
// perdue en route. `traiterEntree` reste l'endroit où le capter — toujours
// sur TOUT succès désormais, y compris un rejeu, puisqu'il n'y a plus besoin
// d'attendre une réponse fraîche du service pour le connaître. (Une entrée
// mise en file avant ce correctif, sans `jeton`, retombe sur celui,
// éventuel, de la réponse — ancien comportement, seulement à la création.)
// Sur le même modèle que `signaler` : une variable de module plutôt qu'un
// argument transporté de bout en bout, remplacée à chaque appel de
// `demarrerRenvoi`. Ce module reste sans opinion sur ce qu'on en fait — pas
// de `localStorage`, pas de DOM ici, c'est la vue qui décide où ranger le
// jeton.
let surJeton = () => {};
let enCours = false;
// Amélioration A (re-revue) : un appel arrivé PENDANT une passe (ex. le
// `renvoyerMaintenant()` de C1, juste après la mise en file d'une note,
// pendant qu'une passe déclenchée par ailleurs traite déjà un média de
// 60 Mo — jusqu'à 120 s) était jusqu'ici purement avalé par
// `if (enCours) return;` : la note attendait alors la minuterie de 2 min,
// exactement le déclencheur de republication que C1 devait supprimer. Ce
// drapeau mémorise qu'une redemande est arrivée pendant la passe en cours ;
// `renvoyerMaintenant` la consomme lui-même via une boucle `do…while` autour
// de son corps inchangé, sans jamais faire tourner deux passes en parallèle
// (une seule à la fois, comme avant) et sans toucher à la garantie
// structurelle de la boucle interne.
let redemandeEnAttente = false;

// Connexion IndexedDB unique, réutilisée par toutes les transactions.
// Rouvrir à chaque opération (comme le faisait la première version) ouvre
// des milliers de connexions sur plusieurs semaines et, surtout, bloque tout
// futur changement de version du schéma tant qu'une seule reste ouverte.
let basePromise = null;

function ouvrir() {
  if (basePromise) return basePromise;

  // `indexedDB.open` peut lever de façon SYNCHRONE (navigation privée
  // Firefox, contexte restreint) : traité ICI, avant toute mémoïsation, pour
  // ne rien laisser en cache et permettre à l'appel suivant de retenter
  // proprement, sans dépendre du délai de garde pour se réparer.
  let requete;
  try {
    requete = indexedDB.open(BASE, 1);
  } catch (erreurSynchrone) {
    return Promise.reject(erreurSynchrone);
  }

  const promesse = new Promise((resoudre, rejeter) => {
    let reglee = false;

    function regler(fn, valeur) {
      if (reglee) return;
      reglee = true;
      clearTimeout(minuteurGarde);
      fn(valeur);
    }

    // Cinq endroits peuvent vouloir « oublier » cette connexion mémoïsée
    // (échec d'ouverture, blocage, délai de garde, fermeture forcée,
    // changement de version). Mais une fermeture tardive de CETTE tentative
    // d'ouverture peut arriver APRÈS qu'un appel ultérieur a déjà mémoïsé une
    // connexion SAINE différente (ex. : la transaction échoue et déclenche un
    // rattrapage immédiat qui rouvre, pendant que l'événement `close` de
    // l'ancienne connexion, lui, arrive plus tard sur une tâche distincte).
    // Effacer `basePromise` sans vérifier effacerait alors cette nouvelle
    // connexion valide au lieu de la connexion morte — fuite non bornée,
    // précisément ce que la mémoïsation devait éviter (elle bloquerait à
    // terme un futur changement de schéma). On ne l'efface donc que si elle
    // porte encore exactement sur CETTE tentative d'ouverture.
    function oublierSiCourante() {
      if (basePromise === promesse) basePromise = null;
    }

    // Une ouverture peut rester pendue indéfiniment sans jamais émettre
    // `onsuccess` ni `onerror` (cas connu sur WebKit/iOS après restauration
    // de page, précisément la plateforme visée) : sans ce garde, `enCours`
    // et `mettreEnFile` resteraient bloqués pour la vie de l'onglet, et la
    // mémoïsation de la connexion (voir plus bas) aggraverait le problème
    // en empoisonnant tous les appels futurs avec la même ouverture morte.
    const minuteurGarde = setTimeout(() => {
      oublierSiCourante();
      regler(rejeter, new Error('Ouverture IndexedDB sans réponse (délai dépassé)'));
    }, DELAI_OUVERTURE_MS);

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
      base.onclose = oublierSiCourante;
      // Un autre onglet (ou un futur déploiement avec un schéma v2) peut
      // demander une version supérieure : on ferme alors proprement notre
      // connexion pour ne pas la bloquer indéfiniment derrière `onblocked`.
      base.onversionchange = () => {
        base.close();
        oublierSiCourante();
      };
      regler(resoudre, base);
    };
    requete.onerror = () => {
      oublierSiCourante();
      regler(rejeter, requete.error);
    };
    requete.onblocked = () => {
      oublierSiCourante();
      regler(rejeter, new Error("Ouverture d'IndexedDB bloquée par un autre onglet"));
    };
  });

  basePromise = promesse;
  return basePromise;
}

async function transaction(mode, action) {
  // On capture la promesse elle-même (pas seulement la connexion qu'elle
  // rend) : c'est ce qui permet, plus bas, de vérifier qu'elle est toujours
  // LA connexion mémoïsée courante avant de l'effacer sur un échec.
  const promesseBase = ouvrir();
  const base = await promesseBase;
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
      //
      // Mais `abort()` lève `InvalidStateError` si la transaction a DÉJÀ
      // abouti (commitée, ou déjà interrompue) — ce qui peut arriver pile au
      // moment où ce délai se déclenche, sur une boucle d'événements chargée
      // (compression d'image en cours, par exemple). Dans ce cas précis,
      // « déjà terminée » signifie très précisément « l'écriture a eu
      // lieu » : rejeter quand même mentirait sur ce qui s'est passé et
      // ouvrirait exactement le doublon qu'on cherche à empêcher. On ne
      // rejette donc par ce garde QUE si `abort()` a réellement réussi à
      // interrompre la transaction ; sinon on laisse `tx.oncomplete` (qui va
      // se déclencher, puisque la transaction est terminée) régler la
      // promesse avec le vrai résultat.
      try {
        tx?.abort();
      } catch {
        return;
      }
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
      // On ne l'efface que si elle porte encore sur CETTE ouverture : une
      // fermeture tardive de l'ancienne connexion ne doit pas effacer une
      // nouvelle connexion saine mémoïsée entre-temps (voir `ouvrir`).
      if (basePromise === promesseBase) basePromise = null;
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
    // Une clé par fichier, figée ici : c'est ce qui permet de reprendre un
    // envoi interrompu au bon fichier sans jamais en attacher un deux fois.
    // Les générer au moment de l'envoi les changerait à chaque tentative, et
    // chaque renvoi ajouterait une copie de la même photo.
    idempotencesFichiers: (entree.fichiers || []).map(() => creerCleIdempotence()),
    contributionId: entree.contributionId ?? null,
    fichiersEnvoyes: 0,
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

/** Remet une entrée bloquée en état réessayable, avec un mot de passe à jour.

    Bouton « Réessayer » de la revue finale (C2) : sans repasser `bloque` à
    faux et `prochaineTentative` à 0, l'entrée resterait ignorée pour
    toujours par `traiterEntree`, même une fois le mot de passe corrigé. Le
    mot de passe est fourni par l'appelante (la vue) — ce module ne sait pas
    d'où il vient, seulement où le ranger. */
export async function reprendreEntree(idLocal, motDePasse) {
  let existe = false;
  await transaction('readwrite', (magasin) => {
    const requeteGet = magasin.get(idLocal);
    requeteGet.onsuccess = () => {
      const actuelle = requeteGet.result;
      if (!actuelle) return; // supprimée entretemps : rien à réessayer
      existe = true;
      magasin.put({
        ...actuelle,
        motDePasse,
        bloque: false,
        prochaineTentative: 0,
        refusMotDePasse: false,
      });
    };
    return requeteGet;
  });
  if (existe) signaler();
}

/** Envoie une entrée, ou consigne pourquoi ça n'a pas marché.

    Ne lève jamais : tout incident (réseau, service, stockage local) est
    rattrapé à l'intérieur de cette fonction. C'est ce qui permet à
    `renvoyerMaintenant` de traiter chaque entrée indépendamment des autres
    (voir son commentaire). */
/** Ramène une entrée à la forme courante.

    Un souvenir peut désormais porter plusieurs fichiers, envoyés un par un.
    Les entrées mises en file par la version précédente en portaient au plus
    un, sous `fichier`, et n'avaient ni progression ni identifiant de
    contribution. Les convertir à la lecture — plutôt qu'écrire une migration
    d'IndexedDB — évite qu'un envoi laissé en attente sur le téléphone de
    quelqu'un pendant la mise à jour du site reste bloqué pour de bon. */
function normaliser(entree) {
  if (Array.isArray(entree.fichiers)) return entree;
  const fichiers = entree.fichier ? [entree.fichier] : [];
  return {
    ...entree,
    fichiers,
    idempotencesFichiers: fichiers.map((_, i) => `${entree.idempotence}:${i}`),
    contributionId: entree.contributionId ?? null,
    fichiersEnvoyes: 0,
  };
}

/** Écrit la progression d'un envoi en cours, sans ressusciter une entrée
    abandonnée entretemps.

    Renvoie faux si l'entrée n'existe plus : l'auteur a cliqué « Abandonner »
    pendant l'envoi, et les fichiers restants ne doivent plus partir. */
async function enregistrerProgres(idLocal, champs) {
  let existe = false;
  await transaction('readwrite', (magasin) => {
    const requeteGet = magasin.get(idLocal);
    requeteGet.onsuccess = () => {
      const actuelle = requeteGet.result;
      if (!actuelle) return;
      existe = true;
      magasin.put({ ...actuelle, ...champs });
    };
    return requeteGet;
  });
  return existe;
}

/** Envoie une entrée, ou consigne pourquoi ça n'a pas marché.

    Ne lève jamais : tout incident (réseau, service, stockage local) est
    rattrapé à l'intérieur de cette fonction. C'est ce qui permet à
    `renvoyerMaintenant` de traiter chaque entrée indépendamment des autres
    (voir son commentaire).

    Un envoi se fait en plusieurs requêtes : la contribution d'abord, puis un
    fichier par requête. La progression est écrite dans la base locale APRÈS
    chaque étape réussie, si bien qu'une coupure au huitième fichier reprend
    au huitième et non au premier — c'est tout l'intérêt de ne pas grouper les
    envois. Chaque fichier porte sa propre clé d'idempotence, générée à la
    mise en file : un fichier dont la réponse s'est perdue en route n'est
    jamais attaché deux fois. */
async function traiterEntree(entreeBrute) {
  const entree = normaliser(entreeBrute);
  if (Date.now() < entree.prochaineTentative) return;

  let contributionId = entree.contributionId;
  let envoyes = entree.fichiersEnvoyes || 0;
  let erreurEnvoi = null;
  let abandonnee = false;

  try {
    // 1. La contribution elle-même. Déjà faite si une tentative précédente
    //    s'est arrêtée plus loin, et jamais nécessaire pour un ajout de
    //    fichiers à un souvenir déjà publié.
    if (!contributionId) {
      const reponse = await envoyerNote({
        jour: entree.jour,
        auteur: entree.auteur,
        texte: entree.texte,
        motDePasse: entree.motDePasse,
        idempotence: entree.idempotence,
        jeton: entree.jeton,
        avecMedias: entree.fichiers.length > 0,
      });
      contributionId = reponse?.contribution?.id;
      if (!contributionId) {
        // Réponse inexploitable : traitée comme un incident de transport,
        // donc renvoyée plus tard, plutôt que comme un refus définitif.
        throw new Error("Le service n'a pas renvoyé d'identifiant");
      }

      // Le jeton d'abord : sans lui, l'auteur perd ses boutons
      // Modifier/Supprimer — et, depuis que les fichiers s'attachent avec, la
      // possibilité même de compléter son souvenir. Filet propre : un rappel
      // fourni par la vue ne doit pas pouvoir compromettre la suite.
      try {
        surJeton(contributionId, entree.jeton || reponse?.jeton);
      } catch (souciJeton) {
        console.error(
          `Souvenir ${entree.idLocal} : le rappel de mémorisation du jeton a échoué.`,
          souciJeton,
        );
      }

      if (!await enregistrerProgres(entree.idLocal, { contributionId, fichiersEnvoyes: 0 })) {
        abandonnee = true;
      }
      signaler();
    }

    // 2. Les fichiers, un par un.
    while (!abandonnee && envoyes < entree.fichiers.length) {
      await envoyerFichier({
        contributionId,
        fichier: entree.fichiers[envoyes],
        idempotence: entree.idempotencesFichiers[envoyes],
        jeton: entree.jeton,
      });
      envoyes += 1;
      if (!await enregistrerProgres(entree.idLocal, { contributionId, fichiersEnvoyes: envoyes })) {
        abandonnee = true;
      }
      signaler();
    }
  } catch (souci) {
    erreurEnvoi = souci;
  }

  if (!erreurEnvoi) {
    // Abandonnée en cours de route : il n'y a plus rien à retirer, l'entrée
    // n'existe plus.
    if (abandonnee) return;

    // Le serveur a tout confirmé : l'entrée a rempli son rôle, il ne reste
    // qu'un rangement local. Si CE rangement échoue (stockage saturé,
    // transaction interrompue), ce n'est pas un échec d'envoi — rien n'a été
    // perdu, un futur passage retentera le `delete`, et les clés
    // d'idempotence empêchent tout doublon côté serveur en attendant. On
    // journalise donc à part, sans réécrire l'entrée avec un motif réseau qui
    // mentirait sur ce qui s'est réellement passé.
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
  // Un 401 signifie précisément un mot de passe refusé (`groupeAutorise` dans
  // le service) : c'est le seul cas où la vue doit effacer le mot de passe
  // mémorisé, pour que le champ réapparaisse plutôt que de rester bloqué pour
  // de bon derrière une faute de frappe (revue finale, C2). Seule la création
  // de la contribution présente ce mot de passe ; l'envoi des fichiers, lui,
  // s'autorise avec le jeton d'auteur.
  const refusMotDePasse = definitif && erreurEnvoi.statut === 401;
  const tentatives = entree.tentatives + 1;
  // Premier réessai après ATTENTE_MIN (2 s), puis doublement à chaque échec.
  const attente = Math.min(ATTENTE_MIN * 2 ** (tentatives - 1), ATTENTE_MAX);

  try {
    // L'auteur a pu abandonner cet envoi entretemps (`viderEntree`, appelée
    // par la vue) pendant les jusqu'à 120 s que peut prendre un fichier :
    // réécrire aveuglément la copie mémoire avec `put` recréerait l'entrée
    // qu'il croyait avoir supprimée. On relit donc l'état actuel — `undefined`
    // s'il n'existe plus, grâce au contrat de retour net de `transaction()` —
    // et on n'écrit que si l'entrée existe encore.
    //
    // La lecture et l'écriture se font dans la MÊME transaction `readwrite`
    // (le `put` est émis depuis le gestionnaire `onsuccess` du `get`, ce qui
    // le garde ouverte) plutôt que dans deux transactions séparées : sans
    // ça, la garantie « pas de résurrection » ne tiendrait que par une
    // propriété d'ordonnancement (rien ne s'intercale entre les deux appels)
    // plutôt que par construction.
    //
    // `contributionId` et `fichiersEnvoyes` sont réécrits ici aussi : une
    // étape peut avoir abouti avant celle qui a échoué, et la prochaine
    // tentative doit repartir de là.
    let entreeEncorePresente = false;
    await transaction('readwrite', (magasin) => {
      const requeteGet = magasin.get(entree.idLocal);
      requeteGet.onsuccess = () => {
        const actuelle = requeteGet.result;
        if (!actuelle) return; // supprimée entretemps : rien à réécrire
        entreeEncorePresente = true;
        magasin.put({
          ...actuelle,
          contributionId,
          fichiersEnvoyes: envoyes,
          tentatives,
          prochaineTentative: definitif ? Number.MAX_SAFE_INTEGER : Date.now() + attente,
          dernierSouci: erreurEnvoi.message,
          bloque: definitif,
          refusMotDePasse,
        });
      };
      return requeteGet;
    });
    if (entreeEncorePresente) signaler();
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
  if (enCours) {
    // Amélioration A : ne PAS avaler cette demande — une passe est déjà en
    // cours (potentiellement jusqu'à 120 s sur un média), la consommer
    // maintenant romprait « une seule passe à la fois ». On la mémorise pour
    // que la passe en cours en relance une autre, fraîche, dès qu'elle se
    // termine, sans jamais faire tourner deux passes en parallèle.
    redemandeEnAttente = true;
    return;
  }
  enCours = true;
  try {
    // La redemande est consommée ICI, en tête de chaque tour : une nouvelle
    // demande qui arrive PENDANT le tour (donc après cette ligne) sera
    // fidèlement reprise par le tour suivant plutôt que perdue.
    do {
      redemandeEnAttente = false;
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
      // I2 (revue finale) : les souvenirs sans fichier d'abord. Une vidéo peut
      // consommer jusqu'à 120 s par tentative sur un lien lent (le régime de
      // croisière attendu du voyage) ; sans ce tri, elle retiendrait les notes
      // en attente derrière elle dans la boucle strictement séquentielle
      // ci-dessous. Le test porte sur les fichiers réellement attachés plutôt
      // que sur `type`, qui ne distingue plus rien depuis qu'un souvenir peut
      // en porter plusieurs.
      const sansFichier = (e) => !(e.fichiers?.length || e.fichier);
      const ordre = [
        ...toutes.filter(sansFichier),
        ...toutes.filter((e) => !sansFichier(e)),
      ];
      for (const entree of ordre) {
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
    } while (redemandeEnAttente);
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
    suite, sans attendre le réseau, la visibilité ou la minuterie de 2 min.

    `memoriserJeton(id, jeton)` est optionnel, sur le même modèle que
    `surChangement` : appelé par `traiterEntree` sur tout envoi réussi (I3,
    revue finale : le jeton client survit à un rejeu, il n'est donc plus
    capté à la seule création). C'est le seul endroit où la vue apprend
    quel identifiant serveur correspond au jeton qu'elle connaît déjà —
    sans ce rappel, elle ne saurait jamais quels boutons Modifier/Supprimer
    afficher une fois l'entrée retirée de la file. */
export function demarrerRenvoi({ surChangement, memoriserJeton } = {}) {
  if (surChangement) signaler = surChangement;
  if (memoriserJeton) surJeton = memoriserJeton;
  if (!demarre) {
    demarre = true;
    addEventListener('online', renvoyerMaintenant);
    addEventListener('visibilitychange', surVisibiliteChangee);
    setInterval(renvoyerMaintenant, PERIODE);
  }
  renvoyerMaintenant();
}
