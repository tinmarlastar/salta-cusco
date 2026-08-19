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
