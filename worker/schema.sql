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

-- Lister une étape dans l'ordre chronologique sans trier après coup :
-- l'identifiant préfixe l'horodatage, donc l'index suffit.
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
