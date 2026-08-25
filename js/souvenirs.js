/* Accès au service des souvenirs.

   Ce module ne touche jamais au DOM : il ne fait que parler au Worker et
   préparer les fichiers. La vue est dans souvenirs-vue.js, la file d'attente
   dans souvenirs-file.js. */

const IMAGE_LARGEUR_MAX = 1600;
const IMAGE_QUALITE = 0.82;
const VIDEO_OCTETS_MAX = 60 * 1024 * 1024;
// Note ou lecture : réponse courte attendue, mieux vaut échouer vite et
// laisser la file d'attente retenter que rester bloqué.
const DELAI_RESEAU_MS = 15 * 1000;
// Envoi de média : une vidéo de plusieurs dizaines de Mo sur un réseau lent
// peut légitimement prendre plusieurs minutes. Un délai aussi court que celui
// des notes ferait échouer tous les envois de vidéos ; il en faut un généreux.
const DELAI_MEDIA_MS = 120 * 1000;

/** Panne réseau ou service indisponible : un renvoi plus tard a du sens. */
export class ErreurReseau extends Error {}

/** Refus explicite du service (mot de passe, fichier trop lourd) : ne pas renvoyer. */
export class ErreurService extends Error {
  constructor(message, statut) {
    super(message);
    this.statut = statut;
  }
}

let config = null;

export async function chargerConfig() {
  if (config) return config;
  let resultat;
  try {
    const reponse = await fetch('data/config.json');
    resultat = reponse.ok ? await reponse.json() : { serviceUrl: null };
  } catch {
    resultat = { serviceUrl: null };
  }
  // On ne mémorise que les chargements réussis. En zone blanche, c'est
  // précisément le tout premier appel qui a des chances d'échouer : si on
  // mettait l'échec en cache, le module resterait persuadé pour le reste de
  // la session qu'il n'y a pas de service, même une fois le réseau revenu.
  // Un échec doit donc laisser le prochain appel retenter, sans écrire dans
  // `config`.
  if (resultat.serviceUrl) config = resultat;
  return resultat;
}

async function base() {
  const { serviceUrl } = await chargerConfig();
  if (!serviceUrl) throw new ErreurReseau('Service non configuré');
  return serviceUrl.replace(/\/$/, '');
}

export function urlMedia(cle) {
  // Reste volontairement synchrone (imposé par ses appelants) : dans le flux
  // réel, on ne peut détenir la clé d'un média sans avoir déjà appelé
  // listerEtape, qui a nécessairement chargé la configuration avant. Cet
  // avertissement rend le cas contraire diagnosticable plutôt que muet.
  if (!config) console.warn('urlMedia appelée avant chargerConfig : URL sans hôte, probablement fausse');
  const racine = config?.serviceUrl?.replace(/\/$/, '') || '';
  return `${racine}/media/${cle}`;
}

export function creerCleIdempotence() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Jeton d'auteur généré par le client, au même endroit que la clé
    d'idempotence (I3, revue finale).

    Le service générait auparavant seul ce jeton et ne le renvoyait qu'à la
    création : une réponse perdue en route (le cas nominal en zone de réseau
    faible) faisait perdre pour toujours, sur le rejeu reconnu par la clé
    d'idempotence, les boutons Modifier/Supprimer du souvenir — pourtant bien
    publié. En le générant ici et en le transmettant au service (qui n'en
    garde que le SHA-256), le rejeu devient indifférent : le client connaît
    déjà son jeton, qu'il lui soit ou non retourné.
    16 octets aléatoires en hexadécimal : même qualité que l'ancien jeton
    généré côté service (`creerJeton` dans `worker/lib/securite.js`). */
export function creerJetonAuteur() {
  const octets = crypto.getRandomValues(new Uint8Array(16));
  return [...octets].map((o) => o.toString(16).padStart(2, '0')).join('');
}

/** Appelle le service et distingue panne réseau et refus explicite.

    `delaiMs` borne l'attente : sur le réseau irrégulier des Andes, une
    requête peut rester pendue sans jamais aboutir ni échouer, ce qui
    bloquerait indéfiniment la file d'attente (tâche 7), qui traite les
    envois un par un sous un verrou. */
