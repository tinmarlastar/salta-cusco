/* Service des souvenirs : notes, photos et vidéos postées par les participants.

   Le site reste statique ; seul le bloc « souvenirs » appelle ce service. */

import { creerId, creerJeton, hacherJeton, memeSecret } from './lib/securite.js';

const TEXTE_MAX = 2000;
const AUTEUR_MAX = 40;

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
    // Clé d'idempotence déjà vue : un renvoi après une réponse perdue en route.
    // On rend l'existante plutôt que de créer un doublon.
    if (!String(souci).includes('UNIQUE')) throw souci;
    const existante = await env.DB
      .prepare('SELECT * FROM contributions WHERE cle_idempotence = ?')
      .bind(ligne.cle_idempotence)
      .first();
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
