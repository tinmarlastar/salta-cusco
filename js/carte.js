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

const TRAIT_DORMANT = { color: '#8e99ae', weight: 2, opacity: .55 };
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

  // Une pastille par lieu d'étape. Les jours sans ride partagent le lieu de la
  // veille : on ne pose qu'une pastille, étiquetée par le premier jour concerné.
  const dejaPose = new Map();
  for (const etape of etapes) {
    const { lat, lon, nom } = etape.arrivee;
    const cle = `${lat},${lon}`;
    if (dejaPose.has(cle)) {
      jalons.set(etape.jour, dejaPose.get(cle));
      continue;
    }
    const pastille = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: `<div class="jalon">${etape.jour}</div>`, iconSize: null }),
      keyboard: true,
      title: `Jour ${etape.jour} — ${nom}`,
    });
    pastille.on('click', () => surChoixEtape(etape.jour));
    pastille.bindTooltip(nom, { className: 'infobulle', direction: 'top', offset: [0, -12] });
    pastille.addTo(carte);
    dejaPose.set(cle, pastille);
    jalons.set(etape.jour, pastille);
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

  // --- Sélection ------------------------------------------------------------

  let etapeCourante = null;

  function montrerEtape(etape, { recentrer = true } = {}) {
    etapeCourante = etape;
    for (const [jour, ligne] of lignes) {
      const actif = etape && jour === etape.jour;
      ligne.setStyle(actif ? TRAIT_ACTIF : TRAIT_DORMANT);
      if (actif) ligne.bringToFront();
    }
    for (const [jour, pastille] of jalons) {
      const element = pastille.getElement()?.querySelector('.jalon');
      if (element) element.classList.toggle('est-actif', Boolean(etape) && jour === etape.jour);
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

  return { carte, changerFond, montrerEtape, voirTout, recadrer, placerCurseur, masquerCurseur };
}
