/* Service des souvenirs : notes, photos et vidéos postées par les participants.

   Le site reste statique ; seul le bloc « souvenirs » appelle ce service. */

import { creerId, creerJeton, hacherJeton, memeSecret } from './lib/securite.js';
import {
  calculerPositionAuto, dateDuJourVoyage, dateParisDuJour, PREMIER_JOUR_ROULE,
  calendrierDesBascules,
} from './lib/position.js';
import { normaliserEtape, assemblerStatistiques } from './lib/visites.js';
import { interpreterVote, assemblerReactions } from './lib/reactions.js';

const TEXTE_MAX = 5000; // de quoi raconter une journée entière, pas seulement une légende
const AUTEUR_MAX = 40;
const JOURS = 15;       // le voyage entier ; borne la journée d'une position

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
function versPublic(ligne, medias = [], reactions = []) {
  const liste = medias.map((m) => ({
    id: m.id, cle: m.cle, genre: m.genre, octets: m.octets,
  }));

  // Repli pour une contribution d'avant la table `medias` dont la reprise du
  // schéma n'aurait pas encore été jouée : son fichier est toujours dans ses
  // propres colonnes. Conditionné à une liste vide, donc jamais en doublon
  // avec la reprise une fois celle-ci appliquée.
  if (!liste.length && ligne.media_cle) {
    liste.push({
      id: ligne.id, cle: ligne.media_cle,
      genre: ligne.media_genre, octets: ligne.media_octets,
    });
  }

  return {
    id: ligne.id,
    jour: ligne.jour,
    auteur: ligne.auteur,
    type: ligne.type,
    texte: ligne.texte,
    medias: liste,
    // `media` au singulier reste renseigné avec le premier fichier : une page
    // encore ouverte sur l'ancienne version du site continue d'afficher
    // quelque chose au lieu de rien, jusqu'à son prochain rechargement.
    media: liste[0] || null,
    // Les smileys posés sous la note, du plus au moins nombreux. Absent des
    // réponses d'écriture (une note qu'on vient de poster n'en a aucune) : le
    // site lit le champ avec un repli sur la liste vide.
    reactions,
    creeLe: ligne.cree_le,
    modifieLe: ligne.modifie_le,
  };
}

/** Regroupe des lignes de `medias` par contribution, dans l'ordre d'affichage. */
function grouperMedias(lignes) {
  const par = new Map();
  for (const m of lignes) {
    if (!par.has(m.contribution_id)) par.set(m.contribution_id, []);
    par.get(m.contribution_id).push(m);
  }
  return par;
}

async function listerEtape(jour, env, cors) {
  // La plus récente en premier. Un carnet de route se lit comme un fil
  // d'actualité : ce qu'on vient d'écrire est ce qu'on vient voir, et sur une
  // journée bien remplie l'ordre chronologique obligeait à dérouler tout le
  // reste pour l'atteindre. L'identifiant préfixe l'horodatage, donc `id DESC`
  // suffit — et l'index (jour, id) se parcourt à l'envers aussi bien qu'à
  // l'endroit, sans qu'il y ait rien à changer au schéma.
  const { results } = await env.DB
    .prepare('SELECT * FROM contributions WHERE jour = ? ORDER BY id DESC')
    .bind(jour)
    .all();

  // Jointure côté base plutôt qu'un `IN (...)` construit depuis les
  // identifiants : D1 plafonne le nombre de paramètres liés, et une étape
  // chargée en souvenirs le dépasserait sans prévenir.
  const { results: medias } = await env.DB.prepare(
    `SELECT m.* FROM medias m
       JOIN contributions c ON c.id = m.contribution_id
      WHERE c.jour = ?
      ORDER BY m.contribution_id ASC, m.rang ASC, m.id ASC`,
  ).bind(jour).all();
  const parContribution = grouperMedias(medias);

  // Même jointure, même raison que pour les médias : un `IN (...)` construit
  // depuis les identifiants dépasserait le plafond de paramètres liés de D1
  // sur une étape bien remplie.
  const { results: reactions } = await env.DB.prepare(
    `SELECT r.* FROM reactions r
       JOIN contributions c ON c.id = r.contribution_id
      WHERE c.jour = ?`,
  ).bind(jour).all();
  const parReactions = assemblerReactions(reactions);

  return repondre({
    contributions: results.map((l) => versPublic(
      l, parContribution.get(l.id) || [], parReactions.get(l.id) || [],
    )),
  }, { cors });
}

/** Prochain rang libre pour une contribution : les fichiers gardent l'ordre
    dans lequel ils ont été choisis. */
async function prochainRang(contributionId, env) {
  const ligne = await env.DB
    .prepare('SELECT COALESCE(MAX(rang), -1) + 1 AS suivant FROM medias WHERE contribution_id = ?')
    .bind(contributionId)
    .first();
  return ligne?.suivant ?? 0;
}

