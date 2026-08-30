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

// Découpée à la main plutôt que passée à `Date` : la chaîne est déjà
// AAAA-MM-JJ, et un `new Date('2026-09-15')` se lit à minuit UTC — de quoi
// afficher la veille chez un lecteur à l'ouest de Greenwich. Il n'y a pas
// d'heure ici, seulement une date : autant ne jamais en fabriquer une.
const dateCourte = (iso) => {
  const [annee, mois, jour] = iso.split('-');
  return `${jour}/${mois}/${annee.slice(2)}`;
};

// Pour les lecteurs d'écran, où « 15/09/26 » s'épellerait chiffre à chiffre.
// Midi UTC, et non minuit : la date reste la même sous tous les fuseaux.
const dateEnToutesLettres = (iso) => {
  const texte = new Date(`${iso}T12:00:00Z`)
    .toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  // Le premier du mois est le seul jour que le français ordonne, et `Intl` ne
  // le sait pas : sans ça une voix de synthèse dirait « un septembre ».
  return texte.replace(/^1 /, '1er ');
};

/** Ce que la flèche annonce : la phrase dessinée, et sa version parlée.

    Quatre moments, dans l'ordre où le voyage les traverse — pas encore partis,
    départ annoncé, en chemin, arrivés. La date courte tient sur la frise, la
    longue se laisse lire à voix haute.

    Les villes viennent de `data/etapes.json` et ne sont plus écrites ici :
    « Salta » et « Cusco » y étaient en dur, dans les descriptions, et un
    itinéraire retouché les aurait laissées mentir sans que rien ne le dise.

    Chacune est facultative. `data/etapes.json` s'édite à la main : une clé
    absente ou renommée ne doit pas produire « Nous sommes à undefined ! » sur
    la page d'accueil. Sans ville, chaque phrase retombe donc sur sa forme
    d'avant — plus vague, mais vraie.

    Exporté pour les tests : quatre branches, des dates et des villes qui
    peuvent manquer, et c'est la seule phrase du site qui change toute seule,
    sans que personne ne la relise. */
/* Les villes du mot, lues dans le contenu éditorial plutôt qu'écrites ici.
   Celle du milieu est l'ARRIVÉE de la journée en cours : la position est au
   bout de l'étape — dire « on en est à J7 » veut dire qu'elle est faite —
   donc c'est la ville où l'on dort ce soir-là, pas celle d'où l'on est parti
   le matin. Les deux bouts se prennent au premier et au dernier jour plutôt
   qu'aux indices 0 et 15 : rien ne garantit que `etapes` soit trié, et une
   étape ajoutée un jour le déferait sans prévenir.

   Extrait de `dessinerFrise` parce que le rafraîchissement de l'heure, à la
   minute, doit refaire exactement le même calcul — deux copies auraient fini
   par se répondre différemment. */
function villesDuMot(etapes, positionJour) {
  const parJour = [...etapes].sort((a, b) => a.jour - b.jour);
  return {
    depart: parJour[0]?.depart?.nom || null,
    arrivee: parJour[parJour.length - 1]?.arrivee?.nom || null,
    courante: parJour.find((e) => e.jour === positionJour)?.arrivee?.nom || null,
  };
}

/** L'heure qu'il est chez les motards — « 7h20 » — ou `null` sans fuseau.

    Passée par `formatToParts` plutôt que par `format` : ce dernier rend
    « 7:20 », avec le séparateur de la locale, et on veut le « h » qu'on
    prononce. Les minutes gardent leur zéro, l'heure n'en prend pas, comme on
    l'écrit à la main.

    Le fuseau est NOMMÉ (`America/Santiago`) et non un décalage : le Chili
    passe à l'heure d'été le premier dimanche de septembre, en plein voyage.
    C'est le navigateur qui sait, pas nous.

    Le `try` couvre un fuseau que le navigateur ne connaîtrait pas : la phrase
    perd son heure plutôt que la frise son mot. */
