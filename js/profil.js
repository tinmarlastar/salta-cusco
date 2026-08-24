/* Profils d'altitude, dessinés en SVG sans bibliothèque.

   La frise du bas est l'élément signature de la page : les quinze jours ne sont
   pas une liste, ils sont posés sur la silhouette réelle du voyage. L'axe
   horizontal suit les distances vraies, si bien que le plateau bolivien à
   4 000 mètres et le plongeon du jour 13 vers l'Amazonie se lisent d'un coup
   d'œil. Un voyage à plat donnerait une frise plate. */

const SVG = 'http://www.w3.org/2000/svg';

const creer = (nom, attributs = {}) => {
  const element = document.createElementNS(SVG, nom);
  for (const [cle, valeur] of Object.entries(attributs)) element.setAttribute(cle, valeur);
  return element;
};

const nombre = (valeur) => valeur.toLocaleString('fr-FR');

/** Enchaîne les profils des étapes de ride en cumulant les distances. */
export function assemblerVoyage(traces) {
  const parJour = new Map(traces.features.map((f) => [f.properties.jour, f]));
  const jours = [...parJour.keys()].sort((a, b) => a - b);

  const releves = [];      // { km, altitude, lat, lon }
  const segments = [];     // { jour, debutKm, finKm }
  let cumul = 0;
  let denivelePositifM = 0;

  for (const jour of jours) {
    const profil = parJour.get(jour).properties.profil;
    const debut = cumul;
    for (const [km, altitude, lat, lon] of profil) {
      releves.push({ km: debut + km, altitude, lat, lon });
    }
    // Le dénivelé se somme À L'INTÉRIEUR d'une étape, jamais d'une étape à la
    // suivante : le voyage comporte des transferts, et la marche entre l'arrivée
    // d'un jour et le départ du lendemain n'a pas été montée à moto. Comptée,
    // elle aurait ajouté des mètres que personne n'a gravis.
    for (let i = 1; i < profil.length; i += 1) {
      denivelePositifM += Math.max(0, profil[i][1] - profil[i - 1][1]);
    }
    cumul = debut + profil[profil.length - 1][0];
    segments.push({ jour, debutKm: debut, finKm: cumul });
  }
  return { releves, segments, totalKm: cumul, denivelePositifM: Math.round(denivelePositifM) };
}

/** Kilomètre où se trouvent les motos quand elles en sont à la journée `jour`.

    Au BOUT de l'étape : dire « on en est à J7 » veut dire qu'elle est faite.
    `null` — personne n'a encore rien dit — les laisse au kilomètre zéro, à
    Salta, où le voyage n'a pas commencé. */
export function kmDeLaJournee(jour, voyage) {
  if (!jour) return 0;
  const segment = voyage.segments.find((s) => s.jour === jour);
  // Une journée sans moto n'a pas de tracé à elle : le compteur y est resté où
  // la veille l'a laissé, ce que sait déjà dire la fonction ci-dessous.
  return segment ? segment.finKm : positionJourSansRide(jour, voyage.segments, voyage.totalKm);
}

/** Relevé du tracé le plus proche d'un kilomètre : sa position et son altitude.

    Le tracé est échantillonné tous les deux kilomètres environ : prendre le
    relevé le plus proche vaut mieux qu'interpoler entre deux points d'une route
    qui, elle, tourne — le point tombe toujours SUR la route. */
export function releveAuKm(km, voyage) {
  if (!voyage.releves.length) return null;
  return voyage.releves.reduce((meilleur, r) =>
    Math.abs(r.km - km) < Math.abs(meilleur.km - km) ? r : meilleur, voyage.releves[0]);
}

/** Position d'un jour sans ride sur l'axe : là où le compteur s'est arrêté. */
function positionJourSansRide(jour, segments, totalKm) {
  const precedent = segments.filter((s) => s.jour < jour).pop();
  if (!precedent) return 0;
  return jour > segments[segments.length - 1].jour ? totalKm : precedent.finKm;
}

// ------------------------------------------------------------------- frise

/** Pastille de décompte posée à côté d'une étiquette de jour.

    La frise est devenue la seule barre de navigation du site : elle doit donc
    porter aussi l'information « il y a quelque chose à voir ici », qui vivait
    jusque-là dans un bandeau séparé. Sans elle, il faudrait ouvrir les
    journées une à une pour le savoir. */
