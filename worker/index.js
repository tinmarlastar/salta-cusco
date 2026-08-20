/* Service des souvenirs : notes, photos et vidéos postées par les participants.

   Le site reste statique ; seul le bloc « souvenirs » appelle ce service. */

import { creerId, creerJeton, hacherJeton, memeSecret } from './lib/securite.js';

const TEXTE_MAX = 2000;
const AUTEUR_MAX = 40;

const VIDEO_OCTETS_MAX = 60 * 1024 * 1024; // 60 Mo : au-delà, l'envoi en altitude n'aboutit pas
const IMAGE_OCTETS_MAX = 12 * 1024 * 1024; // le navigateur compresse déjà ; cette marge couvre les cas non compressés

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

const JSON_ENTETES = { 'Content-Type': 'application/json; charset=utf-8' };

/** En-têtes CORS pour l'origine appelante, si elle est autorisée. */
function entetesCors(requete, env) {
  const origine = requete.headers.get('Origin') || '';
  const autorisees = (env.ORIGINES_AUTORISEES || '').split(',').map((o) => o.trim());
  if (!autorisees.includes(origine)) return {};
  return {
    'Access-Control-Allow-Origin': origine,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Mot-De-Passe, X-Jeton, X-Idempotence',
    'Access-Control-Max-Age': '86400',
  };
}

function repondre(donnees, { statut = 200, cors = {} } = {}) {
  return new Response(JSON.stringify(donnees), {
    status: statut,
    headers: { ...JSON_ENTETES, ...cors },
  });
}

function erreur(message, statut, cors) {
  return repondre({ erreur: message }, { statut, cors });
}

/** Transforme une ligne de la base en objet public, sans le jeton. */
function versPublic(ligne) {
  return {
    id: ligne.id,
    jour: ligne.jour,
    auteur: ligne.auteur,
    type: ligne.type,
    texte: ligne.texte,
    media: ligne.media_cle
      ? { cle: ligne.media_cle, genre: ligne.media_genre, octets: ligne.media_octets }
      : null,
    creeLe: ligne.cree_le,
    modifieLe: ligne.modifie_le,
  };
}

async function listerEtape(jour, env, cors) {
  const { results } = await env.DB
    .prepare('SELECT * FROM contributions WHERE jour = ? ORDER BY id ASC')
    .bind(jour)
    .all();
  return repondre({ contributions: results.map(versPublic) }, { cors });
}

/** Vrai si la requête porte le mot de passe de groupe.
    On hache les deux côtés avant de comparer : `memeSecret` sort tôt quand les
    longueurs diffèrent, ce qui est sans effet sur un jeton (longueur fixe) mais
    trahirait la longueur d'un mot de passe choisi par un humain. Hacher ramène
    tout à 64 caractères et supprime cette fuite. */
async function groupeAutorise(requete, env) {
  const fourni = requete.headers.get('X-Mot-De-Passe');
  if (!fourni || !env.MOT_DE_PASSE_GROUPE) return false;
  return memeSecret(await hacherJeton(fourni), await hacherJeton(env.MOT_DE_PASSE_GROUPE));
}

/** Nettoie une chaîne venue du client : type, espaces superflus, longueur. */
function assainir(valeur, longueurMax) {
  if (typeof valeur !== 'string') return '';
  return valeur.trim().slice(0, longueurMax);
}

