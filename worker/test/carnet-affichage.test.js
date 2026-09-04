/* Les notes s'affichent-elles comme leurs auteurs les ont tapées ?

   Ce fichier ne teste pas le service : il garde une propriété du site, sur le
   modèle de `fuseaux.test.js` qui compare déjà la table des fuseaux à
   `data/etapes.json`. Il vit ici parce que `worker/test/` est la seule suite du
   dépôt, pas parce qu'il regarde le worker.

   Ce qu'il surveille : une note est écrite au pouce, le soir, sur un téléphone,
   et les retours à la ligne qu'on y met portent du sens — « voilà ce qu'on a
   fait / voilà ce qui s'est passé / rendez-vous demain ». Le texte traverse
   correctement le service, la base et le DOM ; c'est le CSS qui décide, tout à
   la fin, s'il reste lisible ou s'il se ramasse en un seul bloc. Une règle
   `white-space` retirée par mégarde ne casserait aucun test, n'émettrait aucune
   erreur, et personne ne le verrait avant qu'un motard ne s'en plaigne. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const feuille = readFileSync(new URL('../../css/style.css', import.meta.url), 'utf8');

/** La valeur retenue pour une propriété donnée, cascade comprise.

    Le sélecteur apparaît dans plusieurs règles — `.souvenir__texte` est aussi
    dans la ligne groupée qui pose `max-width` avec le récit et le titre —, et
    toutes ont la même spécificité. C'est donc la DERNIÈRE déclaration du
    fichier qui gagne : chercher la première règle venue donnerait une réponse
    fausse, et un test qui se trompe de règle est pire que pas de test. */
function valeurRetenue(selecteur, propriete) {
  const regles = feuille.split('}');
  let valeur = null;
  let vue = false;
  for (const regle of regles) {
    const [tete, corps] = regle.split('{');
    if (corps === undefined) continue;
    if (!tete.split(',').some((s) => s.trim().endsWith(selecteur))) continue;
    vue = true;
    const trouve = corps.match(new RegExp(`${propriete}:\\s*([a-z-]+)`));
    if (trouve) valeur = trouve[1];
  }
  return { vue, valeur };
}

test('le texte des notes garde les retours à la ligne de son auteur', () => {
  const { vue, valeur } = valeurRetenue('.souvenir__texte', 'white-space');
  assert.ok(vue, 'aucune règle .souvenir__texte dans css/style.css');
  assert.ok(valeur, '.souvenir__texte ne déclare pas de white-space : les sauts '
    + 'de ligne des notes seront écrasés en espaces');
  // Les trois valeurs qui préservent les sauts de ligne tout en laissant le
  // texte se replier dans la colonne. `pre` est exclu : il ne replie pas, et
  // une note un peu longue déborderait du panneau.
  assert.ok(['pre-line', 'pre-wrap', 'break-spaces'].includes(valeur),
    `white-space: ${valeur} écrase les retours à la ligne des notes`);
});