function heureChezEux(fuseau, maintenant) {
  if (!fuseau) return null;
  try {
    const parties = new Intl.DateTimeFormat('fr-FR', {
      timeZone: fuseau, hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(maintenant);
    const par = Object.fromEntries(parties.map((p) => [p.type, p.value]));
    return par.hour && par.minute ? `${par.hour}h${par.minute}` : null;
  } catch {
    return null;
  }
}

export function motDeLaFrise({
  positionJour, departPrevuLe, arriveeLe, villes = {},
  // Le fuseau vient du service, avec la position. `maintenant` est passé
  // plutôt que pris ici : sans ça, la seule phrase du site qui change toute
  // seule serait aussi la seule qu'on ne saurait pas éprouver.
  fuseau = null, maintenant = new Date(),
}) {
  if (arriveeLe) {
    const ou = villes.arrivee ? ` à ${villes.arrivee}` : '';
    return {
      phrase: `Nous sommes arrivés${ou} le ${dateCourte(arriveeLe)}`,
      heure: null,
      description: `Nous sommes arrivés${ou} le ${dateEnToutesLettres(arriveeLe)}`,
    };
  }
  if (!positionJour && departPrevuLe) {
    // « Départ de Salta le… » plutôt que « Départ prévu le… » : la date seule
    // ne disait pas d'où, alors que la flèche montre justement ce point-là.
    return villes.depart
      ? {
        phrase: `Départ de ${villes.depart} le ${dateCourte(departPrevuLe)} !`,
        heure: null,
        description: `Départ de ${villes.depart} le ${dateEnToutesLettres(departPrevuLe)}`,
      }
      : {
        phrase: `Départ prévu le ${dateCourte(departPrevuLe)} !`,
        heure: null,
        description: `Départ prévu le ${dateEnToutesLettres(departPrevuLe)}`,
      };
  }
  // Personne n'a encore dit où en sont les motos, et aucune date n'est
  // annoncée : la flèche montre alors le kilomètre zéro. « Nous sommes ici ! »
  // y désignait un endroit où le voyage n'a pas commencé — on croyait le raid
  // en cours, à sa première étape. La phrase dit donc l'attente, qui est la
  // seule chose vraie à ce moment-là.
  //
  // Et elle ne nomme aucune ville, à dessein : avant le départ, personne n'est
  // nulle part. « Nous sommes à Salta ! » la veille annoncerait une présence
  // qui n'existe pas — les motards sont encore chez eux, et la flèche montre
  // déjà le point de départ.
  if (!positionJour) {
    return {
      phrase: 'Nous ne sommes pas encore partis !',
      heure: null,
      description: villes.depart
        ? `Nous ne sommes pas encore partis : les motos attendent à ${villes.depart}`
        : 'Nous ne sommes pas encore partis',
    };
  }
  // En chemin. La position est celle du BOUT de la journée — dire « on en est à
  // J7 » veut dire qu'elle est faite — donc la ville est celle où l'on arrive
  // ce soir-là, pas celle d'où l'on est parti le matin.
  //
  // L'heure est celle de LÀ-BAS, pas celle du lecteur : elle dit, d'un coup
  // d'œil depuis la France, s'ils roulent, s'ils dînent ou s'ils dorment. Elle
  // n'apparaît qu'ici, en chemin : avant le départ et après l'arrivée les
  // motards sont chez eux, et « il est… » y afficherait l'heure du lecteur
  // lui-même présentée comme la leur.
  //
  // Sans fuseau — service injoignable, ou pas encore redéployé — chaque phrase
  // retombe exactement sur sa forme d'avant, plutôt qu'un « il est » suivi
  // d'un blanc.
  //
  // L'heure est rendue à part parce qu'elle s'écrit sur une SECONDE LIGNE.
  // Écrite à la suite, la phrase passait de « Nous sommes à Tahua ! » à
  // « Nous sommes à Tahua, il est 20h32 » — une fois et demie plus longue —
  // et débordait de la frise sur un téléphone, où elle se faisait alors
  // effacer par `ajusterMotDeLaFrise`. Sur deux lignes, le mot reprend la
  // largeur qu'il avait toujours eue : c'est la plus longue des deux qui
  // compte, pas leur somme.
  const heure = heureChezEux(fuseau, maintenant);

  if (!villes.courante) {
    return {
      phrase: heure ? 'Nous sommes ici,' : 'Nous sommes ici !',
      heure: heure && `il est ${heure}`,
      description: heure
        ? `Nous sommes ici, il est ${heure} sur place : les motos en sont au jour ${positionJour}`
        : `Nous sommes ici : les motos en sont au jour ${positionJour}`,
    };
  }
  return {
    phrase: heure ? `Nous sommes à ${villes.courante},` : `Nous sommes à ${villes.courante} !`,
    heure: heure && `il est ${heure}`,
    description: heure
      ? `Nous sommes à ${villes.courante}, il est ${heure} sur place, au jour ${positionJour} du voyage`
      : `Nous sommes à ${villes.courante}, au jour ${positionJour} du voyage`,
  };
}

export function dessinerFrise(svg, {
  voyage, etapes, jourActif, surChoixEtape, decomptes = {},
  positionJour = null, departPrevuLe = null, arriveeLe = null, fuseau = null,
  // Survoler une journée la désigne sur la carte sans rien choisir. Facultatif
  // — la frise se dessine aussi bien sans carte en face d'elle.
  surSurvolEtape = () => {}, surSortieEtape = () => {},
}) {
  const largeur = svg.clientWidth || svg.parentElement.clientWidth;
  const hauteur = svg.clientHeight || 100;
  if (!largeur) return;

  // Sans légende d'altitude à loger à gauche, les deux bords se répondent à
  // l'identique : le tracé est centré dans la fenêtre.
  //
  // 20 et non 10 : le repère du jour 1 et son libellé débordent à gauche du
  // tracé sans rien devoir à la marge. À 10, « J1 » serait venu s'inscrire
  // trop près du bord.
  //
  // 32 en haut, et non 14 : cette marge est le ciel où s'écrit « Nous sommes
  // ici ! ». Il lui faut la hauteur du mot, et rien de plus — au-delà, le vide
  // se voit entre le filet de l'entête et le dessin. Le dessin est agrandi
  // d'autant (CSS) pour que le relief garde son amplitude.
  //
  // Sur un écran couché, la frise est raccourcie pour ne pas prendre la moitié
  // de la page (voir `max-height: 30rem` dans la CSS). Le ciel n'y tient plus,
  // et le lui garder écraserait le relief à une vingtaine de points : les deux
  // marges se resserrent donc avec elle, et le tracé retrouve la hauteur qu'il
  // a debout. C'est le mot qui s'efface, pas la montagne.
  const cielRogne = hauteur < 100;
  const marge = {
    haut: cielRogne ? 14 : 32,
    bas: cielRogne ? 20 : 26,
    gauche: 20,
    droite: 20,
  };
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

    // Le survol désigne la journée sur la carte. `pointerenter` plutôt que
    // `pointerover` : la zone n'a pas d'enfants, mais le second se rejouerait
    // à chaque frémissement du curseur à l'intérieur.
    //
    // Le focus fait le même travail que le survol : ces zones sont déjà des
    // boutons au clavier, et le voile qui les souligne répond lui aussi aux
    // deux. Ce serait un tour de clavier pour rien si la carte, elle, ne
    // suivait qu'à la souris.
    zone.addEventListener('pointerenter', () => surSurvolEtape(segment.jour));
    zone.addEventListener('pointerleave', () => surSortieEtape());
    zone.addEventListener('focus', () => surSurvolEtape(segment.jour));
    zone.addEventListener('blur', () => surSortieEtape());

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

  // Où en sont les motos. Le repère de la frise n'est pas une image mais une
  // phrase : « Nous sommes ici ! » et sa flèche, plus bas. Le pictogramme moto,
  // lui, est resté sur la carte, où il a de la place pour se faire voir.
  const releveMotos = releveAuKm(kmDeLaJournee(positionJour, voyage), voyage);

  // Le kilomètre des motos, en unités du viewBox, laissé sur le SVG : c'est là
  // que la vue va chercher où centrer la frise quand aucune journée n'est
  // choisie (`amenerEtapeEnVue`). Le dessin est seul à connaître l'échelle qui
  // mène d'un kilomètre à une abscisse ; la recalculer ailleurs l'aurait
  // dupliquée, et deux copies d'un même calcul finissent toujours par diverger.
  if (releveMotos) svg.dataset.motosX = x(releveMotos.km).toFixed(1);
  else delete svg.dataset.motosX;

  // Les jours sans ride : un point posé sur la crête, cliquable lui aussi.
  for (const etape of etapes.filter((e) => !e.ride)) {
    const km = positionJourSansRide(etape.jour, voyage.segments, voyage.totalKm);
    const releve = voyage.releves.reduce((meilleur, r) =>
      Math.abs(r.km - km) < Math.abs(meilleur.km - km) ? r : meilleur, voyage.releves[0]);

    // Le point fait 9 points de diamètre : c'est un repère, pas une cible.
    // Au doigt, il était le seul endroit de la frise où l'on n'arrivait pas à
    // appuyer — et il commande trois journées sur quinze, J1, J10 et J15.
    //
    // La zone sensible est donc une bande invisible, aussi haute que les
    // journées de ride voisines et large de 20 points, posée par-dessus elles.
    // Elle leur prend dix points de chaque côté : la journée de repos passe de
    // 9 points de large à 20, ses deux voisines en gardent une quinzaine. Un
    // partage plus juste que l'ancien, où l'une était intouchable et les
    // autres confortables. Le point, lui, ne bouge pas d'un pixel et cesse
    // simplement de recevoir les appuis — il n'a jamais été qu'un dessin.
    const cible = creer('rect', {
      class: 'frise__pause-cible',
      x: x(km) - 10, y: marge.haut, width: 20, height: h,
      tabindex: '0', role: 'button', 'aria-label': `Jour ${etape.jour}, ${etape.titre}`,
    });
    cible.addEventListener('click', () => surChoixEtape(etape.jour));
    cible.addEventListener('keydown', (evenement) => {
      if (evenement.key === 'Enter' || evenement.key === ' ') {
        evenement.preventDefault();
        surChoixEtape(etape.jour);
      }
    });
    // Le survol désigne la journée sur la carte, comme pour les rides.
    cible.addEventListener('pointerenter', () => surSurvolEtape(etape.jour));
    cible.addEventListener('pointerleave', () => surSortieEtape());
    cible.addEventListener('focus', () => surSurvolEtape(etape.jour));
    cible.addEventListener('blur', () => surSortieEtape());

    const pastille = creer('circle', {
      class: `frise__pause${etape.jour === jourActif ? ' est-actif' : ''}`,
      cx: x(km), cy: y(releve.altitude), r: 4.5,
    });
    svg.append(cible, pastille);

    let yEtiquette = y(releve.altitude) - 10;
    const etiquette = creer('text', {
      class: `frise__jour${etape.jour === jourActif ? ' est-actif' : ''}`,
      x: x(km), y: yEtiquette,
    });
    etiquette.textContent = `J${etape.jour}`;
    svg.append(etiquette);

    // Sauf si la flèche vient justement se poser sur ce numéro-là : il descend
    // alors sous la pastille et lui laisse la place. Le cas se mesure plutôt
    // qu'il ne se devine — seule une journée de repos perchée assez haut voit
    // son étiquette monter jusqu'au plafond du tracé, là où la flèche s'arrête.
    if (releveMotos && Math.abs(x(km) - x(releveMotos.km)) < 14
        && etiquette.getBBox().y < marge.haut + 1) {
      yEtiquette = y(releve.altitude) + 17;
      etiquette.setAttribute('y', yEtiquette);
    }
    poserDecompte(svg, creer, x(km) + 16, yEtiquette - 3.5, decomptes[etape.jour]);
  }

  // « Nous sommes ici ! » : où en sont les motos, dit d'une voix plutôt que
  // marqué d'un signe. Le mot se range du côté où il reste de la place, et sa
  // flèche va montrer la journée.
  //
  // La hauteur du mot est fixe, dans le ciel, au-dessus de la courbe quelle que
  // soit la journée : posé plus bas il se serait écrit à même le relief,
  // illisible dès que les motos roulent haut. Le calcul tient parce que
  // `altitudeMax` garde 300 m de réserve au-dessus du sommet : la crête ne monte
  // jamais jusqu'à `marge.haut`, et le mot passe dessus.
  // Une condition pour que le mot s'écrive : `!cielRogne`. Sans ciel, il
  // s'écrirait par-dessus la crête, et sa flèche n'aurait plus la place de
  // s'incurver.
  //
  // Qu'il tienne ou non dans la fenêtre est une autre question, et elle ne se
  // tranche pas ici : la frise défile, et c'est seulement une fois qu'elle
  // s'est recentrée sur la journée choisie qu'on sait si le mot est resté en
  // vue. Voir `ajusterMotDeLaFrise`, appelée après ce recentrage.
  if (releveMotos && !cielRogne) {
    const xMotos = x(releveMotos.km);
    const cote = xMotos > largeur / 2 ? -1 : 1;
    const yMot = marge.haut - 12;

    // La flèche part de sous le mot et se pose sur le haut de la barre qui
    // ferme la journée. Ce point-là est le seul que rien n'occupe jamais : le
    // plafond du tracé passe au-dessus de toute la montagne, et au-dessus des
    // numéros posés sur la crête. C'est ce qui la libère : visant les motos
    // elles-mêmes, plus bas sur la courbe, il fallait la faire passer à
    // l'équerre par le ciel pour qu'elle ne traverse pas le relief, et elle se
    // lisait comme un tuyau. Puisque son but est maintenant le plafond, aucun
    // point du trajet ne peut descendre plus bas que lui : elle redevient libre
    // de s'incurver.
    const depart = { x: xMotos + cote * 34, y: yMot + 2 };
    const controle = { x: xMotos + cote * 22, y: yMot - 7 };
    const pointe = { x: xMotos, y: marge.haut };

    // Les deux barbes suivent la tangente d'arrivée — la corde qui va du point
    // de contrôle à la pointe. Écrites en dur elles auraient regardé de travers
    // dès que le mot change de côté.
    const dx = pointe.x - controle.x;
    const dy = pointe.y - controle.y;
    const norme = Math.hypot(dx, dy) || 1;
    const ux = dx / norme;
    const uy = dy / norme;
    const barbe = (angle) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const bx = pointe.x - (ux * cos - uy * sin) * 7;
      const by = pointe.y - (uy * cos + ux * sin) * 7;
      return ` M${pointe.x.toFixed(1)} ${pointe.y.toFixed(1)} L${bx.toFixed(1)} ${by.toFixed(1)}`;
    };

    const fleche = creer('path', {
      class: 'frise__ici-fleche',
      'aria-hidden': 'true',
      d: `M${depart.x.toFixed(1)} ${depart.y.toFixed(1)}`
        + ` Q${controle.x.toFixed(1)} ${controle.y.toFixed(1)} ${pointe.x.toFixed(1)} ${pointe.y.toFixed(1)}`
        + barbe(0.42) + barbe(-0.42),
    });

    // Aux deux bouts du voyage, le mot dit une DATE plutôt qu'un lieu. « Nous
    // sommes ici ! » ne se justifie qu'en chemin : posé au kilomètre zéro avant
    // le départ, il désigne un endroit où personne n'est encore allé ; posé sur
    // Cusco des semaines après, il fait croire à un voyage sans fin. Ce que la
    // flèche montre alors n'est plus une position mais un rendez-vous, passé ou
    // à venir — et c'est la date qui le dit.
    //
    // Le service ne date que ce qu'il sait dater : en position manuelle, ou en
    // cours de route, les deux dates sont nulles et la phrase d'origine
    // reprend la main.
    // Les villes du repère, lues dans le contenu éditorial plutôt qu'écrites
    // ici. Celle du milieu est l'ARRIVÉE de la journée en cours : la position
    // est au bout de l'étape — dire « on en est à J7 » veut dire qu'elle est
    // faite — donc c'est la ville où l'on dort ce soir-là, pas celle d'où l'on
    // est parti le matin. Les deux bouts se prennent au premier et au dernier
    // jour plutôt qu'aux indices 0 et 15 : rien ne garantit que `etapes` soit
    // trié, et une étape ajoutée un jour le déferait sans prévenir.
    const villes = villesDuMot(etapes, positionJour);
    const { phrase, heure, description } = motDeLaFrise({
      positionJour, departPrevuLe, arriveeLe, villes, fuseau,
    });

    // Le mot porte seul l'information, maintenant que le pictogramme a quitté la
    // frise : lu à voix haute, « Nous sommes ici ! » ne dirait pas où. La flèche
    // reste muette, elle ne fait que désigner.
    const mot = creer('text', {
      class: 'frise__ici',
      x: xMotos + cote * 40, y: yMot,
      'text-anchor': cote > 0 ? 'start' : 'end',
      role: 'img',
      'aria-label': description,
    });
    ecrireMot(mot, phrase, heure, xMotos + cote * 40);

    // Le mot et sa flèche voyagent ensemble : ils apparaissent et disparaissent
    // d'un bloc, une flèche seule ne désignant plus rien.
    const groupe = creer('g', { class: 'frise__ici-groupe' });
    groupe.append(mot, fleche);
    svg.append(groupe);
  }
}

/** Montre ou cache « Nous sommes ici ! » selon qu'il tient dans la fenêtre.

    Le mot est ancré au kilomètre des motos, dans une frise deux fois plus large
    que l'écran d'un téléphone. Ouvrir une journée lointaine recentre la frise
    dessus et emmène le mot hors champ : il se lisait alors « sommes ici ! », un
    bout de phrase suspendu au bord de l'écran.

    L'effacer dès qu'une journée est choisie coûtait trop cher : sur un
    téléphone on lit surtout des journées, et la date du départ quittait la
    frise pour tout le voyage. On ne l'efface donc que quand il ne tient
    réellement pas — ce qui n'arrive jamais sur un grand écran, où la frise
    entière est visible, ni sur les journées voisines des motos, les seules où
    l'on regarde encore où elles en sont.

    Appelée après chaque dessin (le recentrage a déjà eu lieu) et à chaque
    défilement de la frise, y compris celui du doigt. */
export function ajusterMotDeLaFrise(svg) {
  const groupe = svg.querySelector('.frise__ici-groupe');
  if (!groupe) return;
  const boite = groupe.getBoundingClientRect();
  const fenetre = svg.parentElement.getBoundingClientRect();
  // Un demi-point de tolérance : les deux boîtes se comparent en pixels
  // fractionnaires, et un mot pile au bord clignoterait d'un dessin à l'autre.
  const tient = boite.left >= fenetre.left - .5 && boite.right <= fenetre.right + .5;
  groupe.classList.toggle('est-hors-champ', !tient);
}

/* Écrit le mot sur une ou deux lignes.

   L'heure va SOUS la phrase, jamais à la suite : mise bout à bout, la ligne
   débordait de la frise sur un téléphone. Sous elle, la largeur du mot reste
   celle de sa plus longue ligne.

   Sous et non au-dessus : le mot est déjà collé au haut du cadre (`yMot` vaut
   `marge.haut - 12`), une ligne de plus par-dessus sortirait du dessin. En
   dessous elle empiète sur le ciel que la frise garde au-dessus des crêtes —
   d'où le liseré de fond que `paint-order: stroke` pose autour des lettres,
   qui les garde lisibles même quand une crête passe derrière. */
function ecrireMot(mot, phrase, heure, x) {
  mot.textContent = '';
  const premiere = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
  premiere.textContent = phrase;
  mot.append(premiere);
  if (!heure) return;

  const seconde = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
  seconde.setAttribute('x', x);
  seconde.setAttribute('dy', '1em');
  seconde.textContent = heure;
  mot.append(seconde);
}

/** Réécrit le mot de la frise sans redessiner la frise.

    Appelée à la minute (et au retour dans l'onglet) pour que l'heure affichée
    reste vraie. Seul le texte est touché : redessiner tout le SVG chaque
    minute aurait coûté un recalcul complet du tracé, et emporté le
    recentrage sur la journée qu'on est en train de lire.

    Sort sans rien faire si la phrase n'a pas bougé, ce qui est le cas de
    presque tous les appels : la minute n'a pas changé, ou l'on n'est pas en
    chemin. Le mot ne clignote donc pas et rien n'est recalculé pour rien. */
export function rafraichirMotDeLaFrise(svg, {
  etapes = [], positionJour = null, departPrevuLe = null, arriveeLe = null, fuseau = null,
}) {
  const mot = svg.querySelector('.frise__ici');
  if (!mot) return false;

  const { phrase, heure, description } = motDeLaFrise({
    positionJour, departPrevuLe, arriveeLe, villes: villesDuMot(etapes, positionJour), fuseau,
  });
  if (mot.textContent === `${phrase}${heure || ''}`) return false;

  ecrireMot(mot, phrase, heure, mot.getAttribute('x'));
  mot.setAttribute('aria-label', description);
  // La phrase a changé de longueur : c'est à l'appelant de rejuger si elle
  // tient encore dans la fenêtre (`ajusterMotDeLaFrise`).
  return true;
}

// -------------------------------------------------------- profil d'une étape

export function dessinerProfilEtape(svg, trace, { surSurvol, surSortie }) {
  const largeur = svg.clientWidth || svg.parentElement.clientWidth || 320;
  const hauteur = svg.clientHeight || 88;
  const profil = trace.properties.profil;

  // Une gouttière à gauche pour les légendes d'altitude, une en bas pour les
  // distances : sans elles le texte se posait à même le relief, illisible dès
  // que la courbe passait dessous. 52 : la largeur de « 4 764 m » dans la
  // police à chasse fixe des légendes, plus de l'air pour que la courbe ne
  // vienne pas non plus la longer de trop près quand un sommet se dresse tôt.
  const marge = { haut: 10, bas: 16, gauche: 52, droite: 6 };
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

  // Un trait tous les 500 m, entre les deux bornes légendées ci-dessous : eux
  // n'ont pas de texte, ils balisent seulement l'échelle entre les deux
  // valeurs qui, elles, sont écrites.
  for (let altitude = Math.ceil(bas / 500) * 500; altitude < haut; altitude += 500) {
    svg.append(creer('line', { class: 'frise__graduation', x1: marge.gauche, x2: largeur - marge.droite, y1: y(altitude), y2: y(altitude) }));
  }

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