/** Insère une contribution ; renvoie l'existante si la clé a déjà servi. */
async function enregistrer(ligne, env) {
  try {
    await env.DB.prepare(
      `INSERT INTO contributions
         (id, jour, auteur, type, texte, media_cle, media_genre, media_octets,
          cree_le, modifie_le, jeton_hache, cle_idempotence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(
      ligne.id, ligne.jour, ligne.auteur, ligne.type, ligne.texte,
      ligne.media_cle, ligne.media_genre, ligne.media_octets,
      ligne.cree_le, ligne.jeton_hache, ligne.cle_idempotence,
    ).run();
    return { ligne, deja: false };
  } catch (souci) {
    // On vise précisément la contrainte `cle_idempotence`, pas le mot « UNIQUE »
    // seul : la table porte aussi une clé primaire sur `id`, dont la violation
    // produit elle aussi « UNIQUE » dans le message SQLite. Un test trop large
    // confondrait une vraie collision d'identifiant avec un rejeu, et irait
    // chercher une clé d'idempotence qui n'a jamais été insérée.
    if (!String(souci).includes('cle_idempotence')) throw souci;
    // Clé d'idempotence déjà vue : un renvoi après une réponse perdue en route.
    // On rend l'existante plutôt que de créer un doublon.
    const existante = await env.DB
      .prepare('SELECT * FROM contributions WHERE cle_idempotence = ?')
      .bind(ligne.cle_idempotence)
      .first();
    // Garde-fou : si rien ne correspond, le message ne décrivait pas réellement
    // un rejeu (formulation différente en production par ex.) — on relance
    // l'erreur d'origine plutôt que de renvoyer une ligne nulle à `versPublic`.
    if (!existante) throw souci;
    return { ligne: existante, deja: true };
  }
}

async function creerNote(jour, requete, env, cors) {
  if (!await groupeAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  const idempotence = assainir(requete.headers.get('X-Idempotence'), 80);
  if (!idempotence) return erreur('En-tête X-Idempotence manquant', 400, cors);

  const corps = await requete.json().catch(() => ({}));
  const auteur = assainir(corps.auteur, AUTEUR_MAX);
  const texte = assainir(corps.texte, TEXTE_MAX);
  if (!auteur) return erreur('Un prénom est nécessaire', 400, cors);
  if (!texte) return erreur('La note est vide', 400, cors);

  const jeton = creerJeton();
  const { ligne, deja } = await enregistrer({
    id: creerId(),
    jour,
    auteur,
    type: 'note',
    texte,
    media_cle: null,
    media_genre: null,
    media_octets: null,
    cree_le: new Date().toISOString(),
    jeton_hache: await hacherJeton(jeton),
    cle_idempotence: idempotence,
  }, env);

  // Sur un renvoi, l'entrée existe déjà et son jeton d'origine est perdu :
  // seul le premier envoi reçoit un jeton exploitable.
  return repondre(
    { contribution: versPublic(ligne), jeton: deja ? null : jeton },
    { statut: deja ? 200 : 201, cors },
  );
}

async function creerMedia(jour, requete, env, cors) {
  if (!await groupeAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  const idempotence = assainir(requete.headers.get('X-Idempotence'), 80);
  if (!idempotence) return erreur('En-tête X-Idempotence manquant', 400, cors);

  // Un corps illisible ici n'est presque jamais un envoi malformé exprès :
  // c'est un multipart de plusieurs dizaines de Mo tronqué en cours de route
  // par un réseau qui a lâché avant la fin (le cas courant en itinérance
  // andine). C'est donc un incident de transport, pas un refus légitime du
  // contenu : on répond en 5xx pour que le client (souvenirs.js) le classe en
  // ErreurReseau et que la file d'attente renvoie la photo plus tard, au lieu
  // de la bloquer pour de bon comme le ferait un 4xx. Les autres 400 de cette
  // fonction (prénom manquant, aucun fichier reçu) restent des refus
  // définitifs à juste titre : eux ne dépendent pas d'un transport interrompu.
  const formulaire = await requete.formData().catch(() => null);
  if (!formulaire) return erreur('Envoi illisible, réessayez', 503, cors);

  const auteur = assainir(formulaire.get('auteur'), AUTEUR_MAX);
  const texte = assainir(formulaire.get('texte'), TEXTE_MAX);
  const fichier = formulaire.get('fichier');
  if (!auteur) return erreur('Un prénom est nécessaire', 400, cors);
  if (!fichier || typeof fichier.arrayBuffer !== 'function') {
    return erreur('Aucun fichier reçu', 400, cors);
  }

  const genre = fichier.type.startsWith('video/') ? 'video' : 'image';
  const plafond = genre === 'video' ? VIDEO_OCTETS_MAX : IMAGE_OCTETS_MAX;
  if (fichier.size > plafond) {
    const mo = Math.round(plafond / (1024 * 1024));
    return erreur(
      genre === 'video'
        ? `Vidéo trop lourde (maximum ${mo} Mo). Raccourcissez le clip ou baissez la qualité.`
        : `Image trop lourde (maximum ${mo} Mo).`,
      413, cors,
    );
  }

  const extension = EXTENSIONS[fichier.type] || (genre === 'video' ? 'mp4' : 'jpg');
  const id = creerId();
  const cle = `medias/${jour}/${id}.${extension}`;

  // Le type MIME annoncé par le client n'est pas fiable : le mot de passe de
  // groupe circule de vive voix entre plusieurs personnes, et un type inventé
  // (HTML, SVG…) stocké tel quel serait ensuite resservi à l'identique par
  // `servirMedia`, exécutable par le navigateur sur le domaine du service. On
  // ne garde donc que les types qu'on connaît (clés de `EXTENSIONS`) ; tout le
  // reste — y compris un `application/octet-stream` légitime d'un iPhone pour
  // un HEIC — est stocké tel quel sous ce type neutre, jamais exécutable.
  const typeNormalise = EXTENSIONS[fichier.type] ? fichier.type : 'application/octet-stream';

  await env.MEDIAS.put(cle, fichier.stream(), {
    httpMetadata: { contentType: typeNormalise },
  });

  const jeton = creerJeton();
  const { ligne, deja } = await enregistrer({
    id,
    jour,
    auteur,
    type: 'media',
    texte,
    media_cle: cle,
    media_genre: genre,
    media_octets: fichier.size,
    cree_le: new Date().toISOString(),
    jeton_hache: await hacherJeton(jeton),
    cle_idempotence: idempotence,
  }, env);

  // Renvoi d'un média déjà enregistré : le fichier qu'on vient d'écrire est un
  // orphelin, on le retire pour ne pas encombrer le stockage. Ce nettoyage ne
  // doit jamais faire échouer la réponse : un rejeu idempotent doit répondre
  // 200 même si R2 refuse la suppression (erreur transitoire par ex.), sinon
  // le client croit à un échec alors que sa contribution est bien enregistrée
  // et retente sur un réseau capricieux.
  if (deja && ligne.media_cle !== cle) {
    await env.MEDIAS.delete(cle).catch((souci) => {
      console.error('Nettoyage du média orphelin impossible :', souci);
    });
  }

  return repondre(
    { contribution: versPublic(ligne), jeton: deja ? null : jeton },
    { statut: deja ? 200 : 201, cors },
  );
}

async function servirMedia(cle, env, cors) {
  const objet = await env.MEDIAS.get(cle);
  if (!objet) return erreur('Média introuvable', 404, cors);
  const entetes = new Headers(cors);
  objet.writeHttpMetadata(entetes);
  entetes.set('etag', objet.httpEtag);
  // Les fichiers ne changent jamais : le navigateur peut les garder longtemps.
  entetes.set('Cache-Control', 'public, max-age=31536000, immutable');
  // Empêche le navigateur de deviner un type différent du Content-Type stocké
  // (déjà normalisé au dépôt) et de l'exécuter comme HTML/SVG malgré tout.
  entetes.set('X-Content-Type-Options', 'nosniff');
  return new Response(objet.body, { headers: entetes });
}

/** Vrai si la requête porte le mot de passe d'administration.
    Même raisonnement que `groupeAutorise` : on hache les deux côtés avant de
    comparer, pour ne pas trahir la longueur d'un mot de passe choisi par un
    humain (`memeSecret` sort tôt quand les longueurs diffèrent). */
async function adminAutorise(requete, env) {
  const fourni = requete.headers.get('X-Mot-De-Passe');
  if (!fourni || !env.MOT_DE_PASSE_ADMIN) return false;
  return memeSecret(await hacherJeton(fourni), await hacherJeton(env.MOT_DE_PASSE_ADMIN));
}

/** Vrai si le jeton présenté est bien celui de cette contribution.
    `ligne.jeton_hache` et le jeton une fois haché sont deux empreintes
    SHA-256 de longueur fixe (64 caractères) : `memeSecret` s'y applique
    directement, sans le hachage supplémentaire qu'exige un mot de passe. */
async function auteurAutorise(requete, ligne) {
  const jeton = requete.headers.get('X-Jeton');
  if (!jeton) return false;
  return memeSecret(await hacherJeton(jeton), ligne.jeton_hache);
}

async function modifier(id, requete, env, cors) {
  const ligne = await env.DB
    .prepare('SELECT * FROM contributions WHERE id = ?').bind(id).first();
  if (!ligne) return erreur('Contribution introuvable', 404, cors);
  if (!await auteurAutorise(requete, ligne)) {
    return erreur("Seul l'auteur peut modifier cette contribution", 403, cors);
  }

  const corps = await requete.json().catch(() => ({}));
  const texte = assainir(corps.texte, TEXTE_MAX);
  // Une note vide n'a pas de sens ; la légende d'un média, si.
  if (!texte && ligne.type === 'note') return erreur('La note est vide', 400, cors);

  const modifieLe = new Date().toISOString();
  await env.DB
    .prepare('UPDATE contributions SET texte = ?, modifie_le = ? WHERE id = ?')
    .bind(texte, modifieLe, id)
    .run();

  return repondre(
    { contribution: versPublic({ ...ligne, texte, modifie_le: modifieLe }) },
    { cors },
  );
}

async function supprimer(id, requete, env, cors) {
  const ligne = await env.DB
    .prepare('SELECT * FROM contributions WHERE id = ?').bind(id).first();
  if (!ligne) return erreur('Contribution introuvable', 404, cors);

  // Court-circuit volontaire : `auteurAutorise` n'est haché/comparé que si
  // l'administration n'a pas déjà tranché.
  const permis = await adminAutorise(requete, env) || await auteurAutorise(requete, ligne);
  if (!permis) return erreur('Suppression non autorisée', 403, cors);

  // La base fait foi, comme dans `creerMedia` : on l'écrit d'abord, et le
  // nettoyage R2 vient ensuite avec un `.catch()` qui journalise sans casser
  // la réponse. Dans l'autre ordre, un DELETE en base qui échoue après un
  // retrait R2 réussi laisserait une contribution visible pointant vers un
  // fichier disparu — le pire état résiduel, celui que les participants
  // voient. Ici, le pire résiduel possible est un objet R2 orphelin,
  // invisible de tous.
  await env.DB.prepare('DELETE FROM contributions WHERE id = ?').bind(id).run();
  if (ligne.media_cle) {
    await env.MEDIAS.delete(ligne.media_cle).catch((souci) => {
      console.error('Nettoyage du média après suppression impossible :', souci);
    });
  }
  return repondre({ supprime: id }, { cors });
}

/** Liste toutes les contributions, pour la page de modération. */
async function listerTout(requete, env, cors) {
  if (!await adminAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);
  const { results } = await env.DB
    .prepare('SELECT * FROM contributions ORDER BY id DESC').all();
  return repondre({ contributions: results.map(versPublic) }, { cors });
}

export default {
  async fetch(requete, env) {
    const cors = entetesCors(requete, env);

    try {
      const url = new URL(requete.url);
      const chemin = url.pathname;

      if (requete.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }

      const etape = chemin.match(/^\/api\/etape\/(\d{1,2})$/);
      if (etape) {
        const jour = Number(etape[1]);
        // `await` est nécessaire ici : sans lui, un rejet de la promesse
        // survient après la sortie du bloc `try` et échappe au `catch`.
        if (requete.method === 'GET') return await listerEtape(jour, env, cors);
        if (requete.method === 'POST') return await creerNote(jour, requete, env, cors);
      }

      const media = chemin.match(/^\/api\/etape\/(\d{1,2})\/media$/);
      if (media && requete.method === 'POST') {
        return await creerMedia(Number(media[1]), requete, env, cors);
      }

      if (chemin.startsWith('/media/') && requete.method === 'GET') {
        return await servirMedia(decodeURIComponent(chemin.slice('/media/'.length)), env, cors);
      }

      const contribution = chemin.match(/^\/api\/contribution\/([0-9a-z]+)$/);
      if (contribution) {
        const id = contribution[1];
        if (requete.method === 'PATCH') return await modifier(id, requete, env, cors);
        if (requete.method === 'DELETE') return await supprimer(id, requete, env, cors);
      }

      if (chemin === '/api/tout' && requete.method === 'GET') {
        return await listerTout(requete, env, cors);
      }

      return erreur('Route inconnue', 404, cors);
    } catch (e) {
      // Capture large volontaire : le site doit se dégrader proprement si le
      // service est injoignable. On journalise pour garder l'erreur
      // diagnosticable, et on renvoie un message en français avec les
      // en-têtes CORS déjà calculés, sinon le navigateur ne voit qu'une
      // erreur CORS opaque au lieu du vrai message.
      console.error(e);
      return erreur('Erreur du service, réessayez plus tard', 500, cors);
    }
  },
};
