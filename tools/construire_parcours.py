#!/usr/bin/env python3
"""Construit data/parcours.geojson : une trace par étape, altitude comprise.

Script de construction, exécuté une seule fois. Le site publié n'appelle
aucune API : tout ce que ce script produit est figé sur disque.

    python3 tools/construire_parcours.py           # utilise le cache
    python3 tools/construire_parcours.py --refaire # ignore le cache

Chaque étape est une suite de segments. Un segment « route » est calculé par
OSRM, qui suit le vrai bitume. Un segment « piste » est tracé à la main : là où
le voyage quitte le réseau routier — la piste du Sud Lipez et la traversée du
salar d'Uyuni — OSRM propose un détour de plusieurs dizaines de kilomètres par
la route nationale, ce qui ne ressemble en rien au trajet réel.

Les altitudes viennent d'OpenTopoData (modèle SRTM 90 m) et sont écrites comme
troisième coordonnée de chaque point, ce qui alimente le profil d'altitude.
"""

import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SORTIE = os.path.join(RACINE, "data", "parcours.geojson")
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache-parcours.json")

OSRM = "https://router.project-osrm.org/route/v1/driving/"
ALTITUDES = "https://api.opentopodata.org/v1/srtm90m"
AGENT = {"User-Agent": "salta-cusco-carte/1.0 (projet perso)"}

# Écart maximal toléré lors de la simplification du tracé, en degrés.
# 0.0006° ≈ 65 m : invisible à l'écran, mais divise le poids du fichier par dix.
TOLERANCE = 0.0006
# Distance entre deux points du profil d'altitude, en kilomètres.
PAS_ALTITUDE = 2.0

# --- Points de passage -------------------------------------------------------
# Coordonnées vérifiées par géocodage puis recoupées : le trajet routé entre
# deux étapes doit retomber à environ 10 % du kilométrage annoncé par la
# brochure. Les villes ci-dessous ont dû être corrigées à la main parce que le
# géocodeur renvoyait le centroïde de la province et non la ville.
SALTA = (-24.7859, -65.4117)
HUMAHUACA = (-23.2044, -65.3489)
SUSQUES = (-23.3992, -66.3676)
SAN_PEDRO = (-22.9110, -68.2005)
LAGUNA_COLORADA = (-22.2063, -67.7794)
UYUNI = (-20.4628, -66.8239)
TAHUA = (-19.9800, -67.6200)
ORURO = (-17.9696, -67.1147)
COPACABANA = (-16.1666, -69.0856)
LLACHON = (-15.7229, -69.7839)
MACUSANI = (-14.0572, -70.4570)
QUINCE_MIL = (-13.2308, -70.7543)
CUSCO = (-13.5168, -71.9788)

HITO_CAJON = (-22.8807, -67.7986)
COLCHANI = (-20.3000, -66.9333)
INCAHUASI = (-20.2426, -67.6256)

# Piste du Sud Lipez, du poste frontière bolivien jusqu'au refuge de la Laguna
# Colorada, par les lagunes et les geysers. Tracé à la main faute de route.
PISTE_SUD_LIPEZ = [
    HITO_CAJON,
    (-22.7970, -67.8330),   # Laguna Blanca
    (-22.7830, -67.8180),   # Laguna Verde, au pied du Licancabur
    (-22.7200, -67.7500),
    (-22.6300, -67.6900),   # Desierto de Dalí
    (-22.5300, -67.6600),   # Termas de Polques
    (-22.4300, -67.7500),   # Sol de Mañana
    (-22.3000, -67.8000),
    LAGUNA_COLORADA,
]

# Traversée du salar d'Uyuni. « Ici on roule à la boussole, direction
# Nord-Ouest » : des lignes droites, ce que le réseau routier ne sait pas dire.
PISTE_SALAR = [COLCHANI, INCAHUASI, TAHUA]

