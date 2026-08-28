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
export class ErreurReseau extends Error {
  /* `statut` n'est renseigné que lorsque le SERVICE a répondu — un 5xx avec sa
     phrase à lui. Une panne de transport le laisse indéfini, et c'est tout ce
     qui sépare « les secrets ne sont pas posés » d'un « Failed to fetch » que
     personne ne doit lire. L'appelant qui veut montrer la cause à l'écran
     n'affiche le message que si ce statut existe. */
  constructor(message, statut) {
    super(message);
    this.statut = statut;
  }
}

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
  const donnees = await reponse.json().catch(() => ({}));
  // 5xx : le service est mal en point, un renvoi plus tard peut passer. On lit
  // quand même ce qu'il a dit avant de conclure : « Envoi illisible, réessayez »
  // (multipart tronqué) et « Erreur du service » (exception côté Worker) sont
  // deux pannes très différentes à corriger, et le seul numéro 500 ne les
  // distingue pas. Sans ce message, un envoi qui échoue à chaque fois ne laisse
  // aucune trace exploitable côté participant — c'est précisément le cas qu'on
  // ne savait pas diagnostiquer. Le corps peut n'être pas du JSON du tout (page
  // d'erreur HTML de la plateforme) : `catch` le ramène alors à `{}`.
  if (reponse.status >= 500) {
    throw new ErreurReseau(
      donnees.erreur ? `${donnees.erreur} (${reponse.status})` : `Service en erreur (${reponse.status})`,
      reponse.status,
    );
  }
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

/** Recharge le fichier en mémoire avant de le confier à un `FormData`.

    WebKit — Safari, et donc TOUT navigateur sur iPhone, Chrome compris —
    envoie un corps entièrement vide (`Content-Length: 0`) quand le fichier
    glissé dans un `FormData` a été relu depuis IndexedDB. Or c'est exactement
    ce que fait la file d'attente : elle range le fichier dans IndexedDB à la
    mise en file, puis le ressort à chaque tentative. Le service recevait donc
    un multipart sans contenu, répondait « Envoi illisible » (503, un motif
    renvoyable), et la file recommençait à l'identique — indéfiniment, sur un
    téléphone au réseau parfait.

    Les octets ne sont pas perdus pour autant : seule leur mise en multipart
    les égare. Mesuré contre le service, sur le même fichier de 1,1 Mo relu
    d'IndexedDB : 0 octet reçu via un `FormData`, 1 126 589 une fois le fichier
    reconstruit ici. Le fichier tout juste créé en mémoire, lui, est toujours
    parti entier — d'où un défaut invisible tant qu'on ne testait pas depuis un
    téléphone.

    Le prix est de tenir la photo ou la vidéo en mémoire le temps de l'envoi.
    C'est un fichier à la fois (la file les traite en série), et sans cela rien
    ne part d'un iPhone : le marché est vite conclu. */
