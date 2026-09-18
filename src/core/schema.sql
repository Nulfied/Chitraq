-- Chitraq canonical memory schema.
--
-- INVARIANTS ENCODED HERE:
--   * Identity, versioning, timestamps and provenance are deterministic (system-owned).
--   * History is append-only: *_version and event rows are never UPDATEd or DELETEd.
--   * Derived knowledge stays distinguishable from source knowledge (origin, derivation).
--   * AI never writes state directly; it writes `proposal` rows reviewed by the gateway.
--   * Explicit user relationships are never silently overwritten by probabilistic output.

-- ---------------------------------------------------------------- meta

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- ------------------------------------------------------- principals

CREATE TABLE IF NOT EXISTS principal (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('user','team','org','service')),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workspace (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES principal(id),
  created_at TEXT NOT NULL
) STRICT;

-- Deterministic permissions. Never inferred, never model-decided.
CREATE TABLE IF NOT EXISTS grant_entry (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principal(id),
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('workspace','object')),
  scope_id     TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('read','write','admin')),
  created_at   TEXT NOT NULL,
  UNIQUE (principal_id, scope_kind, scope_id)
) STRICT;

-- ------------------------------------------------- knowledge objects

-- Head (current) state of each Knowledge Object. Mutable, but every mutation
-- also appends an immutable object_version row.
CREATE TABLE IF NOT EXISTS object (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  attrs         TEXT NOT NULL DEFAULT '{}',
  epistemic     TEXT NOT NULL DEFAULT 'observation'
                CHECK (epistemic IN ('fact','observation','belief','hypothesis',
                                     'inference','conclusion','speculation')),
  origin        TEXT NOT NULL
                CHECK (origin IN ('user','source','algorithm','ai')),
  confidence    REAL,
  review        TEXT NOT NULL DEFAULT 'unreviewed'
                CHECK (review IN ('unreviewed','confirmed','rejected')),
  state         TEXT NOT NULL DEFAULT 'active'
                CHECK (state IN ('active','archived','superseded','deleted')),
  superseded_by TEXT REFERENCES object(id),
  head_version  INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  valid_from    TEXT,
  valid_until   TEXT,
  occurred_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  salience      REAL NOT NULL DEFAULT 0.0,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_access   TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS ix_object_ws_state ON object (workspace_id, state);
CREATE INDEX IF NOT EXISTS ix_object_kind     ON object (workspace_id, kind, state);
CREATE INDEX IF NOT EXISTS ix_object_created  ON object (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS ix_object_occurred ON object (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_object_hash     ON object (workspace_id, content_hash);
CREATE INDEX IF NOT EXISTS ix_object_origin   ON object (workspace_id, origin, review);

-- Append-only. One row per state the object has ever had.
CREATE TABLE IF NOT EXISTS object_version (
  object_id     TEXT NOT NULL REFERENCES object(id),
  version       INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  attrs         TEXT NOT NULL,
  epistemic     TEXT NOT NULL,
  origin        TEXT NOT NULL,
  confidence    REAL,
  review        TEXT NOT NULL,
  state         TEXT NOT NULL,
  valid_from    TEXT,
  valid_until   TEXT,
  occurred_at   TEXT,
  content_hash  TEXT NOT NULL,
  change_kind   TEXT NOT NULL,
  change_reason TEXT,
  actor         TEXT NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','system','capability')),
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (object_id, version)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_ov_recorded ON object_version (recorded_at);

-- -------------------------------------------------- relationships

CREATE TABLE IF NOT EXISTS relation (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  src_id       TEXT NOT NULL REFERENCES object(id),
  type         TEXT NOT NULL,
  dst_id       TEXT NOT NULL REFERENCES object(id),
  origin       TEXT NOT NULL CHECK (origin IN ('user','source','algorithm','ai')),
  confidence   REAL,
  review       TEXT NOT NULL DEFAULT 'unreviewed'
               CHECK (review IN ('unreviewed','confirmed','rejected')),
  state        TEXT NOT NULL DEFAULT 'active'
               CHECK (state IN ('active','retracted')),
  note         TEXT,
  valid_from   TEXT,
  valid_until  TEXT,
  head_version INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

-- One active edge per (src,type,dst). Retracted edges stay for history.
CREATE UNIQUE INDEX IF NOT EXISTS ux_relation_active
  ON relation (src_id, type, dst_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS ix_relation_src ON relation (src_id, state);
CREATE INDEX IF NOT EXISTS ix_relation_dst ON relation (dst_id, state);
CREATE INDEX IF NOT EXISTS ix_relation_typ ON relation (workspace_id, type, state);

CREATE TABLE IF NOT EXISTS relation_version (
  relation_id   TEXT NOT NULL REFERENCES relation(id),
  version       INTEGER NOT NULL,
  type          TEXT NOT NULL,
  origin        TEXT NOT NULL,
  confidence    REAL,
  review        TEXT NOT NULL,
  state         TEXT NOT NULL,
  note          TEXT,
  valid_from    TEXT,
  valid_until   TEXT,
  change_kind   TEXT NOT NULL,
  change_reason TEXT,
  actor         TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (relation_id, version)
) STRICT;

-- ------------------------------------------------ sources & evidence

-- Verbatim captured material. Never rewritten by interpretation.
CREATE TABLE IF NOT EXISTS source (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  uri          TEXT,
  media_type   TEXT NOT NULL,
  title        TEXT,
  byte_size    INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  text         TEXT,
  blob         BLOB,
  meta         TEXT NOT NULL DEFAULT '{}',
  captured_at  TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('user','source','algorithm','ai'))
) STRICT;

CREATE INDEX IF NOT EXISTS ix_source_hash ON source (workspace_id, content_hash);

-- Evidence ties a claim back to the material that supports it.
CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('object','relation')),
  target_id    TEXT NOT NULL,
  source_id    TEXT REFERENCES source(id),
  object_id    TEXT REFERENCES object(id),
  stance       TEXT NOT NULL DEFAULT 'supports'
               CHECK (stance IN ('supports','contradicts','qualifies','mentions')),
  excerpt      TEXT,
  locator      TEXT NOT NULL DEFAULT '{}',
  weight       REAL NOT NULL DEFAULT 1.0,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_evidence_target ON evidence (target_kind, target_id);
CREATE INDEX IF NOT EXISTS ix_evidence_source ON evidence (source_id);

-- How a specific version of a specific thing came to exist.
CREATE TABLE IF NOT EXISTS derivation (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('object','relation')),
  target_id      TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  method         TEXT NOT NULL,
  capability     TEXT,
  provider       TEXT,
  model          TEXT,
  model_version  TEXT,
  run_id         TEXT,
  inputs         TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_derivation_target ON derivation (target_kind, target_id);

-- ------------------------------------------- the AI/memory boundary

-- Every intelligence invocation is recorded, whether or not it changed anything.
CREATE TABLE IF NOT EXISTS capability_run (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  capability    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT,
  model_version TEXT,
  task          TEXT NOT NULL DEFAULT '{}',
  context_ids   TEXT NOT NULL DEFAULT '[]',
  context_hash  TEXT,
  result        TEXT,
  uncertainty   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok','error','timeout','refused')),
  error         TEXT,
  latency_ms    INTEGER,
  cost_micros   INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS ix_run_cap ON capability_run (workspace_id, capability, started_at);

-- Intelligence proposes here. It cannot write object/relation directly.
CREATE TABLE IF NOT EXISTS proposal (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  run_id       TEXT REFERENCES capability_run(id),
  op           TEXT NOT NULL,
  payload      TEXT NOT NULL,
  rationale    TEXT,
  confidence   REAL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','rejected','invalid','superseded','expired')),
  invalid_why  TEXT,
  applied_kind TEXT,
  applied_id   TEXT,
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  review_note  TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_proposal_status ON proposal (workspace_id, status, created_at);

-- ----------------------------------------------------- conflicts

CREATE TABLE IF NOT EXISTS conflict (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind         TEXT NOT NULL,
  a_kind       TEXT NOT NULL,
  a_id         TEXT NOT NULL,
  b_kind       TEXT,
  b_id         TEXT,
  detail       TEXT NOT NULL DEFAULT '{}',
  detected_by  TEXT NOT NULL,
  confidence   REAL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','resolved','dismissed','acknowledged')),
  resolution   TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS ix_conflict_status ON conflict (workspace_id, status);
CREATE INDEX IF NOT EXISTS ix_conflict_a ON conflict (a_id);

-- ------------------------------------------------ events (audit log)

CREATE TABLE IF NOT EXISTS event (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type         TEXT NOT NULL,
  subject_kind TEXT,
  subject_id   TEXT,
  actor        TEXT NOT NULL,
  actor_kind   TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  at           TEXT NOT NULL,
  seq          INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS ix_event_ws_at   ON event (workspace_id, at);
CREATE INDEX IF NOT EXISTS ix_event_subject ON event (subject_id, at);
CREATE INDEX IF NOT EXISTS ix_event_type    ON event (workspace_id, type, at);

-- --------------------------------------------------- retrieval

CREATE TABLE IF NOT EXISTS chunk (
  id           TEXT PRIMARY KEY,
  object_id    TEXT NOT NULL REFERENCES object(id),
  workspace_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  tokens       INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_chunk_object ON chunk (object_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5 (
  title,
  text,
  chunk_id     UNINDEXED,
  object_id    UNINDEXED,
  workspace_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS embedding (
  chunk_id     TEXT NOT NULL REFERENCES chunk(id),
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  object_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (chunk_id, model)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_embedding_model ON embedding (workspace_id, model);

-- Corpus statistics for deterministic TF-IDF / keyword extraction.
CREATE TABLE IF NOT EXISTS term_stat (
  workspace_id TEXT NOT NULL,
  term         TEXT NOT NULL,
  doc_freq     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, term)
) STRICT;

-- --------------------------------------------- queries & context

CREATE TABLE IF NOT EXISTS query_log (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  text         TEXT NOT NULL,
  intent       TEXT NOT NULL DEFAULT '{}',
  result_ids   TEXT NOT NULL DEFAULT '[]',
  strategy     TEXT,
  latency_ms   INTEGER,
  at           TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS context_build (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  query_id     TEXT,
  question     TEXT NOT NULL,
  strategy     TEXT NOT NULL,
  budget       INTEGER NOT NULL,
  used_tokens  INTEGER NOT NULL,
  items        TEXT NOT NULL,
  conflicts    TEXT NOT NULL DEFAULT '[]',
  at           TEXT NOT NULL
) STRICT;

-- Capability provider registry state (availability, health, user preference).
CREATE TABLE IF NOT EXISTS provider_state (
  id           TEXT PRIMARY KEY,
  capability   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  preference   INTEGER NOT NULL DEFAULT 0,
  last_ok      TEXT,
  last_error   TEXT,
  fail_streak  INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
) STRICT;