ETAPES = [
    {"jour": 2, "km_brochure": 280, "segments": [
        ("route", [SALTA, (-24.1853, -65.2995), (-23.5769, -65.3934),
                   (-23.1974, -65.1935), HUMAHUACA])]},
    {"jour": 3, "km_brochure": 217, "segments": [
        ("route", [HUMAHUACA, (-23.7466, -65.4992), (-23.5964, -65.8823), SUSQUES])]},
    {"jour": 4, "km_brochure": 274, "segments": [
        ("route", [SUSQUES, SAN_PEDRO])]},
    {"jour": 5, "km_brochure": 145, "segments": [
        ("route", [SAN_PEDRO, HITO_CAJON]),
        ("piste", PISTE_SUD_LIPEZ)]},
    {"jour": 6, "km_brochure": 285, "segments": [
        ("route", [LAGUNA_COLORADA, (-22.0517, -67.8829), UYUNI])]},
    {"jour": 7, "km_brochure": 140, "segments": [
        ("route", [UYUNI, COLCHANI]),
        ("piste", PISTE_SALAR)]},
    {"jour": 8, "km_brochure": 305, "segments": [
        ("route", [TAHUA, (-19.8333, -67.6413), (-18.9022, -66.7751), ORURO])]},
    {"jour": 9, "km_brochure": 350, "segments": [
        ("route", [ORURO, COPACABANA])]},
    {"jour": 11, "km_brochure": 240, "segments": [
        ("route", [COPACABANA, (-16.2269, -69.0952), (-16.2959, -69.0960), LLACHON])]},
    {"jour": 12, "km_brochure": 275, "segments": [
        ("route", [LLACHON, MACUSANI])]},
    {"jour": 13, "km_brochure": 225, "segments": [
        ("route", [MACUSANI, QUINCE_MIL])]},
    {"jour": 14, "km_brochure": 300, "segments": [
        ("route", [QUINCE_MIL, (-13.4211, -71.8505), CUSCO])]},
]


# --- Outils géométriques -----------------------------------------------------

def distance_km(a, b):
    """Distance orthodromique entre deux points (lat, lon), en kilomètres."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def longueur_km(points):
    return sum(distance_km(points[i], points[i + 1]) for i in range(len(points) - 1))


def densifier(points, pas_km=1.5):
    """Insère des points intermédiaires pour qu'une piste droite ait du relief.

    Un segment de piste n'est décrit que par ses sommets ; sans cela le profil
    d'altitude d'une traversée de salar de 70 km tiendrait en deux mesures.
    """
    sortie = []
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        n = max(1, int(distance_km(a, b) / pas_km))
        for k in range(n):
            t = k / n
            sortie.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    sortie.append(points[-1])
    return sortie


def simplifier(points, tolerance):
    """Douglas-Peucker : retire les points qui ne changent pas la forme."""
    if len(points) < 3:
        return list(points)

    def ecart(p, a, b):
        if a == b:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        dx, dy = b[1] - a[1], b[0] - a[0]
        n = abs(dx * (a[0] - p[0]) - (a[1] - p[1]) * dy)
        return n / math.hypot(dx, dy)

    garde = [False] * len(points)
    garde[0] = garde[-1] = True
    pile = [(0, len(points) - 1)]
    while pile:
        debut, fin = pile.pop()
        pire, indice = 0.0, None
        for i in range(debut + 1, fin):
            d = ecart(points[i], points[debut], points[fin])
            if d > pire:
                pire, indice = d, i
        if indice is not None and pire > tolerance:
            garde[indice] = True
            pile += [(debut, indice), (indice, fin)]
    return [p for p, g in zip(points, garde) if g]


def construire_profil(points, pas_km):
    """Relève un point tous les `pas_km` le long de la trace.

    Renvoie une liste de (km parcourus depuis le départ, lat, lon). Ce relevé
    sert au profil d'altitude et à placer le curseur sur la carte quand on
    survole le profil ; il est volontairement plus grossier que la géométrie
    affichée, qui doit garder ses virages.
    """
    if len(points) < 2:
        return [(0.0, points[0][0], points[0][1])] if points else []
    profil = [(0.0, points[0][0], points[0][1])]
    total = depuis_dernier = 0.0
    for i in range(1, len(points)):
        d = distance_km(points[i - 1], points[i])
        total += d
        depuis_dernier += d
        if depuis_dernier >= pas_km:
            profil.append((total, points[i][0], points[i][1]))
            depuis_dernier = 0.0
    if profil[-1][0] < total:
        profil.append((total, points[-1][0], points[-1][1]))
    return profil


# --- Appels réseau, avec cache -----------------------------------------------

def charger_cache(refaire):
    if refaire or not os.path.exists(CACHE):
        return {}
    with open(CACHE, encoding="utf-8") as f:
        return json.load(f)


def enregistrer_cache(cache):
    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f)


def router(points, cache):
    """Trace routée par OSRM entre les points donnés.

    Renvoie la liste des (lat, lon) et la distance en kilomètres telle
    qu'OSRM la mesure — sur la géométrie complète, avant toute simplification.
    """
    cle = "route:" + ";".join(f"{la:.5f},{lo:.5f}" for la, lo in points)
    if cle in cache:
        enregistre = cache[cle]
        return [tuple(p) for p in enregistre["trace"]], enregistre["km"]
    url = OSRM + ";".join(f"{lo},{la}" for la, lo in points) \
        + "?overview=full&geometries=geojson"
    with urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=60) as r:
        reponse = json.load(r)
    if not reponse.get("routes"):
        raise RuntimeError(f"OSRM n'a pas trouvé de route : {reponse.get('code')}")
    itineraire = reponse["routes"][0]
    trace = [(lat, lon) for lon, lat in itineraire["geometry"]["coordinates"]]
    km = itineraire["distance"] / 1000
    cache[cle] = {"trace": trace, "km": km}
    time.sleep(0.7)
    return trace, km


def altitudes(points, cache):
    """Altitude en mètres pour chaque point, par lots de 100 (limite du service)."""
    resultat = []
    for debut in range(0, len(points), 100):
        lot = points[debut:debut + 100]
        cle = "alt:" + ";".join(f"{la:.4f},{lo:.4f}" for la, lo in lot)
        if cle in cache:
            resultat += cache[cle]
            continue
        requete = "|".join(f"{la:.5f},{lo:.5f}" for la, lo in lot)
        url = f"{ALTITUDES}?locations={urllib.parse.quote(requete)}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=60) as r:
            reponse = json.load(r)
        valeurs = [p["elevation"] for p in reponse["results"]]
        cache[cle] = valeurs
        resultat += valeurs
        time.sleep(1.1)  # le service public tolère un appel par seconde
    return combler(resultat)


def combler(valeurs):
    """Remplace les trous du modèle d'altitude par une interpolation linéaire."""
    connues = [i for i, v in enumerate(valeurs) if v is not None]
    if not connues:
        return [0.0] * len(valeurs)
    for i, v in enumerate(valeurs):
        if v is not None:
            continue
        avant = max((j for j in connues if j < i), default=None)
        apres = min((j for j in connues if j > i), default=None)
        if avant is None:
            valeurs[i] = valeurs[apres]
        elif apres is None:
            valeurs[i] = valeurs[avant]
        else:
            t = (i - avant) / (apres - avant)
            valeurs[i] = valeurs[avant] + (valeurs[apres] - valeurs[avant]) * t
    return valeurs