function poserDecompte(svg, creer, x, y, nombre) {
  if (!nombre) return;
  svg.append(creer('circle', { class: 'frise__pastille', cx: x, cy: y, r: 6.5 }));
  const texte = creer('text', { class: 'frise__pastille-texte', x, y: y + 3 });
  texte.textContent = nombre;
  svg.append(texte);
}

export function dessinerFrise(svg, { voyage, etapes, jourActif, surChoixEtape, decomptes = {}, positionJour = null }) {
  const largeur = svg.clientWidth || svg.parentElement.clientWidth;
  const hauteur = svg.clientHeight || 100;
  if (!largeur) return;

  // Sans légende d'altitude à loger à gauche, les deux bords se répondent à
  // l'identique : le tracé est centré dans la fenêtre.
  //
  // 20 et non 10 : le repère du jour 1 et son libellé débordent à gauche du
  // tracé sans rien devoir à la marge. À 10, « J1 » serait venu s'inscrire
  // trop près du bord.
  const marge = { haut: 14, bas: 26, gauche: 20, droite: 20 };
  const l = largeur - marge.gauche - marge.droite;
  const h = hauteur - marge.haut - marge.bas;

  const altitudeMax = Math.max(...voyage.releves.map((r) => r.altitude)) + 300;
  const x = (km) => marge.gauche + (km / voyage.totalKm) * l;
  const y = (altitude) => marge.haut + h - (altitude / altitudeMax) * h;

  svg.setAttribute('viewBox', `0 0 ${largeur} ${hauteur}`);
  svg.replaceChildren();

  // Silhouette du voyage : l'aire d'abord, la crête ensuite.
  const chemin = voyage.releves.map((r, i) => `${i ? 'L' : 'M'}${x(r.km).toFixed(1)} ${y(r.altitude).toFixed(1)}`).join('');
  const base = `L${x(voyage.totalKm).toFixed(1)} ${marge.haut + h} L${marge.gauche} ${marge.haut + h}Z`;
  svg.append(creer('path', { class: 'frise__relief', d: chemin + base }));

  // La crête est tracée par étape, chaque morceau portant le pays où la journée
  // s'achève. Un habillage peut alors colorer le voyage pays par pays ; les
  // autres gardent une seule teinte, et le découpage ne se voit pas.
  //
  // Le pays d'ARRIVÉE, et non celui de départ : c'est là que la journée mène,
  // et c'est ce que dit déjà l'étiquette de la fiche. Les deux journées qui
  // franchissent une frontière sont donc peintes de la couleur du pays où
  // elles finissent — faute d'un point de passage dans les données, on ne peut
  // pas couper le trait à la frontière elle-même.
  let precedent = null;
  for (const segment of voyage.segments) {
    const points = voyage.releves.filter((r) => r.km >= segment.debutKm && r.km <= segment.finKm);
    if (!points.length) continue;
    // On repart du dernier point du morceau précédent : sans lui, un blanc
    // d'un pixel apparaîtrait à chaque jointure.
    const suite = precedent ? [precedent, ...points] : points;
    precedent = points[points.length - 1];

    const etape = etapes.find((e) => e.jour === segment.jour);
    const pays = etape?.pays?.[etape.pays.length - 1] || '';
    svg.append(creer('path', {
      class: 'frise__trace',
      'data-pays': pays,
      d: suite.map((r, i) => `${i ? 'L' : 'M'}${x(r.km).toFixed(1)} ${y(r.altitude).toFixed(1)}`).join(''),
    }));
  }

  // Une zone cliquable par étape de ride, plus son voile de sélection.
  for (const segment of voyage.segments) {
    const gauche = x(segment.debutKm);
    const droite = x(segment.finKm);
    const etape = etapes.find((e) => e.jour === segment.jour);

    const zone = creer('rect', {
      class: 'frise__segment', x: gauche, y: marge.haut, width: Math.max(droite - gauche, 1), height: h,
      tabindex: '0', role: 'button',
      'aria-label': `Jour ${segment.jour}, ${etape ? etape.titre : ''}, ${nombre(etape ? etape.km : 0)} kilomètres`,
    });
    zone.addEventListener('click', () => surChoixEtape(segment.jour));
    zone.addEventListener('keydown', (evenement) => {
      if (evenement.key === 'Enter' || evenement.key === ' ') {
        evenement.preventDefault();
        surChoixEtape(segment.jour);
      }
    });

    const voile = creer('rect', {
      class: `frise__voile${segment.jour === jourActif ? ' est-actif' : ''}`,
      x: gauche, y: marge.haut, width: Math.max(droite - gauche, 1), height: h,
    });

    svg.append(zone, voile);
    svg.append(creer('line', { class: 'frise__separation', x1: droite, x2: droite, y1: marge.haut, y2: marge.haut + h }));

    const etiquette = creer('text', {
      class: `frise__jour${segment.jour === jourActif ? ' est-actif' : ''}`,
      x: (gauche + droite) / 2, y: hauteur - 9,
    });
    etiquette.textContent = `J${segment.jour}`;
    svg.append(etiquette);
    poserDecompte(svg, creer, (gauche + droite) / 2 + 16, hauteur - 12.5, decomptes[segment.jour]);
  }

  // Les jours sans ride : un point posé sur la crête, cliquable lui aussi.
  for (const etape of etapes.filter((e) => !e.ride)) {
    const km = positionJourSansRide(etape.jour, voyage.segments, voyage.totalKm);
    const releve = voyage.releves.reduce((meilleur, r) =>
      Math.abs(r.km - km) < Math.abs(meilleur.km - km) ? r : meilleur, voyage.releves[0]);

    const pastille = creer('circle', {
      class: `frise__pause${etape.jour === jourActif ? ' est-actif' : ''}`,
      cx: x(km), cy: y(releve.altitude), r: 4.5,
      tabindex: '0', role: 'button', 'aria-label': `Jour ${etape.jour}, ${etape.titre}`,
    });
    pastille.addEventListener('click', () => surChoixEtape(etape.jour));
    pastille.addEventListener('keydown', (evenement) => {
      if (evenement.key === 'Enter' || evenement.key === ' ') {
        evenement.preventDefault();
        surChoixEtape(etape.jour);
      }
    });
    svg.append(pastille);

    const etiquette = creer('text', {
      class: `frise__jour${etape.jour === jourActif ? ' est-actif' : ''}`,
      x: x(km), y: y(releve.altitude) - 10,
    });
    etiquette.textContent = `J${etape.jour}`;
    svg.append(etiquette);
    poserDecompte(svg, creer, x(km) + 16, y(releve.altitude) - 13.5, decomptes[etape.jour]);
  }

  // Où en sont les motos, posées sur la crête au bout de la journée dite.
  // Dessinées en dernier pour passer par-dessus les voiles et les séparations,
  // et rendues transparentes au clic (CSS) : elles indiquent, elles ne
  // commandent pas — un clic à cet endroit doit choisir la journée qui est
  // dessous, comme partout ailleurs sur la frise.
  const releveMotos = releveAuKm(kmDeLaJournee(positionJour, voyage), voyage);
  if (releveMotos) {
    const motos = creer('text', {
      class: 'frise__motos',
      x: x(releveMotos.km), y: y(releveMotos.altitude) - 7,
      role: 'img',
      'aria-label': positionJour
        ? `Les motos en sont au jour ${positionJour}`
        : 'Les motos n\'ont pas encore quitté Salta',
    });
    motos.textContent = '\u{1F3CD}\u{FE0F}';
    svg.append(motos);
  }
}

