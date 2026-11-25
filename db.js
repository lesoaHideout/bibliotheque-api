const Database = require("better-sqlite3");

const db = new Database(process.env.DB_FILE || "bibliotheque.db");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS livres (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  titre                    TEXT    NOT NULL,
  auteur                   TEXT    NOT NULL,
  isbn                     TEXT    NOT NULL UNIQUE,
  annee                    INTEGER NOT NULL,
  exemplaires_total        INTEGER NOT NULL CHECK (exemplaires_total >= 0),
  exemplaires_disponibles  INTEGER NOT NULL CHECK (exemplaires_disponibles >= 0),
  categorie_id             INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  CHECK (exemplaires_disponibles <= exemplaires_total)
);

CREATE TABLE IF NOT EXISTS membres (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  nom   TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  type  TEXT NOT NULL CHECK (type IN ('etudiant', 'enseignant'))
);

CREATE TABLE IF NOT EXISTS emprunts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  membre_id           INTEGER NOT NULL REFERENCES membres(id) ON DELETE CASCADE,
  livre_id            INTEGER NOT NULL REFERENCES livres(id)  ON DELETE CASCADE,
  date_emprunt        TEXT NOT NULL,
  date_retour_prevue  TEXT NOT NULL,
  date_retour_reelle  TEXT
);

CREATE INDEX IF NOT EXISTS idx_emprunts_membre ON emprunts(membre_id);
CREATE INDEX IF NOT EXISTS idx_emprunts_livre  ON emprunts(livre_id);
`);

module.exports = db;
