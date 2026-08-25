/* Carte Leaflet : fonds, traces, jalons et curseur de profil.
   Aucune clé d'API : les trois fonds sont libres d'accès avec attribution. */

const FONDS = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 18, attribution: 'Imagerie Esri, Maxar, Earthstar Geographics' },
    calque: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  },
  relief: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, attribution: '© OpenTopoMap, © contributeurs OpenStreetMap' },
  },
  plan: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 19, attribution: '© CARTO, © contributeurs OpenStreetMap' },
  },
};

// Vue d'ensemble (aucune étape choisie) : le tracé complet en blanc du sel,
// bien visible sur les trois fonds de carte.
const TRAIT_ENSEMBLE = { color: '#edebe4', weight: 2.5, opacity: .9 };
// Une étape est choisie : les autres jours s'effacent pour la faire ressortir.
const TRAIT_DORMANT = { color: '#8e99ae', weight: 2, opacity: .4 };
const TRAIT_ACTIF = { color: '#e8b33c', weight: 4, opacity: 1 };

export function creerCarte(conteneur, { etapes, traces, surChoixEtape }) {
  const carte = L.map(conteneur, {
    zoomControl: false,
    attributionControl: true,
    // Le parcours est très étiré du sud au nord : un pas de zoom fractionnaire
    // permet de le cadrer sans perdre un demi-écran de marge.
    zoomSnap: .25,
  });
  L.control.zoom({ position: 'topright' }).addTo(carte);

  let fondActuel = null;
  let calqueActuel = null;

  function changerFond(nom) {
    const fond = FONDS[nom] || FONDS.satellite;
    if (fondActuel) carte.removeLayer(fondActuel);
    if (calqueActuel) { carte.removeLayer(calqueActuel); calqueActuel = null; }
    fondActuel = L.tileLayer(fond.url, { ...fond.options, subdomains: 'abc' }).addTo(carte);
    if (fond.calque) {
      calqueActuel = L.tileLayer(fond.calque, { maxZoom: fond.options.maxZoom, opacity: .9 }).addTo(carte);
    }
  }

  // --- Traces ---------------------------------------------------------------

  const lignes = new Map();
  const tout = L.featureGroup().addTo(carte);

  for (const trace of traces.features) {
    const points = trace.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const ligne = L.polyline(points, { ...TRAIT_DORMANT, interactive: true });
    ligne.on('click', () => surChoixEtape(trace.properties.jour));
    ligne.bindTooltip(`J${trace.properties.jour}`, { className: 'infobulle', sticky: true });
    ligne.addTo(tout);
    lignes.set(trace.properties.jour, ligne);
  }

  // --- Jalons ---------------------------------------------------------------

  const jalons = new Map();
  const pointsInteret = L.layerGroup().addTo(carte);

  // Une pastille par LIEU, et non par jour : les journées sans moto se passent
  // là où la veille s'est arrêtée. Elle porte tous les jours qu'elle couvre —
  // « 9-10 » à Copacabana, « 14-15 » à Cusco. Étiquetée du seul premier jour,
  // comme auparavant, les journées de repos n'avaient aucun repère à leur nom
  // sur la carte, y compris quand elles étaient la journée choisie.
  const parLieu = new Map();
  for (const etape of etapes) {
    const { lat, lon, nom } = etape.arrivee;
    const cle = `${lat},${lon}`;
    if (!parLieu.has(cle)) parLieu.set(cle, { lat, lon, nom, jours: [] });
    parLieu.get(cle).jours.push(etape.jour);
  }

  // Indexées aussi par lieu : le survol d'une journée doit retrouver la
  // pastille de son départ comme celle de son arrivée, et le départ d'une
  // journée est l'arrivée de la veille — c'est la même pastille, pas une
  // seconde à poser par-dessus.
  const pastillesParLieu = new Map();

  for (const { lat, lon, nom, jours } of parLieu.values()) {
    const etiquette = jours.join('-');
    const pastille = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: `<div class="jalon">${etiquette}</div>`, iconSize: null }),
      keyboard: true,
      title: jours.length > 1
        ? `Jours ${jours.join(' et ')} — ${nom}`
        : `Jour ${jours[0]} — ${nom}`,
    });
    // Le clic ouvre le premier jour du lieu ; la frise et le pas-à-pas mènent
    // au second, qui est de toute façon le lendemain.
    pastille.on('click', () => surChoixEtape(jours[0]));
    pastille.bindTooltip(nom, { className: 'infobulle', direction: 'top', offset: [0, -12] });
    pastille.addTo(carte);
    pastillesParLieu.set(`${lat},${lon}`, pastille);
    for (const jour of jours) jalons.set(jour, pastille);
  }

  function montrerPoints(etape) {
    pointsInteret.clearLayers();
    if (!etape) return;
    for (const point of etape.points || []) {
      const classes = ['jalon-poi', point.frontiere ? 'est-frontiere' : '', point.option ? 'est-option' : '']
        .filter(Boolean).join(' ');
      L.marker([point.lat, point.lon], {
        icon: L.divIcon({ className: '', html: `<div class="${classes}"></div>`, iconSize: null }),
        title: point.nom,
      })
        .bindTooltip(
          `${point.nom} — ${point.altitudeM.toLocaleString('fr-FR')} m`,
          { className: 'infobulle', direction: 'top', offset: [0, -8] },
        )
        .addTo(pointsInteret);
    }
  }

  // --- Curseur du profil ----------------------------------------------------

  let curseur = null;

  function placerCurseur(lat, lon) {
    if (!curseur) {
      curseur = L.marker([lat, lon], {
        icon: L.divIcon({ className: '', html: '<div class="curseur-profil"></div>', iconSize: null }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 900,
      }).addTo(carte);
    } else {
      curseur.setLatLng([lat, lon]);
    }
  }

  function masquerCurseur() {
    if (curseur) { carte.removeLayer(curseur); curseur = null; }
  }

  // --- Survol depuis la frise -----------------------------------------------

  /* Passer le curseur sur une journée de la frise la montre ici : sa trace
     ressort du parcours, et les deux pastilles qu'elle relie s'allument. Rien
     ne s'ajoute à la carte — ce sont les repères déjà posés qui répondent, le
     survol ne fait que désigner ce qui est là.

     En vue d'ensemble seulement : une journée déjà ouverte a sa trace en
     avant et sa pastille allumée, un second surlignage y ferait deux journées
     actives à la fois. */
  let jourSurvole = null;
  let pastillesAllumees = [];

  function allumerPastille({ lat, lon }) {
    const element = pastillesParLieu.get(`${lat},${lon}`)?.getElement()?.querySelector('.jalon');
    if (!element) return;
    element.classList.add('est-survol');
    pastillesAllumees.push(element);
  }

  function eteindrePastilles() {
    for (const element of pastillesAllumees) element.classList.remove('est-survol');
    pastillesAllumees = [];
  }

  function finSurvol() {
    eteindrePastilles();
    if (jourSurvole === null) return;
    const ligne = lignes.get(jourSurvole);
    if (ligne) ligne.setStyle(etapeCourante ? TRAIT_DORMANT : TRAIT_ENSEMBLE);
    jourSurvole = null;
  }

  function survolerEtape(jour) {
    if (etapeCourante || jour === jourSurvole) return;
    finSurvol();

    const ligne = lignes.get(jour);
    const etape = etapes.find((e) => e.jour === jour);
    if (!ligne || !etape) return;

    jourSurvole = jour;
    ligne.setStyle(TRAIT_ACTIF);
    ligne.bringToFront();
    allumerPastille(etape.depart);
    allumerPastille(etape.arrivee);
  }

  // --- Sélection ------------------------------------------------------------

  let etapeCourante = null;

  function montrerEtape(etape, { recentrer = true } = {}) {
    etapeCourante = etape;

    // Un survol en cours n'a plus lieu d'être : la boucle ci-dessous redonne
    // à chaque trace le style que mérite la nouvelle sélection, il suffit
    // d'oublier le survol sans lui laisser restaurer un style périmé.
    eteindrePastilles();
    jourSurvole = null;
    for (const [jour, ligne] of lignes) {
      const actif = etape && jour === etape.jour;
      ligne.setStyle(actif ? TRAIT_ACTIF : etape ? TRAIT_DORMANT : TRAIT_ENSEMBLE);
      if (actif) ligne.bringToFront();
    }
    // Une pastille peut valoir pour deux jours — « 9-10 » à Copacabana,
    // « 14-15 » à Cusco. La parcourir par JOUR l'allumait puis l'éteignait
    // dans la foulée : à J9, le tour du jour 9 posait la marque et celui du
    // jour 10, sur la même pastille, la retirait. Les deux journées de repos
    // ouvraient donc sur une carte sans repère allumé, et elles seules.
    // C'est l'élément qu'on marque, une fois, d'où le passage par les
    // pastilles distinctes.
    const allumee = etape ? jalons.get(etape.jour)?.getElement()?.querySelector('.jalon') : null;
    for (const pastille of new Set(jalons.values())) {
      const element = pastille.getElement()?.querySelector('.jalon');
      if (element) element.classList.toggle('est-actif', element === allumee);
    }
    montrerPoints(etape);
    masquerCurseur();

    if (!recentrer) return;
    if (!etape) { carte.fitBounds(tout.getBounds(), { padding: [40, 40] }); return; }

    const ligne = lignes.get(etape.jour);
    if (ligne) {
      carte.fitBounds(ligne.getBounds(), { padding: [60, 60], maxZoom: 11 });
    } else {
      carte.setView([etape.arrivee.lat, etape.arrivee.lon], 11);
    }
  }

  function voirTout() {
    carte.fitBounds(tout.getBounds(), { padding: [40, 40] });
  }

  // Le conteneur est dimensionné par la grille de la page : au moment où
  // Leaflet se monte, sa hauteur peut encore valoir zéro, et Leaflet garde
  // cette mesure en cache. Sans invalidateSize, le cadrage part sur une carte
  // de hauteur nulle et se retrouve au zoom maximum.
  function recadrer() {
    carte.invalidateSize({ animate: false });
    montrerEtape(etapeCourante, { recentrer: true });
  }

  changerFond('satellite');
  voirTout();

  let attente;
  new ResizeObserver(() => {
    clearTimeout(attente);
    attente = setTimeout(() => carte.invalidateSize({ animate: false }), 120);
  }).observe(conteneur);

  return {
    carte, changerFond, montrerEtape, voirTout, recadrer,
    placerCurseur, masquerCurseur, survolerEtape, finSurvol,
  };
}