async function appeler(chemin, options = {}, delaiMs = DELAI_RESEAU_MS) {
  const racine = await base();
  let reponse;
  try {
    reponse = await fetch(`${racine}${chemin}`, { ...options, signal: AbortSignal.timeout(delaiMs) });
  } catch (souci) {
    // Un délai expiré rejette avec une erreur nommée TimeoutError (ou
    // AbortError) : on la traite comme n'importe quelle panne réseau, pas
    // comme un refus du service, pour qu'un renvoi ultérieur ait un sens.
    throw new ErreurReseau(souci.message);
  }
  // 5xx : le service est mal en point, un renvoi plus tard peut passer.
  if (reponse.status >= 500) throw new ErreurReseau(`Service en erreur (${reponse.status})`);
  const donnees = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    throw new ErreurService(donnees.erreur || `Erreur ${reponse.status}`, reponse.status);
  }
  return donnees;
}

export async function listerEtape(jour) {
  const donnees = await appeler(`/api/etape/${jour}`);
  return donnees.contributions || [];
}

/** Nombre de souvenirs par journée : `{ 3: 7, 9: 2 }`.

    Rend un objet vide plutôt que de lever si le service ne répond pas : les
    pastilles sont un agrément, leur absence ne doit pas empêcher le site de
    s'afficher. */
export async function listerDecomptes() {
  const donnees = await appeler('/api/decomptes');
  return donnees.decomptes || {};
}

export async function envoyerNote({ jour, auteur, texte, motDePasse, idempotence, jeton, avecMedias = false }) {
  const entetes = {
    'Content-Type': 'application/json',
    'X-Mot-De-Passe': motDePasse,
    'X-Idempotence': idempotence,
  };
  // I3 : le jeton client (généré à la mise en file) rend le rejeu indifférent
  // — voir `creerJetonAuteur`. Optionnel pour ne rien casser sur une entrée
  // plus ancienne, mise en file avant ce correctif, qui n'en porterait pas.
  if (jeton) entetes['X-Jeton'] = jeton;
  return appeler(`/api/etape/${jour}`, {
    method: 'POST',
    headers: entetes,
    // `avecMedias` autorise le service à enregistrer un souvenir sans un mot :
    // une série de photos se suffit à elle-même, et les fichiers arrivent
    // ensuite, un par requête.
    body: JSON.stringify({ auteur, texte, avecMedias }),
  });
}

/** Attache un fichier à une contribution déjà créée.

    Une requête par fichier, et non un seul envoi groupé : sur un lien qui
    lâche à mi-course — le régime de croisière attendu du voyage — seul le
    fichier en cours est à recommencer, pas les 200 Mo déjà passés. C'est la
    même route qui sert à compléter un souvenir publié la veille.

    Le mot de passe de groupe n'est pas demandé : c'est le jeton d'auteur qui
    autorise, comme pour modifier ou supprimer. */
export async function envoyerFichier({ contributionId, fichier, idempotence, jeton }) {
  const formulaire = new FormData();
  formulaire.set('fichier', fichier, fichier.name || 'souvenir');
  return appeler(`/api/contribution/${contributionId}/media`, {
    method: 'POST',
    headers: { 'X-Jeton': jeton, 'X-Idempotence': idempotence },
    body: formulaire,
  }, DELAI_MEDIA_MS);
}

export async function supprimerFichier({ idMedia, jeton, motDePasse }) {
  const entetes = {};
  if (jeton) entetes['X-Jeton'] = jeton;
  if (motDePasse) entetes['X-Mot-De-Passe'] = motDePasse;
  return appeler(`/api/media/${idMedia}`, { method: 'DELETE', headers: entetes });
}

export async function envoyerMedia({
  jour, auteur, texte, fichier, motDePasse, idempotence, jeton,
}) {
  const formulaire = new FormData();
  formulaire.set('auteur', auteur);
  formulaire.set('texte', texte || '');
  formulaire.set('fichier', fichier, fichier.name || 'souvenir');
  const entetes = { 'X-Mot-De-Passe': motDePasse, 'X-Idempotence': idempotence };
  if (jeton) entetes['X-Jeton'] = jeton; // I3, même raisonnement que pour envoyerNote
  return appeler(`/api/etape/${jour}/media`, {
    method: 'POST',
    headers: entetes,
    body: formulaire,
  }, DELAI_MEDIA_MS);
}

