-- Make google_id nullable and add apple_id for Sign in with Apple support.
-- SQLite doesn't support ALTER COLUMN, so we recreate the users table.

PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE,
    apple_id TEXT UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO users_new (id, google_id, email, name, created_at)
    SELECT id, google_id, email, name, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

PRAGMA foreign_keys = ON;
