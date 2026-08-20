/* Accès au service des souvenirs.

   Ce module ne touche jamais au DOM : il ne fait que parler au Worker et
   préparer les fichiers. La vue est dans souvenirs-vue.js, la file d'attente
   dans souvenirs-file.js. */

const IMAGE_LARGEUR_MAX = 1600;
const IMAGE_QUALITE = 0.82;
const VIDEO_OCTETS_MAX = 60 * 1024 * 1024;

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
  try {
    const reponse = await fetch('data/config.json');
    config = reponse.ok ? await reponse.json() : { serviceUrl: null };
  } catch {
    config = { serviceUrl: null };
  }
  return config;
}

async function base() {
  const { serviceUrl } = await chargerConfig();
  if (!serviceUrl) throw new ErreurReseau('Service non configuré');
  return serviceUrl.replace(/\/$/, '');
}

export function urlMedia(cle) {
  const racine = config?.serviceUrl?.replace(/\/$/, '') || '';
  return `${racine}/media/${cle}`;
}

export function creerCleIdempotence() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Appelle le service et distingue panne réseau et refus explicite. */
async function appeler(chemin, options = {}) {
  const racine = await base();
  let reponse;
  try {
    reponse = await fetch(`${racine}${chemin}`, options);
  } catch (souci) {
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

export async function envoyerNote({ jour, auteur, texte, motDePasse, idempotence }) {
  return appeler(`/api/etape/${jour}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mot-De-Passe': motDePasse,
      'X-Idempotence': idempotence,
    },
    body: JSON.stringify({ auteur, texte }),
  });
}

export async function envoyerMedia({ jour, auteur, texte, fichier, motDePasse, idempotence }) {
  const formulaire = new FormData();
  formulaire.set('auteur', auteur);
  formulaire.set('texte', texte || '');
  formulaire.set('fichier', fichier, fichier.name || 'souvenir');
  return appeler(`/api/etape/${jour}/media`, {
    method: 'POST',
    headers: { 'X-Mot-De-Passe': motDePasse, 'X-Idempotence': idempotence },
    body: formulaire,
  });
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