# --- Construction ------------------------------------------------------------

def main():
    refaire = "--refaire" in sys.argv
    cache = charger_cache(refaire)
    traces = []

    try:
        for etape in ETAPES:
            points, km, km_piste = [], 0.0, 0.0
            for mode, sommets in etape["segments"]:
                if mode == "route":
                    portion, km_segment = router(sommets, cache)
                else:
                    portion = densifier(sommets)
                    km_segment = longueur_km(portion)
                    km_piste += km_segment
                km += km_segment
                if points and portion and points[-1] == portion[0]:
                    portion = portion[1:]
                points += portion

            # La géométrie affichée garde ses virages ; le profil est relevé
            # sur la trace complète, avant simplification.
            profil = construire_profil(points, PAS_ALTITUDE)
            hauteurs = altitudes([(la, lo) for _, la, lo in profil], cache)
            geometrie = simplifier(points, TOLERANCE)

            ecart = (km - etape["km_brochure"]) / etape["km_brochure"] * 100
            traces.append({
                "type": "Feature",
                "properties": {
                    "jour": etape["jour"],
                    "km_calcule": round(km, 1),
                    "km_brochure": etape["km_brochure"],
                    "km_piste_trace": round(km_piste, 1),
                    "altitude_min_m": round(min(hauteurs)),
                    "altitude_max_m": round(max(hauteurs)),
                    # [km depuis le départ, altitude en m, lat, lon]
                    "profil": [[round(d, 2), round(h), round(la, 5), round(lo, 5)]
                               for (d, la, lo), h in zip(profil, hauteurs)],
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[round(lo, 5), round(la, 5)] for la, lo in geometrie],
                },
            })
            print(f"  J{etape['jour']:<2}  {km:6.1f} km (brochure {etape['km_brochure']}, "
                  f"{ecart:+5.1f} %)  {len(geometrie):4d} pts tracé / "
                  f"{len(profil):3d} pts profil  {round(min(hauteurs))}–{round(max(hauteurs))} m")
    finally:
        enregistrer_cache(cache)

    collection = {
        "type": "FeatureCollection",
        "note": "Tracé construit par tools/construire_parcours.py. "
                "Les altitudes sont la troisième coordonnée de chaque point.",
        "features": traces,
    }
    with open(SORTIE, "w", encoding="utf-8") as f:
        json.dump(collection, f, ensure_ascii=False, separators=(",", ":"))

    total = sum(t["properties"]["km_calcule"] for t in traces)
    print(f"\n{len(traces)} traces, {total:.0f} km au total")
    print(f"écrit dans {SORTIE} ({os.path.getsize(SORTIE) / 1024:.0f} Ko)")


if __name__ == "__main__":
    main()