/** Médias d'une contribution, dans l'ordre. */
async function mediasDe(contributionId, env) {
  const { results } = await env.DB
    .prepare('SELECT * FROM medias WHERE contribution_id = ? ORDER BY rang ASC, id ASC')
    .bind(contributionId)
    .all();
  return results;
}

/** Réactions d'une contribution, prêtes à afficher. */
async function reactionsDe(contributionId, env) {
  const { results } = await env.DB
    .prepare('SELECT * FROM reactions WHERE contribution_id = ?')
    .bind(contributionId)
    .all();
  return assemblerReactions(results).get(contributionId) || [];
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

/** Jeton d'auteur fourni par le client à la création (I3, revue finale), ou
    `null` s'il n'y en a pas.

    Avant ce correctif, le service générait seul le jeton et ne le renvoyait
    qu'une fois, à la création : une réponse perdue en route (le cas nominal
    en zone de réseau faible) faisait retrouver au client, sur le rejeu
    reconnu par la clé d'idempotence, un `jeton: null` définitif — la
    contribution restait publiée mais son auteur perdait pour toujours ses
    boutons Modifier/Supprimer. En laissant le client choisir son propre
    jeton (généré à la mise en file, avant tout envoi), le rejeu devient
    indifférent : il le connaît déjà, qu'il l'ait reçu en retour ou non. Le
    service n'en garde toujours que le SHA-256, jamais le jeton en clair. */
function jetonFourniParClient(requete) {
  return assainir(requete.headers.get('X-Jeton'), 128) || null;
}

/** Vrai si l'échec d'un `INSERT` est un rejeu — la clé d'idempotence a déjà
    servi — et non un problème de base.

    Les deux moitiés du test comptent. La clé d'idempotence seule ne suffit
    pas : « table medias has no column named cle_idempotence » la contient
    aussi, et une base au mauvais schéma (reprise jamais appliquée à distance,
    table créée à la main) était alors prise pour un renvoi. Le rattrapage
    allait chercher une ligne par une colonne inexistante, échouait à son
    tour, et la vraie cause disparaissait derrière une « erreur du service »
    que le client retente indéfiniment — un envoi de photo qui ne part jamais,
    sans que rien ne dise pourquoi.
    La violation d'unicité seule ne suffit pas non plus : la table porte aussi
    une clé primaire sur `id`, dont la violation produit le même « UNIQUE
    constraint failed » et désignerait, elle, une vraie collision
    d'identifiant. */
function estRejeu(souci) {
  const message = String(souci);
  return message.includes('UNIQUE constraint failed') && message.includes('cle_idempotence');
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
    if (!estRejeu(souci)) throw souci;
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
  // Un souvenir peut n'être qu'une série de photos, sans un mot : le client
  // annonce alors `avecMedias`, et les fichiers suivent en autant de requêtes
  // séparées. Sans cette annonce, une contribution sans texte reste un refus —
  // c'est le cas d'un formulaire envoyé vide par mégarde.
  const avecMedias = corps.avecMedias === true;
  if (!texte && !avecMedias) return erreur('La note est vide', 400, cors);

  // I3 : le client fournit en général déjà son jeton (généré à la mise en
  // file) ; à défaut — client plus ancien, ou entrée mise en file avant ce
  // correctif — le service en génère un comme auparavant.
  const jetonFourni = jetonFourniParClient(requete);
  const jeton = jetonFourni || creerJeton();
  const { ligne, deja } = await enregistrer({
    id: creerId(),
    jour,
    auteur,
    type: avecMedias ? 'media' : 'note',
    texte,
    media_cle: null,
    media_genre: null,
    media_octets: null,
    cree_le: new Date().toISOString(),
    jeton_hache: await hacherJeton(jeton),
    cle_idempotence: idempotence,
  }, env);

  // Sur un renvoi, l'entrée existe déjà : son jeton d'origine (fourni par le
  // client ou généré ici) n'est jamais rejoué. Un client qui a fourni le
  // sien le connaît déjà, donc peu importe ; un client qui dépendait de la
  // génération côté service, lui, le perdrait sans recours — exactement ce
  // que ce correctif élimine pour les clients à jour.
  // Sur un rejeu, des fichiers ont pu être attachés entre-temps : on les relit
  // plutôt que de répondre une contribution qui paraîtrait vide.
  const medias = deja ? await mediasDe(ligne.id, env) : [];
  return repondre(
    { contribution: versPublic(ligne, medias), jeton: (deja || jetonFourni) ? null : jeton },
    { statut: deja ? 200 : 201, cors },
  );
}

/** Valide un fichier reçu et le dépose dans R2. Renvoie soit `{ media }`,
    soit `{ refus }` — une réponse d'erreur déjà formée. */
async function deposerFichier(fichier, jour, env, cors) {
  if (!fichier || typeof fichier.arrayBuffer !== 'function') {
    return { refus: erreur('Aucun fichier reçu', 400, cors) };
  }

  const genre = fichier.type.startsWith('video/') ? 'video' : 'image';
  const plafond = genre === 'video' ? VIDEO_OCTETS_MAX : IMAGE_OCTETS_MAX;
  if (fichier.size > plafond) {
    const mo = Math.round(plafond / (1024 * 1024));
    return {
      refus: erreur(
        genre === 'video'
          ? `Vidéo trop lourde (maximum ${mo} Mo). Raccourcis le clip ou baisse la qualité.`
          : `Image trop lourde (maximum ${mo} Mo).`,
        413, cors,
      ),
    };
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

  return { media: { id, cle, genre, octets: fichier.size } };
}

/** Insère une ligne de `medias` ; renvoie l'existante si la clé a déjà servi.

    Même raisonnement que `enregistrer` pour les contributions : un renvoi
    après une réponse perdue en route ne doit pas attacher deux fois la même
    photo. Chaque fichier porte sa propre clé d'idempotence, générée par le
    client à la mise en file, si bien qu'une reprise à mi-parcours reprend
    exactement là où elle s'était arrêtée. */
async function enregistrerMedia(media, contributionId, env) {
  const rang = await prochainRang(contributionId, env);
  try {
    await env.DB.prepare(
      `INSERT INTO medias
         (id, contribution_id, cle, genre, octets, rang, cree_le, cle_idempotence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      media.id, contributionId, media.cle, media.genre, media.octets,
      rang, new Date().toISOString(), media.cle_idempotence,
    ).run();
    return { deja: false };
  } catch (souci) {
    if (!estRejeu(souci)) throw souci;
    const existante = await env.DB
      .prepare('SELECT * FROM medias WHERE cle_idempotence = ?')
      .bind(media.cle_idempotence)
      .first();
    if (!existante) throw souci;
    // Le fichier qu'on vient d'écrire est un orphelin : le rejeu porte déjà le
    // sien. Le nettoyage ne doit jamais faire échouer la réponse — un rejeu
    // idempotent reste un succès même si R2 refuse la suppression, sinon le
    // client croit à un échec alors que tout est en place et renvoie la vidéo.
    if (existante.cle !== media.cle) {
      await env.MEDIAS.delete(media.cle).catch((souci2) => {
        console.error('Nettoyage du média orphelin impossible :', souci2);
      });
    }
    return { deja: true };
  }
}

/** Route héritée : contribution et fichier unique en une seule requête.

    Le site n'y passe plus — il crée la contribution puis attache les fichiers
    un par un, ce qui permet d'en envoyer plusieurs et de reprendre un envoi
    interrompu au bon endroit. Elle reste servie pour une page encore ouverte
    sur l'ancienne version, et écrit dans `medias` comme le reste. */
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
  if (!formulaire) return erreur('Envoi illisible, réessaie', 503, cors);

  const auteur = assainir(formulaire.get('auteur'), AUTEUR_MAX);
  const texte = assainir(formulaire.get('texte'), TEXTE_MAX);
  if (!auteur) return erreur('Un prénom est nécessaire', 400, cors);

  const { media, refus } = await deposerFichier(formulaire.get('fichier'), jour, env, cors);
  if (refus) return refus;

  const jetonFourni = jetonFourniParClient(requete);
  const jeton = jetonFourni || creerJeton();
  const { ligne, deja } = await enregistrer({
    id: creerId(),
    jour,
    auteur,
    type: 'media',
    texte,
    media_cle: null,
    media_genre: null,
    media_octets: null,
    cree_le: new Date().toISOString(),
    jeton_hache: await hacherJeton(jeton),
    cle_idempotence: idempotence,
  }, env);

  if (deja) {
    // Rejeu : la contribution existe, son fichier aussi. On retire l'orphelin
    // qu'on vient d'écrire, sans jamais faire échouer la réponse.
    await env.MEDIAS.delete(media.cle).catch((souci) => {
      console.error('Nettoyage du média orphelin impossible :', souci);
    });
  } else {
    await enregistrerMedia({ ...media, cle_idempotence: `${idempotence}:0` }, ligne.id, env);
  }

  return repondre(
    {
      contribution: versPublic(ligne, await mediasDe(ligne.id, env), await reactionsDe(ligne.id, env)),
      jeton: (deja || jetonFourni) ? null : jeton,
    },
    { statut: deja ? 200 : 201, cors },
  );
}

/** Attache un fichier à une contribution existante.

    C'est le chemin normal depuis le site : une requête par fichier, ce qui
    permet d'en envoyer plusieurs et, sur un réseau qui lâche, de ne
    recommencer que celui qui a échoué plutôt que les 200 Mo précédents. C'est
    aussi ce qui permet d'ajouter une photo à un souvenir publié la veille.

    L'autorisation est celle de la modification, pas celle de la publication :
    le jeton d'auteur, que seul l'auteur possède, ou le mot de passe
    d'administration. Le mot de passe de groupe n'est donc pas redemandé pour
    compléter son propre souvenir. */
async function ajouterMedia(id, requete, env, cors) {
  const ligne = await env.DB
    .prepare('SELECT * FROM contributions WHERE id = ?').bind(id).first();
  if (!ligne) return erreur('Contribution introuvable', 404, cors);

  const permis = await auteurAutorise(requete, ligne) || await adminAutorise(requete, env);
  if (!permis) return erreur("Seul l'auteur peut compléter ce souvenir", 403, cors);

  const idempotence = assainir(requete.headers.get('X-Idempotence'), 80);
  if (!idempotence) return erreur('En-tête X-Idempotence manquant', 400, cors);

  // Voir `creerMedia` : un multipart tronqué par le réseau est un incident de
  // transport, à renvoyer plus tard, pas un refus définitif.
  const formulaire = await requete.formData().catch(() => null);
  if (!formulaire) return erreur('Envoi illisible, réessaie', 503, cors);

  const { media, refus } = await deposerFichier(formulaire.get('fichier'), ligne.jour, env, cors);
  if (refus) return refus;

  await enregistrerMedia({ ...media, cle_idempotence: idempotence }, ligne.id, env);

  // Une contribution qui reçoit son premier fichier cesse d'être une simple
  // note : `type` sert encore à `modifier`, qui refuse de vider le texte d'une
  // note mais l'accepte pour la légende d'un média.
  if (ligne.type !== 'media') {
    await env.DB.prepare('UPDATE contributions SET type = ? WHERE id = ?')
      .bind('media', ligne.id).run();
  }

  return repondre(
    {
      contribution: versPublic(
        { ...ligne, type: 'media' },
        await mediasDe(ligne.id, env),
        await reactionsDe(ligne.id, env),
      ),
    },
    { cors },
  );
}

/** Retire un fichier d'un souvenir, sans toucher au reste.

    Sans ça, une photo ajoutée par erreur obligerait à supprimer le souvenir
    entier — texte et autres photos comprises — pour la faire disparaître. */
async function supprimerMedia(idMedia, requete, env, cors) {
  const media = await env.DB
    .prepare('SELECT * FROM medias WHERE id = ?').bind(idMedia).first();
  if (!media) return erreur('Fichier introuvable', 404, cors);

  const ligne = await env.DB
    .prepare('SELECT * FROM contributions WHERE id = ?').bind(media.contribution_id).first();
  if (!ligne) return erreur('Contribution introuvable', 404, cors);

  const permis = await adminAutorise(requete, env) || await auteurAutorise(requete, ligne);
  if (!permis) return erreur('Suppression non autorisée', 403, cors);

  // Même ordre que `supprimer` : la base fait foi, R2 est nettoyé ensuite.
  await env.DB.prepare('DELETE FROM medias WHERE id = ?').bind(idMedia).run();
  await env.MEDIAS.delete(media.cle).catch((souci) => {
    console.error('Nettoyage du média après suppression impossible :', souci);
  });

  return repondre(
    { contribution: versPublic(ligne, await mediasDe(ligne.id, env), await reactionsDe(ligne.id, env)) },
    { cors },
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
  // Une note vide n'a pas de sens ; la légende d'un média, si. On regarde les
  // fichiers réellement attachés plutôt que la seule colonne `type` : une
  // contribution créée comme note a pu recevoir des photos depuis.
  const porteDesFichiers = ligne.type === 'media' || (await mediasDe(id, env)).length > 0;
  if (!texte && !porteDesFichiers) return erreur('La note est vide', 400, cors);

  const modifieLe = new Date().toISOString();
  await env.DB
    .prepare('UPDATE contributions SET texte = ?, modifie_le = ? WHERE id = ?')
    .bind(texte, modifieLe, id)
    .run();

  return repondre(
    {
      contribution: versPublic(
        { ...ligne, texte, modifie_le: modifieLe },
        await mediasDe(id, env),
        await reactionsDe(id, env),
      ),
    },
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
  // Les clés R2 sont relevées AVANT le DELETE : après, les lignes de `medias`
  // n'existent plus et les fichiers deviendraient introuvables, donc
  // impossibles à nettoyer.
  const cles = (await mediasDe(id, env)).map((m) => m.cle);
  if (ligne.media_cle) cles.push(ligne.media_cle); // contribution d'avant la table

  await env.DB.prepare('DELETE FROM contributions WHERE id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM medias WHERE contribution_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM reactions WHERE contribution_id = ?').bind(id).run();
  for (const cle of cles) {
    await env.MEDIAS.delete(cle).catch((souci) => {
      console.error('Nettoyage du média après suppression impossible :', souci);
    });
  }
  return repondre({ supprime: id }, { cors });
}

/** Nombre de souvenirs par journée, en un seul appel.

    Le site en a besoin au chargement pour pastiller les quinze journées de son
    bandeau : sans cette route il faudrait quinze requêtes — une par étape —
    juste pour savoir où il y a quelque chose à voir. Lecture libre, comme le
    reste des lectures. */
async function compter(env, cors) {
  const { results } = await env.DB
    .prepare('SELECT jour, COUNT(*) AS nombre FROM contributions GROUP BY jour')
    .all();
  // Objet plutôt que tableau : le client indexe par jour, jamais par position.
  const decomptes = {};
  for (const ligne of results) decomptes[ligne.jour] = ligne.nombre;
  return repondre({ decomptes }, { cors });
}

const CLES_POSITION = {
  mode: 'position_mode',
  jour: 'position_jour',
  depart: 'position_depart',
  decalage: 'position_decalage',
  // Les deux dates annoncées à la main, aux bouts du voyage. Elles ne disent
  // pas OÙ sont les motos : elles complètent le mode manuel, qui ne connaît
  // aucun calendrier, là où le mode automatique déduit les siennes de la date
  // de départ. D'où des clés à part, qu'un retour à « pas encore partis »
  // n'efface pas — la date du départ prévu vaut justement pour cet état-là.
  departPrevu: 'position_depart_prevu',
  arrivee: 'position_arrivee',
};

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Position des motos, journée déjà calculée. Ouverte en lecture, comme les
    souvenirs : c'est ce que les proches viennent voir. `mode`, `depart` et
    `decalage` accompagnent la réponse pour la modération, qui en a besoin
    pour réafficher le formulaire tel qu'il a été laissé — rien de sensible,
    le site public les ignore (voir `lirePosition` dans souvenirs.js, qui n'en
    garde rien) — `departPrevuPose` et `arriveePosee`, les deux dates saisies
    à la main, sont là pour la même raison : réafficher les champs tels quels,
    même quand le moment de les annoncer n'est pas venu. `departPrevuLe` et
    `arriveeLe`, eux, s'adressent au site public : c'est ce qu'il écrit sur la
    frise aux deux bouts du voyage, et rien d'autre. */
async function lirePosition(env, cors) {
  const { results } = await env.DB
    .prepare('SELECT cle, valeur, maj_le FROM reglages WHERE cle IN (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(
      CLES_POSITION.mode, CLES_POSITION.jour, CLES_POSITION.depart, CLES_POSITION.decalage,
      CLES_POSITION.departPrevu, CLES_POSITION.arrivee,
    )
    .all();
  const parCle = new Map(results.map((l) => [l.cle, l]));

  // Une base d'avant ce réglage n'a que `position_jour`, jamais
  // `position_mode` : un mode absent avec une journée posée se lit comme
  // manuel, sans migration à écrire.
  const mode = parCle.get(CLES_POSITION.mode)?.valeur
    ?? (parCle.get(CLES_POSITION.jour) ? 'manuel' : null);

  const jourManuel = Number(parCle.get(CLES_POSITION.jour)?.valeur);
  const depart = parCle.get(CLES_POSITION.depart)?.valeur ?? null;
  const decalage = Number(parCle.get(CLES_POSITION.decalage)?.valeur ?? 0);
  const departPrevuPose = parCle.get(CLES_POSITION.departPrevu)?.valeur ?? null;
  const arriveePosee = parCle.get(CLES_POSITION.arrivee)?.valeur ?? null;

  let jour = null;
  if (mode === 'manuel' && Number.isInteger(jourManuel)) jour = jourManuel;

  // Les deux extrémités du voyage, à annoncer plutôt qu'à taire : avant le
  // départ, la frise dit quand il est prévu ; une fois J15 atteint, elle dit
  // quand on est arrivés. Datées ICI, et non côté site : le calendrier du
  // voyage est l'affaire du service, le site public n'a jamais eu à savoir
  // qu'un mode automatique existe (il reçoit une journée toute faite).
  //
  // Jamais plus d'une des deux à la fois : en cours de route il n'y a rien à
  // annoncer — « Nous sommes ici ! » suffit.
  //
  // L'automatique les calcule depuis la date de départ ; le manuel, qui
  // n'a pas de calendrier à dérouler, reprend telles quelles les dates que
  // la modération a saisies — et n'en annonce, aux mêmes moments, jamais
  // plus d'une. Une date posée alors qu'on est en chemin attend sans rien
  // dire : elle ressortira au bout du voyage.
  let departPrevuLe = null;
  let arriveeLe = null;
  if (mode === 'auto' && depart) {
    jour = calculerPositionAuto({ depart, decalage });
    // La date annoncée est celle où l'on QUITTE Salta, donc celle de la première
    // journée roulée — J1 est le rassemblement sur place, pas un départ.
    if (jour === null) {
      departPrevuLe = dateDuJourVoyage({ depart, decalage, jour: PREMIER_JOUR_ROULE });
    }
    if (jour === JOURS) arriveeLe = dateDuJourVoyage({ depart, decalage, jour: JOURS });
  } else {
    if (jour === null) departPrevuLe = departPrevuPose;
    if (jour === JOURS) arriveeLe = arriveePosee;
  }

  const majLe = parCle.get(CLES_POSITION.mode)?.maj_le
    ?? parCle.get(CLES_POSITION.jour)?.maj_le
    ?? null;

  return repondre({
    jour, majLe, mode, depart, decalage,
    departPrevuLe, arriveeLe, departPrevuPose, arriveePosee,
  }, { cors });
}

async function poserReglage(env, cle, valeur, majLe) {
  await env.DB.prepare(
    `INSERT INTO reglages (cle, valeur, maj_le) VALUES (?1, ?2, ?3)
       ON CONFLICT(cle) DO UPDATE SET valeur = ?2, maj_le = ?3`,
  ).bind(cle, valeur, majLe).run();
}

async function effacerReglage(env, cle) {
  await env.DB.prepare('DELETE FROM reglages WHERE cle = ?1').bind(cle).run();
}

async function ecrirePosition(requete, env, cors) {
  if (!await adminAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  const corps = await requete.json().catch(() => ({}));
  const majLe = new Date().toISOString();

  // Tout est vérifié avant qu'une seule ligne ne bouge : une requête qui
  // porte à la fois un mode et une date annoncée ne doit pas poser l'une
  // puis refuser l'autre, laissant la modération devant un réglage à
  // moitié écrit qu'elle n'a pas demandé.
  const aPoser = [];
  const aEffacer = [];

  // Les dates annoncées ne sont touchées que si la requête les porte : le
  // menu des journées et les champs de date s'enregistrent séparément, et
  // changer de journée ne doit pas emporter une date saisie plus tôt.
  for (const [champ, cle] of [
    ['departPrevuLe', CLES_POSITION.departPrevu],
    ['arriveeLe', CLES_POSITION.arrivee],
  ]) {
    if (!(champ in corps)) continue;
    const valeur = corps[champ] || null; // champ vidé (null ou '') : la date s'efface
    if (valeur === null) { aEffacer.push(cle); continue; }
    if (typeof valeur !== 'string' || !DATE_ISO.test(valeur)) {
      return erreur('Date annoncée attendue au format AAAA-MM-JJ', 400, cors);
    }
    aPoser.push([cle, valeur]);
  }

  // `mode: null` efface la position : retour à « pas encore partis ». C'est
  // un état légitime, pas une donnée manquante, d'où la suppression des
  // lignes plutôt qu'une valeur convenue qu'il faudrait ensuite reconnaître
  // partout. Les dates annoncées, elles, ne sont pas des positions : elles
  // survivent, sinon la date du départ prévu disparaîtrait au moment précis
  // où elle sert.
  if (corps.mode === null) {
    aEffacer.push(
      CLES_POSITION.mode, CLES_POSITION.jour, CLES_POSITION.depart, CLES_POSITION.decalage,
    );
  } else if (corps.mode === 'manuel') {
    const jour = Number(corps.jour);
    if (!Number.isInteger(jour) || jour < 1 || jour > JOURS) {
      return erreur(`Journée attendue entre 1 et ${JOURS}`, 400, cors);
    }
    aPoser.push([CLES_POSITION.mode, 'manuel'], [CLES_POSITION.jour, String(jour)]);
  } else if (corps.mode === 'auto') {
    const depart = corps.depart;
    if (typeof depart !== 'string' || !DATE_ISO.test(depart)) {
      return erreur('Date de départ attendue au format AAAA-MM-JJ', 400, cors);
    }
    const decalage = corps.decalage === undefined ? 0 : Number(corps.decalage);
    if (!Number.isInteger(decalage) || decalage < -30 || decalage > 30) {
      return erreur('Décalage attendu entre -30 et 30 jours', 400, cors);
    }
    aPoser.push(
      [CLES_POSITION.mode, 'auto'], [CLES_POSITION.depart, depart],
      [CLES_POSITION.decalage, String(decalage)],
    );
  } else {
    return erreur('Réglage de position invalide', 400, cors);
  }

  for (const cle of aEffacer) await effacerReglage(env, cle);
  for (const [cle, valeur] of aPoser) await poserReglage(env, cle, valeur, majLe);
  return lirePosition(env, cors);
}

/** Liste toutes les contributions, pour la page de modération. */
/** Pose, déplace ou retire un smiley sous une note.

    La route est PUBLIQUE — n'importe quel lecteur du site peut réagir, sans le
    mot de passe du groupe : c'est tout l'intérêt, un proche qui suit le voyage
    depuis chez lui n'a pas de mot de passe et doit pouvoir dire qu'il a aimé.
    Elle est en revanche réservée aux origines déjà autorisées, comme le
    compteur de visites : sans ce garde, une boucle de `curl` gonflerait les
    compteurs et mangerait le forfait d'écritures de D1. Ce n'est pas
    inviolable — une origine se forge — c'est proportionné à un carnet que
    suivent quelques dizaines de proches.

    Rien n'est enregistré sur qui réagit. Le couple (smiley voulu, smiley
    précédent) vient du navigateur, seul à savoir ce qu'il a déjà posé ; le
    service ne peut ni le vérifier, ni distinguer deux lecteurs. C'est le prix
    — assumé — de réactions qui n'espionnent personne. */
async function reagir(id, requete, env, cors) {
  if (!cors['Access-Control-Allow-Origin']) return erreur('Origine non autorisée', 403, cors);

  const vote = interpreterVote(await requete.json().catch(() => ({})));
  if (!vote) return erreur('Smiley inconnu', 400, cors);

  const existe = await env.DB
    .prepare('SELECT id FROM contributions WHERE id = ?').bind(id).first();
  if (!existe) return erreur('Contribution introuvable', 404, cors);

  // Les deux écritures partent ensemble : un déplacement de vote qui
  // n'appliquerait que le retrait ferait disparaître une réaction sans en
  // reposer aucune, et l'écran du lecteur montrerait alors l'inverse de ce
  // qu'il vient de cliquer.
  const ordres = [];
  if (vote.retirer) {
    // `MAX(..., 0)` plutôt qu'une simple soustraction : deux retraits partis
    // en même temps depuis deux onglets feraient passer le compteur sous zéro,
    // et un compteur négatif ne remonte jamais tout seul.
    ordres.push(env.DB.prepare(
      'UPDATE reactions SET compte = MAX(compte - 1, 0) WHERE contribution_id = ? AND smiley = ?',
    ).bind(id, vote.retirer));
  }
  if (vote.poser) {
    ordres.push(env.DB.prepare(
      `INSERT INTO reactions (contribution_id, smiley, compte) VALUES (?, ?, 1)
         ON CONFLICT (contribution_id, smiley) DO UPDATE SET compte = compte + 1`,
    ).bind(id, vote.poser));
  }
  if (ordres.length) await env.DB.batch(ordres);

  // On renvoie l'état complet des réactions de la note, pas seulement le
  // compteur touché : le navigateur a peint son clic sans attendre, et c'est
  // cette réponse qui le remet d'accord avec la base si quelqu'un d'autre a
  // réagi entre-temps.
  return repondre({ reactions: await reactionsDe(id, env) }, { cors });
}

async function listerTout(requete, env, cors) {
  if (!await adminAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);
  const { results } = await env.DB
    .prepare('SELECT * FROM contributions ORDER BY id DESC').all();
  const { results: medias } = await env.DB
    .prepare('SELECT * FROM medias ORDER BY contribution_id ASC, rang ASC, id ASC').all();
  const parContribution = grouperMedias(medias);
  return repondre({
    contributions: results.map((l) => versPublic(l, parContribution.get(l.id) || [])),
  }, { cors });
}

/** Compte une page vue, et un visiteur si le navigateur dit en être un.

    La route est PUBLIQUE — c'est un site public — mais réservée aux origines
    déjà autorisées : sans ce garde, une boucle de `curl` gonflerait les
    chiffres et mangerait le forfait d'écritures de D1 pour rien. Ce n'est pas
    inviolable, une origine se forge ; c'est proportionné à un carnet que
    suivent quelques dizaines de proches.

    `visiteur` vient du navigateur, qui seul sait s'il a déjà été compté
    aujourd'hui. Le service ne le vérifie pas et ne peut pas : il ne garde rien
    qui permette de reconnaître un lecteur. C'est le prix — assumé — d'un
    compteur qui n'espionne personne.

    Le jour est celui de Paris, comme le reste du site : c'est le fuseau de ceux
    qui suivent le voyage. */
async function compterVisite(requete, env, cors) {
  if (!cors['Access-Control-Allow-Origin']) return erreur('Origine non autorisée', 403, cors);

  const corps = await requete.json().catch(() => ({}));
  const etape = normaliserEtape(corps.etape);
  if (etape === null) return erreur('Étape inconnue', 400, cors);

  const nouveau = corps.visiteur === true ? 1 : 0;
  const date = dateParisDuJour();

  // `ON CONFLICT` plutôt qu'un SELECT suivi d'un INSERT ou d'un UPDATE : deux
  // lecteurs qui ouvrent la page à la même seconde se seraient sinon écrasés
  // l'un l'autre, et le compteur aurait perdu des visites sans que rien ne le
  // signale.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO visites_jour (date, visiteurs, pages) VALUES (?, ?, 1)
       ON CONFLICT(date) DO UPDATE SET visiteurs = visiteurs + ?, pages = pages + 1`,
    ).bind(date, nouveau, nouveau),
    env.DB.prepare(
      `INSERT INTO visites_etape (etape, pages) VALUES (?, 1)
       ON CONFLICT(etape) DO UPDATE SET pages = pages + 1`,
    ).bind(etape),
  ]);

  return repondre({ compte: true }, { cors });
}

/** Les statistiques de fréquentation, pour la page d'administration. */
async function lireVisites(requete, env, cors) {
  if (!await adminAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  const [parJour, parEtape] = await Promise.all([
    env.DB.prepare('SELECT date, visiteurs, pages FROM visites_jour ORDER BY date ASC').all(),
    env.DB.prepare('SELECT etape, pages FROM visites_etape').all(),
  ]);

  return repondre(
    assemblerStatistiques(
      { jours: parJour.results || [], etapes: parEtape.results || [] },
      { aujourdhui: dateParisDuJour() },
    ),
    { cors },
  );
}

/** Le calendrier prévisionnel des bascules, pour la page d'administration.

    Route à part et non un champ de plus sur `/api/position` : celle-là est
    appelée par le SITE à chaque chargement de page, et quatorze entrées de
    calendrier y pèseraient sur tous les lecteurs pour un tableau que seule la
    modération regarde.

    Vide hors du mode automatique : en manuel, c'est la main qui décide, il n'y
    a rien à prévoir. */
async function lireCalendrier(requete, env, cors, url) {
  if (!await adminAutorise(requete, env)) return erreur('Mot de passe incorrect', 401, cors);

  // Un départ passé en paramètre calcule un calendrier HYPOTHÉTIQUE, sans rien
  // enregistrer : c'est ce qui permet à la page d'administration de montrer ce
  // que la frise dira AVANT qu'on clique sur Enregistrer. Recalculer ces heures
  // côté navigateur aurait voulu dire y recopier la table des fuseaux et le
  // changement d'heure chilien — soit la dérive que le test anti-recopie existe
  // précisément pour empêcher.
  const departDemande = url.searchParams.get('depart');
  if (departDemande) {
    if (!DATE_ISO.test(departDemande)) {
      return erreur('Date de départ attendue au format AAAA-MM-JJ', 400, cors);
    }
    const decalageBrut = Number(url.searchParams.get('decalage') ?? 0);
    // Un décalage absurde ferait sortir les dates de tout calendrier plausible
    // sans rien apprendre à personne ; on garde les bornes du champ de saisie.
    const decalage = Number.isFinite(decalageBrut)
      ? Math.max(-30, Math.min(30, Math.trunc(decalageBrut))) : 0;
    return repondre({
      calendrier: calendrierDesBascules({ depart: departDemande, decalage }),
    }, { cors });
  }

  const { results } = await env.DB
    .prepare('SELECT cle, valeur FROM reglages WHERE cle IN (?, ?, ?)')
    .bind(CLES_POSITION.mode, CLES_POSITION.depart, CLES_POSITION.decalage)
    .all();
  const parCle = new Map((results || []).map((l) => [l.cle, l.valeur]));

  if (parCle.get(CLES_POSITION.mode) !== 'auto') return repondre({ calendrier: [] }, { cors });

  return repondre({
    calendrier: calendrierDesBascules({
      depart: parCle.get(CLES_POSITION.depart) || null,
      decalage: Number(parCle.get(CLES_POSITION.decalage) ?? 0),
    }),
  }, { cors });
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

      const reaction = chemin.match(/^\/api\/contribution\/([0-9a-z]+)\/reaction$/);
      if (reaction && requete.method === 'POST') {
        return await reagir(reaction[1], requete, env, cors);
      }

      const ajout = chemin.match(/^\/api\/contribution\/([0-9a-z]+)\/media$/);
      if (ajout && requete.method === 'POST') {
        return await ajouterMedia(ajout[1], requete, env, cors);
      }

      const unMedia = chemin.match(/^\/api\/media\/([0-9a-z]+)$/);
      if (unMedia && requete.method === 'DELETE') {
        return await supprimerMedia(unMedia[1], requete, env, cors);
      }

      if (chemin === '/api/position') {
        if (requete.method === 'GET') return await lirePosition(env, cors);
        if (requete.method === 'PUT') return await ecrirePosition(requete, env, cors);
      }

      if (chemin === '/api/position/calendrier' && requete.method === 'GET') {
        return await lireCalendrier(requete, env, cors, url);
      }

      if (chemin === '/api/decomptes' && requete.method === 'GET') {
        return await compter(env, cors);
      }

      if (chemin === '/api/tout' && requete.method === 'GET') {
        return await listerTout(requete, env, cors);
      }

      if (chemin === '/api/visite' && requete.method === 'POST') {
        return await compterVisite(requete, env, cors);
      }

      if (chemin === '/api/visites' && requete.method === 'GET') {
        return await lireVisites(requete, env, cors);
      }

      return erreur('Route inconnue', 404, cors);
    } catch (e) {
      // Capture large volontaire : le site doit se dégrader proprement si le
      // service est injoignable. On journalise pour garder l'erreur
      // diagnosticable, et on renvoie un message en français avec les
      // en-têtes CORS déjà calculés, sinon le navigateur ne voit qu'une
      // erreur CORS opaque au lieu du vrai message.
      console.error(e);
      return erreur('Erreur du service, réessaie plus tard', 500, cors);
    }
  },
};
