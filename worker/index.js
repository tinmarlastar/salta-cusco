/* Service des souvenirs : notes, photos et vidéos postées par les participants.

   Le site reste statique ; seul le bloc « souvenirs » appelle ce service. */

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

export default {
  async fetch(requete, env) {
    const cors = entetesCors(requete, env);
    const url = new URL(requete.url);
    const chemin = url.pathname;

    if (requete.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const etape = chemin.match(/^\/api\/etape\/(\d{1,2})$/);
    if (etape && requete.method === 'GET') {
      return listerEtape(Number(etape[1]), env, cors);
    }

    return erreur('Route inconnue', 404, cors);
  },
};