export async function modifierContribution({ id, texte, jeton }) {
  return appeler(`/api/contribution/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Jeton': jeton },
    body: JSON.stringify({ texte }),
  });
}

export async function supprimerContribution({ id, jeton, motDePasse }) {
  const entetes = {};
  if (jeton) entetes['X-Jeton'] = jeton;
  if (motDePasse) entetes['X-Mot-De-Passe'] = motDePasse;
  await appeler(`/api/contribution/${id}`, { method: 'DELETE', headers: entetes });
}

/** Journée où en sont les motos, `null` si personne ne l'a encore dite.

    Lecture ouverte : c'est ce que les proches viennent voir. */
export async function lirePosition() {
  const donnees = await appeler('/api/position');
  return { jour: donnees.jour ?? null, majLe: donnees.majLe ?? null };
}

/** Réglages complets de la position — mode, date de départ, décalage — en
    plus de la journée déjà calculée. Réservée à la modération : le site
    public n'a besoin que de `lirePosition`, ci-dessus, qui ne garde que
    `jour` et `majLe`. */
export async function lireReglagesPosition() {
  const donnees = await appeler('/api/position');
  return {
    jour: donnees.jour ?? null,
    majLe: donnees.majLe ?? null,
    mode: donnees.mode ?? null,
    depart: donnees.depart ?? null,
    decalage: donnees.decalage ?? 0,
  };
}

/** Dit où en sont les motos.

    `mode: 'manuel'` pose une journée choisie à la main ; `mode: 'auto'` pose
    une date de départ et un décalage, et laisse le service recalculer la
    journée à chaque lecture ; `mode: null` efface tout, retour à « pas
    encore partis ». Réservée à l'administration : la position parle au nom
    du groupe, elle n'est pas une contribution parmi d'autres. */
export async function ecrirePosition({ mode, jour, depart, decalage, motDePasse }) {
  const corps = mode === 'manuel' ? { mode, jour }
    : mode === 'auto' ? { mode, depart, decalage }
    : { mode: null };
  return appeler('/api/position', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Mot-De-Passe': motDePasse },
    body: JSON.stringify(corps),
  });
}

export async function listerTout(motDePasse) {
  const donnees = await appeler('/api/tout', { headers: { 'X-Mot-De-Passe': motDePasse } });
  return donnees.contributions || [];
}

/** Vérifie la taille d'une vidéo avant tout envoi. */
export function verifierVideo(fichier) {
  if (fichier.size <= VIDEO_OCTETS_MAX) return null;
  const mo = Math.round(fichier.size / (1024 * 1024));
  return `Vidéo de ${mo} Mo, maximum 60 Mo. Raccourcissez le clip ou baissez la qualité dans les réglages de la caméra.`;
}

/** Redimensionne et recompresse une photo avant l'envoi.

    Un cliché de téléphone de 4 à 8 Mo tombe à quelques centaines de Ko : c'est
    ce qui rend l'envoi possible avec le réseau des Andes. */
export async function compresserImage(fichier) {
  // imageOrientation respecte l'EXIF : sans cela, les photos prises à la
  // verticale repartiraient couchées.
  const bitmap = await createImageBitmap(fichier, { imageOrientation: 'from-image' });
  const ratio = Math.min(1, IMAGE_LARGEUR_MAX / bitmap.width);
  const toile = document.createElement('canvas');
  toile.width = Math.round(bitmap.width * ratio);
  toile.height = Math.round(bitmap.height * ratio);
  toile.getContext('2d').drawImage(bitmap, 0, 0, toile.width, toile.height);
  bitmap.close();

  const blob = await new Promise((resoudre) => {
    toile.toBlob(resoudre, 'image/jpeg', IMAGE_QUALITE);
  });
  if (!blob) return fichier; // le navigateur a refusé : mieux vaut l'original que rien
  return new File([blob], 'souvenir.jpg', { type: 'image/jpeg' });
}