async function relireEnMemoire(fichier) {
  const octets = await fichier.arrayBuffer();
  return new File([octets], fichier.name || 'souvenir', { type: fichier.type });
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
  const aEnvoyer = await relireEnMemoire(fichier);
  formulaire.set('fichier', aEnvoyer, aEnvoyer.name);
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
  const aEnvoyer = await relireEnMemoire(fichier);
  formulaire.set('fichier', aEnvoyer, aEnvoyer.name);
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

    Lecture ouverte : c'est ce que les proches viennent voir.

    `departPrevuLe` et `arriveeLe` (dates AAAA-MM-JJ) accompagnent la journée
    aux deux bouts du voyage, et une seule à la fois : la première tant qu'on
    n'est pas partis, la seconde une fois arrivés. Toutes deux `null` en cours
    de route, et en position manuelle où aucun calendrier n'est connu. Les
    réglages qui les produisent — mode, date posée, décalage — restent à la
    modération (`lireReglagesPosition`, ci-dessous) : le site n'affiche que
    des dates déjà calculées. */
export async function lirePosition() {
  const donnees = await appeler('/api/position');
  return {
    jour: donnees.jour ?? null,
    majLe: donnees.majLe ?? null,
    departPrevuLe: donnees.departPrevuLe ?? null,
    arriveeLe: donnees.arriveeLe ?? null,
  };
}

/** Réglages complets de la position — mode, date de départ, décalage, et les
    deux dates annoncées à la main — en plus de la journée déjà calculée.
    Réservée à la modération : le site public n'a besoin que de
    `lirePosition`, ci-dessus, qui ne garde que `jour` et `majLe`.

    `departPrevuPose` et `arriveePosee` sont les dates SAISIES, à distinguer
    des `departPrevuLe`/`arriveeLe` du site public, qui ne valent qu'au
    moment de les annoncer : le formulaire, lui, doit réafficher ce qui a été
    tapé même quand le voyage n'en est pas encore là. */
export async function lireReglagesPosition() {
  const donnees = await appeler('/api/position');
  return {
    jour: donnees.jour ?? null,
    majLe: donnees.majLe ?? null,
    mode: donnees.mode ?? null,
    depart: donnees.depart ?? null,
    decalage: donnees.decalage ?? 0,
    departPrevuPose: donnees.departPrevuPose ?? null,
    arriveePosee: donnees.arriveePosee ?? null,
    departPrevuLe: donnees.departPrevuLe ?? null,
    arriveeLe: donnees.arriveeLe ?? null,
  };
}

/** Dit où en sont les motos.

    `mode: 'manuel'` pose une journée choisie à la main ; `mode: 'auto'` pose
    une date de départ et un décalage, et laisse le service recalculer la
    journée à chaque lecture ; `mode: null` efface la position, retour à « pas
    encore partis ». Réservée à l'administration : la position parle au nom
    du groupe, elle n'est pas une contribution parmi d'autres.

    `departPrevuLe` et `arriveeLe` accompagnent le mode manuel, qui ne
    connaît aucun calendrier : ce sont les dates à annoncer avant J1 et une
    fois J15 atteint. Omises, elles restent telles quelles au service ;
    passées à `null`, elles s'effacent. D'où le `undefined` filtré ici plutôt
    qu'un champ toujours envoyé : ne rien dire et dire « efface » sont deux
    demandes différentes. */
export async function ecrirePosition({
  mode, jour, depart, decalage, departPrevuLe, arriveeLe, motDePasse,
}) {
  let corps;
  if (mode === 'manuel') corps = { mode, jour };
  else if (mode === 'auto') corps = { mode, depart, decalage };
  else if (mode === null) corps = { mode: null };
  else throw new Error(`mode de position inconnu : ${mode}`);
  if (departPrevuLe !== undefined) corps.departPrevuLe = departPrevuLe;
  if (arriveeLe !== undefined) corps.arriveeLe = arriveeLe;
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

/** Le calendrier prévisionnel des bascules, pour la page d'administration.

    Le service rend des instants absolus et des noms de fuseaux ; c'est ici, et
    seulement ici, qu'on les écrit en heure lisible. */
export async function lireCalendrier(motDePasse, { depart = null, decalage = 0 } = {}) {
  // Avec un départ, le service calcule un calendrier hypothétique sans rien
  // enregistrer : c'est ce qui permet de montrer l'effet d'un réglage avant de
  // le poser. Sans, il rend celui du réglage en vigueur.
  const parametres = depart
    ? `?depart=${encodeURIComponent(depart)}&decalage=${encodeURIComponent(decalage)}`
    : '';
  const donnees = await appeler(`/api/position/calendrier${parametres}`, {
    headers: { 'X-Mot-De-Passe': motDePasse },
  });
  return donnees.calendrier || [];
}

/** Signale une page vue au service. Voir `js/visites.js` pour ce qui est
    décidé chez le lecteur, et ce qui n'est délibérément jamais envoyé.

    Le délai est court : un compteur n'a aucune raison de retenir quoi que ce
    soit, et l'appelant ne l'attend pas. */
export async function compterVisite({ etape, visiteur }) {
  return appeler('/api/visite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ etape, visiteur }),
  });
}

/** Les statistiques de fréquentation, pour la page d'administration. */
export async function lireVisites(motDePasse) {
  return appeler('/api/visites', { headers: { 'X-Mot-De-Passe': motDePasse } });
}

/** Les compteurs Cloudflare, pour la page d'administration.

    Rendus tels que le service les calcule : valeurs, plafonds de l'offre
    gratuite et part consommée. Aucun seuil n'est connu de ce côté-ci — les
    forfaits changent, et les avoir en deux endroits aurait garanti qu'un des
    deux finisse périmé.

    Le délai est celui des lectures ordinaires : le service interroge Cloudflare
    de son côté avec sa propre limite, plus courte, et rend un message clair
    plutôt que de laisser la page attendre. */
export async function lireConsommation(motDePasse) {
  return appeler('/api/consommation', { headers: { 'X-Mot-De-Passe': motDePasse } });
}

/** Vérifie la taille d'une vidéo avant tout envoi. */
export function verifierVideo(fichier) {
  if (fichier.size <= VIDEO_OCTETS_MAX) return null;
  const mo = Math.round(fichier.size / (1024 * 1024));
  return `Vidéo de ${mo} Mo, maximum 60 Mo. Raccourcis le clip ou baisse la qualité dans les réglages de la caméra.`;
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
