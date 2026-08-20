/* Identifiants et comparaisons de secrets.

   Ces fonctions sont pures et sans dépendance : elles tournent aussi bien dans
   le Worker que sous `node --test`. */

// Largeur fixe pour que l'horodatage en base 36 se trie comme une chaîne
// jusqu'en l'an 5138. Sans cette largeur constante, « 9 » passerait après « 10 ».
const LARGEUR_TEMPS = 9;

/** Identifiant trié par le temps : horodatage base 36 puis tirage aléatoire. */
export function creerId(maintenant = Date.now()) {
  const temps = maintenant.toString(36).padStart(LARGEUR_TEMPS, '0');
  const alea = crypto.getRandomValues(new Uint8Array(8));
  const suffixe = [...alea].map((octet) => octet.toString(16).padStart(2, '0')).join('');
  return `${temps}${suffixe}`;
}

/** Secret d'auteur, renvoyé une seule fois au créateur d'une contribution. */
export function creerJeton() {
  const alea = crypto.getRandomValues(new Uint8Array(16));
  return [...alea].map((octet) => octet.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hexadécimal : c'est ce qu'on stocke, jamais le jeton en clair. */
export async function hacherJeton(jeton) {
  const donnees = new TextEncoder().encode(jeton);
  const empreinte = await crypto.subtle.digest('SHA-256', donnees);
  return [...new Uint8Array(empreinte)].map((o) => o.toString(16).padStart(2, '0')).join('');
}

/** Comparaison en temps constant : la durée ne doit pas trahir le secret. */
export function memeSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let ecart = 0;
  for (let i = 0; i < ea.length; i += 1) ecart |= ea[i] ^ eb[i];
  return ecart === 0;
}
