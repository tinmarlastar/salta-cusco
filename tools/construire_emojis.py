#!/usr/bin/env python3
"""Construit js/vendor/emojis.js : la liste des emoji, rangée par onglets.

Script de construction, exécuté une seule fois. Comme pour le tracé, le site
publié n'appelle aucune API : la liste est figée sur disque et embarquée.

    python3 tools/construire_emojis.py

La source est le fichier officiel d'Unicode (`emoji-test.txt`), celui-là même
qui sert à valider les claviers d'emoji des systèmes d'exploitation. Le
sélecteur du carnet montre donc exactement ce que montre un téléphone, dans
les mêmes neuf familles et le même ordre.

Le fichier produit sert deux fois :
  - au site, pour peindre le sélecteur ;
  - au service, comme liste d'autorisation — la route des réactions est
    publique, et ce qu'elle écrit en base doit être borné avant d'y arriver.
Un seul fichier généré pour les deux, plutôt qu'une liste recopiée à la main de
chaque côté : recopiée, elle aurait fini par diverger, et une divergence ici
veut dire un emoji que le site propose et que le service refuse.
"""

import os
import re
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SORTIE = os.path.join(RACINE, "js", "vendor", "emojis.js")
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache-emoji-test.txt")

SOURCE = "https://unicode.org/Public/emoji/16.0/emoji-test.txt"
AGENT = {"User-Agent": "salta-cusco-carte/1.0 (projet perso)"}

# Les neuf familles d'Unicode, dans leur ordre d'origine — celui des onglets
# d'un clavier de téléphone. Le nom français est celui de l'onglet ; la
# vignette est l'emoji qui le représente, choisi parmi les plus reconnaissables
# de la famille plutôt que par sa position dans la liste.
FAMILLES = {
    "Smileys & Emotion": ("Émotions", "😀"),
    "People & Body": ("Personnes", "👋"),
    "Animals & Nature": ("Animaux", "🐻"),
    "Food & Drink": ("Nourriture", "🍎"),
    "Travel & Places": ("Voyages", "🏍️"),
    "Activities": ("Activités", "⚽"),
    "Objects": ("Objets", "💡"),
    "Symbols": ("Symboles", "❤️"),
    "Flags": ("Drapeaux", "🏁"),
}

# La famille « Component » du fichier source (tons de peau isolés, cheveux)
# n'est pas faite pour être posée seule : un clavier ne la montre pas non plus.
IGNOREES = {"Component"}

LIGNE = re.compile(r"^([0-9A-F ]+);\s*(\S+)\s*#\s*(\S+)\s+E[\d.]+\s+(.+)$")


def telecharger():
    """Le fichier d'Unicode, depuis le cache s'il a déjà été pris une fois."""
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            return f.read()
    requete = urllib.request.Request(SOURCE, headers=AGENT)
    with urllib.request.urlopen(requete, timeout=60) as reponse:
        texte = reponse.read().decode("utf-8")
    with open(CACHE, "w", encoding="utf-8") as f:
        f.write(texte)
    return texte


def analyser(texte):
    """Les emoji retenus, rangés par famille et dans l'ordre du fichier."""
    par_famille = {nom: [] for nom in FAMILLES}
    famille = None
    ignores_ton = 0

    for ligne in texte.splitlines():
        if ligne.startswith("# group:"):
            famille = ligne.split(":", 1)[1].strip()
            continue
        if not ligne or ligne.startswith("#"):
            continue
        if famille in IGNOREES or famille not in FAMILLES:
            continue

        trouve = LIGNE.match(ligne)
        if not trouve:
            continue
        _, statut, emoji, nom = trouve.groups()

        # « fully-qualified » seulement : les formes minimales sont les mêmes
        # emoji privés du sélecteur de variante, et s'afficheraient en noir et
        # blanc sur une partie des appareils.
        if statut != "fully-qualified":
            continue

        # Les variantes de teinte multiplient la liste par cinq sans rien
        # ajouter au vocabulaire : « pouce levé » et « pouce levé teinte
        # claire » disent la même chose. On garde la forme jaune, celle que le
        # clavier propose avant qu'on choisisse une teinte.
        if "skin tone" in nom:
            ignores_ton += 1
            continue

        par_famille[famille].append(emoji)

    return par_famille, ignores_ton


def echapper(emoji):
    """Un emoji en littéral JavaScript, entre apostrophes."""
    return "'" + emoji.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main():
    par_famille, ignores_ton = analyser(telecharger())

    blocs = []
    for source, (nom, vignette) in FAMILLES.items():
        emojis = par_famille[source]
        if not emojis:
            raise SystemExit(f"famille vide : {source} — le format de la source a changé ?")
        liste = ",".join(echapper(e) for e in emojis)
        blocs.append(
            f"  {{\n"
            f"    nom: {echapper(nom)},\n"
            f"    vignette: {echapper(vignette)},\n"
            f"    emojis: [{liste}],\n"
            f"  }},"
        )

    contenu = (
        "/* Liste des emoji, rangée par famille — engendrée par\n"
        "   tools/construire_emojis.py depuis le fichier officiel d'Unicode.\n"
        "   Ne pas modifier à la main : la prochaine exécution du script\n"
        "   effacerait la retouche.\n\n"
        f"   Source : {SOURCE}\n\n"
        "   Deux lecteurs : le sélecteur du carnet (js/emojis-vue.js), qui la\n"
        "   peint, et le service (worker/lib/reactions.js), qui s'en sert de\n"
        "   liste d'autorisation. */\n\n"
        "export const GROUPES = [\n" + "\n".join(blocs) + "\n];\n"
    )

    with open(SORTIE, "w", encoding="utf-8") as f:
        f.write(contenu)

    total = sum(len(v) for v in par_famille.values())
    for source, (nom, _) in FAMILLES.items():
        print(f"  {nom:<12} {len(par_famille[source]):5d}")
    print(f"\n{total} emoji ({ignores_ton} variantes de teinte écartées)")
    print(f"écrit dans {SORTIE} ({os.path.getsize(SORTIE) / 1024:.0f} Ko)")


if __name__ == "__main__":
    main()
