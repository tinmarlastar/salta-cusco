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

  for (const jour of jours) {
    const profil = parJour.get(jour).properties.profil;
    const debut = cumul;
    for (const [km, altitude, lat, lon] of profil) {
      releves.push({ km: debut + km, altitude, lat, lon });
    }
    cumul = debut + profil[profil.length - 1][0];
    segments.push({ jour, debutKm: debut, finKm: cumul });
  }
  return { releves, segments, totalKm: cumul };
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

export function dessinerFrise(svg, { voyage, etapes, jourActif, surChoixEtape, decomptes = {} }) {
  const largeur = svg.clientWidth || svg.parentElement.clientWidth;
  const hauteur = svg.clientHeight || 100;
  if (!largeur) return;

  const marge = { haut: 14, bas: 26, gauche: 36, droite: 10 };
  const l = largeur - marge.gauche - marge.droite;
  const h = hauteur - marge.haut - marge.bas;

  const altitudeMax = Math.max(...voyage.releves.map((r) => r.altitude)) + 300;
  const x = (km) => marge.gauche + (km / voyage.totalKm) * l;
  const y = (altitude) => marge.haut + h - (altitude / altitudeMax) * h;

  svg.setAttribute('viewBox', `0 0 ${largeur} ${hauteur}`);
  svg.replaceChildren();

  // Graduations d'altitude, tous les 2 000 mètres.
  for (let altitude = 2000; altitude < altitudeMax; altitude += 2000) {
    svg.append(
      creer('line', { class: 'frise__graduation', x1: marge.gauche, x2: largeur - marge.droite, y1: y(altitude), y2: y(altitude) }),
      Object.assign(creer('text', { class: 'frise__graduation-texte', x: 4, y: y(altitude) + 3 }), { textContent: `${nombre(altitude)} m` }),
    );
  }

  // Silhouette du voyage : l'aire d'abord, la crête ensuite.
  const chemin = voyage.releves.map((r, i) => `${i ? 'L' : 'M'}${x(r.km).toFixed(1)} ${y(r.altitude).toFixed(1)}`).join('');
  const base = `L${x(voyage.totalKm).toFixed(1)} ${marge.haut + h} L${marge.gauche} ${marge.haut + h}Z`;
  svg.append(creer('path', { class: 'frise__relief', d: chemin + base }));
  svg.append(creer('path', { class: 'frise__trace', d: chemin }));

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
}

// -------------------------------------------------------- profil d'une étape

export function dessinerProfilEtape(svg, trace, { surSurvol, surSortie }) {
  const largeur = svg.clientWidth || svg.parentElement.clientWidth || 320;
  const hauteur = svg.clientHeight || 88;
  const profil = trace.properties.profil;

  const marge = { haut: 10, bas: 4, gauche: 0, droite: 0 };
  const h = hauteur - marge.haut - marge.bas;
  const totalKm = profil[profil.length - 1][0];
  const altitudes = profil.map(([, altitude]) => altitude);
  const bas = Math.min(...altitudes);
  const haut = Math.max(...altitudes);
  const amplitude = Math.max(haut - bas, 100);

  const x = (km) => (km / totalKm) * largeur;
  const y = (altitude) => marge.haut + h - ((altitude - bas) / amplitude) * h;

  svg.setAttribute('viewBox', `0 0 ${largeur} ${hauteur}`);
  svg.replaceChildren();

  const chemin = profil.map(([km, altitude], i) => `${i ? 'L' : 'M'}${x(km).toFixed(1)} ${y(altitude).toFixed(1)}`).join('');
  svg.append(creer('path', { class: 'frise__relief', d: `${chemin}L${largeur} ${hauteur}L0 ${hauteur}Z` }));
  svg.append(creer('path', { class: 'frise__trace', d: chemin }));

  const repere = creer('line', { class: 'frise__separation', x1: 0, x2: 0, y1: 0, y2: hauteur, opacity: 0 });
  const bulle = creer('text', { class: 'frise__graduation-texte', x: 0, y: 8, fill: '#e8b33c' });
  svg.append(repere, bulle);

  svg.addEventListener('pointermove', (evenement) => {
    const boite = svg.getBoundingClientRect();
    const km = ((evenement.clientX - boite.left) / boite.width) * totalKm;
    const point = profil.reduce((meilleur, p) =>
      Math.abs(p[0] - km) < Math.abs(meilleur[0] - km) ? p : meilleur, profil[0]);

    repere.setAttribute('x1', x(point[0]));
    repere.setAttribute('x2', x(point[0]));
    repere.setAttribute('opacity', 1);
    bulle.textContent = `${Math.round(point[0])} km · ${nombre(point[1])} m`;
    bulle.setAttribute('x', Math.min(Math.max(x(point[0]) - 34, 2), largeur - 78));
    surSurvol?.(point[2], point[3]);
  });

  svg.addEventListener('pointerleave', () => {
    repere.setAttribute('opacity', 0);
    bulle.textContent = '';
    surSortie?.();
  });
}
