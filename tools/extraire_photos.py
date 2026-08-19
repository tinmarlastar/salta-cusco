#!/usr/bin/env python3
"""Extrait les photos de la brochure PDF et les range dans img/etapes/.

Script de construction, exécuté une seule fois. Le site publié n'en dépend pas.

    python3 tools/extraire_photos.py "chemin/vers/brochure.pdf"

Le PDF répète un même fond de page en JPEG 2000 sur les quinze pages : on
l'écarte au format. Les photos restantes sont identifiées par leur nom interne
(X7, X8, …), stable d'une extraction à l'autre, et renommées selon le tableau
ATTRIBUTION ci-dessous, établi en regardant les images une à une.
"""

import io
import os
import sys

from pypdf import PdfReader
from PIL import Image

# Nom interne dans le PDF -> nom de fichier publié.
ATTRIBUTION = {
    "X1": "hero-salar.jpg",
    "X7": "j01-salta-san-francisco.jpg",
    "X8": "j01-locaux-vintage-rides.jpg",
    "X9": "j02-humahuaca.jpg",
    "X11": "j03-salinas-grandes.jpg",
    "X12": "j04-paso-de-jama.jpg",
    "X3": "j05-lagunes-vue-aerienne.jpg",
    "X14": "j05-laguna-colorada.jpg",
    "X15": "j06-arbol-de-piedra.jpg",
    "X17": "j07-salar-uyuni.jpg",
    "X18": "j08-carnaval-oruro.jpg",
    "X20": "j09-titicaca-nuit.jpg",
    "X21": "j10-coucher-titicaca.jpg",
    "X23": "j11-route-titicaca.jpg",
    "X24": "j11-communaute-llachon.jpg",
    "X27": "j12-altiplano-macusani.jpg",
    "X26": "j13-portes-amazonie.jpg",
    "X29": "j14-cusco.jpg",
    "X40": "j15-machu-picchu.jpg",
    "X31": "hebergement-1.jpg",
    "X32": "hebergement-2.jpg",
    "X33": "hebergement-3.jpg",
    "X34": "hebergement-4.jpg",
    "X35": "hebergement-5.jpg",
    "X36": "hebergement-6.jpg",
}

# X5 est la carte d'itinéraire de la brochure : le site la remplace par la
# vraie carte, on ne la publie pas.
IGNOREES = {"X5"}

LARGEUR_MAX = 1200
QUALITE = 82


def main():
    if len(sys.argv) < 2:
        sys.exit("usage : extraire_photos.py <brochure.pdf>")
    pdf = sys.argv[1]
    racine = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    destination = os.path.join(racine, "img", "etapes")
    os.makedirs(destination, exist_ok=True)

    trouvees, ecrites = set(), 0
    for page in PdfReader(pdf).pages:
        for image in page.images:
            nom, extension = os.path.splitext(image.name)
            if extension.lower() == ".jp2":  # fond de page répété
                continue
            if nom in IGNOREES:
                continue
            if nom not in ATTRIBUTION:
                print(f"  ignorée : {image.name} (non attribuée)")
                continue
            if nom in trouvees:  # le PDF peut référencer deux fois la même image
                continue
            trouvees.add(nom)

            chemin = os.path.join(destination, ATTRIBUTION[nom])
            ecrites += ecrire(image.data, chemin)

    manquantes = set(ATTRIBUTION) - trouvees
    if manquantes:
        print(f"  ATTENTION, introuvables dans le PDF : {sorted(manquantes)}")
    print(f"{ecrites} photo(s) écrite(s) dans {destination}")


def ecrire(donnees, chemin):
    """Recompresse une photo pour le web et l'écrit sur disque."""

    photo = Image.open(io.BytesIO(donnees)).convert("RGB")
    if photo.width > LARGEUR_MAX:
        hauteur = round(photo.height * LARGEUR_MAX / photo.width)
        photo = photo.resize((LARGEUR_MAX, hauteur), Image.LANCZOS)
    photo.save(chemin, "JPEG", quality=QUALITE, optimize=True, progressive=True)
    print(f"  {os.path.basename(chemin)}  {photo.width}×{photo.height}")
    return 1


if __name__ == "__main__":
    main()