// -------------------------------------------------------- profil d'une étape

export function dessinerProfilEtape(svg, trace, { surSurvol, surSortie }) {
  const largeur = svg.clientWidth || svg.parentElement.clientWidth || 320;
  const hauteur = svg.clientHeight || 88;
  const profil = trace.properties.profil;

  // Une gouttière à gauche pour les légendes d'altitude, une en bas pour les
  // distances : sans elles le texte se posait à même le relief, illisible dès
  // que la courbe passait dessous. 46, la largeur de « 4 764 m » dans la
  // police à chasse fixe des légendes, plus un peu d'air.
  const marge = { haut: 10, bas: 16, gauche: 46, droite: 6 };
  const l = largeur - marge.gauche - marge.droite;
  const h = hauteur - marge.haut - marge.bas;
  const totalKm = profil[profil.length - 1][0];
  const altitudes = profil.map(([, altitude]) => altitude);
  const bas = Math.min(...altitudes);
  const haut = Math.max(...altitudes);
  const amplitude = Math.max(haut - bas, 100);

  const x = (km) => marge.gauche + (km / totalKm) * l;
  const y = (altitude) => marge.haut + h - ((altitude - bas) / amplitude) * h;

  svg.setAttribute('viewBox', `0 0 ${largeur} ${hauteur}`);
  svg.replaceChildren();

  const chemin = profil.map(([km, altitude], i) => `${i ? 'L' : 'M'}${x(km).toFixed(1)} ${y(altitude).toFixed(1)}`).join('');
  const base = `L${x(totalKm).toFixed(1)} ${hauteur - marge.bas} L${marge.gauche} ${hauteur - marge.bas}Z`;
  svg.append(creer('path', { class: 'frise__relief', d: chemin + base }));
  svg.append(creer('path', { class: 'frise__trace', d: chemin }));

  // Légendes de l'axe des ordonnées : les deux bornes du relief du jour, haut
  // et bas, posées dans la gouttière de gauche plutôt que par-dessus le relief.
  svg.append(
    creer('line', { class: 'frise__graduation', x1: marge.gauche, x2: largeur - marge.droite, y1: y(haut), y2: y(haut) }),
    Object.assign(creer('text', { class: 'frise__graduation-texte', x: 2, y: y(haut) + 3 }), { textContent: `${nombre(haut)} m` }),
    creer('line', { class: 'frise__graduation', x1: marge.gauche, x2: largeur - marge.droite, y1: y(bas), y2: y(bas) }),
    Object.assign(creer('text', { class: 'frise__graduation-texte', x: 2, y: y(bas) + 3 }), { textContent: `${nombre(bas)} m` }),
  );

  // Légendes de l'axe des abscisses : la distance du jour, du départ à
  // l'arrivée, alignées sous les deux bouts de la courbe.
  svg.append(
    Object.assign(creer('text', { class: 'frise__graduation-texte', x: marge.gauche, y: hauteur - 3 }), { textContent: '0 km' }),
    Object.assign(creer('text', { class: 'frise__graduation-texte', x: largeur - marge.droite, y: hauteur - 3, 'text-anchor': 'end' }), { textContent: `${Math.round(totalKm)} km` }),
  );

  const repere = creer('line', { class: 'frise__separation', x1: 0, x2: 0, y1: marge.haut, y2: hauteur - marge.bas, opacity: 0 });
  const bulle = creer('text', { class: 'frise__graduation-texte', x: 0, y: marge.haut - 2, fill: '#e8b33c' });
  svg.append(repere, bulle);

  svg.addEventListener('pointermove', (evenement) => {
    const boite = svg.getBoundingClientRect();
    // La souris ne connaît que la boîte CSS : on y repère la fraction du
    // graphique survolée avant de la reconvertir en kilomètres, gouttières
    // déduites — sans quoi le curseur glisserait plus vite que la courbe.
    const fraction = ((evenement.clientX - boite.left) / boite.width) * largeur;
    const km = Math.min(Math.max((fraction - marge.gauche) / l, 0), 1) * totalKm;
    const point = profil.reduce((meilleur, p) =>
      Math.abs(p[0] - km) < Math.abs(meilleur[0] - km) ? p : meilleur, profil[0]);

    repere.setAttribute('x1', x(point[0]));
    repere.setAttribute('x2', x(point[0]));
    repere.setAttribute('opacity', 1);
    bulle.textContent = `${Math.round(point[0])} km · ${nombre(point[1])} m`;
    bulle.setAttribute('x', Math.min(Math.max(x(point[0]) - 34, marge.gauche + 2), largeur - marge.droite - 78));
    surSurvol?.(point[2], point[3]);
  });

  svg.addEventListener('pointerleave', () => {
    repere.setAttribute('opacity', 0);
    bulle.textContent = '';
    surSortie?.();
  });
}
