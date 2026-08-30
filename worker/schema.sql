CREATE TABLE IF NOT EXISTS contributions (
  id               TEXT PRIMARY KEY,
  jour             INTEGER NOT NULL,
  auteur           TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('note', 'media')),
  texte            TEXT NOT NULL DEFAULT '',
  media_cle        TEXT,
  media_genre      TEXT,
  media_octets     INTEGER,
  cree_le          TEXT NOT NULL,
  modifie_le       TEXT,
  jeton_hache      TEXT NOT NULL,
  cle_idempotence  TEXT NOT NULL UNIQUE
);

-- Lister une étape sans trier après coup : l'identifiant préfixe l'horodatage,
-- donc l'index suffit. La liste se lit de la plus récente à la plus ancienne
-- (`ORDER BY id DESC`) ; un index se parcourt à l'envers aussi bien qu'à
-- l'endroit, il n'y a donc rien à changer ici.
CREATE INDEX IF NOT EXISTS idx_contributions_jour ON contributions (jour, id);

-- ---------------------------------------------------------------- médias
-- Un souvenir peut porter plusieurs photos et vidéos. Avant cette table,
-- chaque contribution en portait au plus une, dans ses propres colonnes
-- (`media_cle`, `media_genre`, `media_octets`) — conservées telles quelles,
-- désormais inutilisées, pour ne pas réécrire l'historique de la base.
CREATE TABLE IF NOT EXISTS medias (
  id               TEXT PRIMARY KEY,
  contribution_id  TEXT NOT NULL,
  cle              TEXT NOT NULL,
  genre            TEXT NOT NULL CHECK (genre IN ('image', 'video')),
  octets           INTEGER NOT NULL,
  rang             INTEGER NOT NULL DEFAULT 0,
  cree_le          TEXT NOT NULL,
  cle_idempotence  TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_medias_contribution ON medias (contribution_id, rang, id);

-- Reprise des fichiers d'avant la table. `INSERT OR IGNORE` sur une clé
-- d'idempotence dérivée de l'identifiant rend ce script rejouable : l'appliquer
-- deux fois ne crée pas de doublon.
INSERT OR IGNORE INTO medias
  (id, contribution_id, cle, genre, octets, rang, cree_le, cle_idempotence)
SELECT id, id, media_cle, COALESCE(media_genre, 'image'), COALESCE(media_octets, 0),
       0, cree_le, 'reprise:' || id
FROM contributions
WHERE media_cle IS NOT NULL;

-- ---------------------------------------------------------------- réglages
-- Table clé/valeur plutôt qu'une table dédiée : le seul réglage d'aujourd'hui
-- — `position_jour`, la journée où en sont les motos — tiendrait sur une ligne
-- unique, et une table d'une ligne appelle une migration au réglage suivant.
CREATE TABLE IF NOT EXISTS reglages (
  cle     TEXT PRIMARY KEY,
  valeur  TEXT NOT NULL,
  maj_le  TEXT NOT NULL
);

-- ---------------------------------------------------------------- visites
-- Fréquentation du site. Deux compteurs plutôt qu'une ligne par visite : le
-- carnet n'a que faire de l'historique d'une personne, et une table qui grossit
-- d'une ligne à chaque page lue aurait fini par peser plus que les souvenirs
-- eux-mêmes.
--
-- Rien ici n'identifie qui que ce soit : ni adresse IP, ni cookie, ni
-- empreinte. C'est le navigateur qui retient chez lui qu'il a déjà été compté
-- aujourd'hui, et qui n'envoie qu'un « +1 » anonyme.

-- Un jour calendaire (heure de Paris, comme le reste du site) par ligne.
CREATE TABLE IF NOT EXISTS visites_jour (
  date       TEXT PRIMARY KEY,   -- AAAA-MM-JJ
  visiteurs  INTEGER NOT NULL DEFAULT 0,
  pages      INTEGER NOT NULL DEFAULT 0
);

-- Pages vues par journée du voyage ; 0 désigne l'accueil, le parcours entier.
CREATE TABLE IF NOT EXISTS visites_etape (
  etape  INTEGER PRIMARY KEY,    -- 0 à 15
  pages  INTEGER NOT NULL DEFAULT 0
);

-- --------------------------------------------------------------- réactions
-- Les smileys posés sous une note. Un compteur par couple (note, smiley),
-- comme les visites comptent par journée : rien ici ne dit QUI a réagi, ni ne
-- permet de savoir que le même lecteur est revenu. C'est le navigateur qui
-- retient chez lui le smiley qu'il a posé, pour pouvoir le déplacer ou le
-- reprendre.
--
-- Retirer une réaction décrémente le compteur sans supprimer la ligne : le
-- vote suivant n'a ainsi jamais à choisir entre insérer et mettre à jour. Une
-- ligne à zéro reste donc en base ; c'est l'affichage qui l'écarte.
CREATE TABLE IF NOT EXISTS reactions (
  contribution_id  TEXT NOT NULL,
  smiley           TEXT NOT NULL,
  compte           INTEGER NOT NULL DEFAULT 0,
  -- La clé primaire sert aussi d'index de lecture : les réactions se
  -- cherchent toujours par note, qui en est la colonne de tête. Pas d'index
  -- supplémentaire à créer.
  PRIMARY KEY (contribution_id, smiley)
);
