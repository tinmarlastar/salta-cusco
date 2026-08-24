/* Service des souvenirs : notes, photos et vidéos postées par les participants.

   Le site reste statique ; seul le bloc « souvenirs » appelle ce service. */

import { creerId, creerJeton, hacherJeton, memeSecret } from './lib/securite.js';

const TEXTE_MAX = 5000; // de quoi raconter une journée entière, pas seulement une légende
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
function versPublic(ligne, medias = []) {
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
  const { results } = await env.DB
    .prepare('SELECT * FROM contributions WHERE jour = ? ORDER BY id ASC')
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

  return repondre({
    contributions: results.map((l) => versPublic(l, parContribution.get(l.id) || [])),
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
          ? `Vidéo trop lourde (maximum ${mo} Mo). Raccourcissez le clip ou baissez la qualité.`
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
    if (!String(souci).includes('cle_idempotence')) throw souci;
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
  if (!formulaire) return erreur('Envoi illisible, réessayez', 503, cors);

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
      contribution: versPublic(ligne, await mediasDe(ligne.id, env)),
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
  if (!formulaire) return erreur('Envoi illisible, réessayez', 503, cors);

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
    { contribution: versPublic({ ...ligne, type: 'media' }, await mediasDe(ligne.id, env)) },
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
    { contribution: versPublic(ligne, await mediasDe(ligne.id, env)) },
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

/** Liste toutes les contributions, pour la page de modération. */
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

      const ajout = chemin.match(/^\/api\/contribution\/([0-9a-z]+)\/media$/);
      if (ajout && requete.method === 'POST') {
        return await ajouterMedia(ajout[1], requete, env, cors);
      }

      const unMedia = chemin.match(/^\/api\/media\/([0-9a-z]+)$/);
      if (unMedia && requete.method === 'DELETE') {
        return await supprimerMedia(unMedia[1], requete, env, cors);
      }

      if (chemin === '/api/decomptes' && requete.method === 'GET') {
        return await compter(env, cors);
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
