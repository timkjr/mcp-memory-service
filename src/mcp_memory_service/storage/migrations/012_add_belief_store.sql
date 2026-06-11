-- Belief Store: derived knowledge from observations
CREATE TABLE IF NOT EXISTS beliefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    belief_hash TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'candidate',  -- candidate, active, disputed, superseded
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    derived_from TEXT NOT NULL DEFAULT '[]',  -- JSON array of observation content_hashes (provenance)
    contradicted_by TEXT NOT NULL DEFAULT '[]',  -- JSON array of observation content_hashes
    metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_beliefs_status ON beliefs(status);
CREATE INDEX IF NOT EXISTS idx_beliefs_confidence ON beliefs(confidence);
