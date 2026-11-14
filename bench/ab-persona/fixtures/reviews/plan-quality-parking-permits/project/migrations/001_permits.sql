CREATE TABLE permits (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('residential', 'business')),
  zone TEXT NOT NULL,
  plate TEXT NOT NULL,
  expires_on TEXT NOT NULL
);
