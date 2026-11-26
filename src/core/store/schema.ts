/** Ordered migrations; `PRAGMA user_version` records how many have been applied. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE analyses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    repo           TEXT NOT NULL,
    pr             INTEGER NOT NULL,
    head_sha       TEXT NOT NULL,
    diff_hash      TEXT NOT NULL,
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    json           TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (repo, pr, head_sha, diff_hash, provider, model, prompt_version)
  );

  CREATE TABLE drafts (
    id         TEXT PRIMARY KEY,
    repo       TEXT NOT NULL,
    pr         INTEGER NOT NULL,
    path       TEXT NOT NULL,
    side       TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
    line       INTEGER NOT NULL,
    start_line INTEGER,
    start_side TEXT CHECK (start_side IN ('LEFT', 'RIGHT')),
    body       TEXT NOT NULL,
    hunk_id    TEXT,
    head_sha   TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX drafts_by_pr ON drafts (repo, pr);

  CREATE TABLE reviewed_hunks (
    repo        TEXT NOT NULL,
    pr          INTEGER NOT NULL,
    hunk_id     TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    head_sha    TEXT NOT NULL,
    PRIMARY KEY (repo, pr, hunk_id)
  );

  CREATE TABLE verify_checks (
    repo        TEXT NOT NULL,
    pr          INTEGER NOT NULL,
    group_key   TEXT NOT NULL,
    item_index  INTEGER NOT NULL,
    checked     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, pr, group_key, item_index)
  );

  CREATE TABLE reviews_submitted (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    repo             TEXT NOT NULL,
    pr               INTEGER NOT NULL,
    head_sha         TEXT NOT NULL,
    github_review_id INTEGER,
    event            TEXT NOT NULL,
    submitted_at     TEXT NOT NULL
  );
  `,
  // Monotonic per-draft counter: updated_at is millisecond-resolution, so two saves can tie.
  `ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;`,
  // M3: re-anchoring. `outdated` drafts no longer map onto the diff; the anchor records
  // where the commented line sat inside its hunk (index into hunk.lines) and its text.
  `
  ALTER TABLE drafts ADD COLUMN outdated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE drafts ADD COLUMN anchor_index INTEGER;
  ALTER TABLE drafts ADD COLUMN anchor_start_index INTEGER;
  ALTER TABLE drafts ADD COLUMN anchor_text TEXT;
  `,
  // Re-review baseline: "Done reviewing these changes" records the head the reviewer is caught up to.
  `
  CREATE TABLE review_checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo       TEXT NOT NULL,
    pr         INTEGER NOT NULL,
    head_sha   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX review_checkpoints_by_pr ON review_checkpoints (repo, pr);
  `,
  // Repository keys are lowercase (GitHub names are case-insensitive). Rows written under
  // another spelling are folded in; where the lowercase row already exists it wins, and the
  // duplicate (a reviewed mark, checklist tick or cached analysis for the same thing) is dropped.
  `
  UPDATE drafts SET repo = lower(repo);
  UPDATE reviews_submitted SET repo = lower(repo);
  UPDATE review_checkpoints SET repo = lower(repo);
  UPDATE OR IGNORE reviewed_hunks SET repo = lower(repo);
  DELETE FROM reviewed_hunks WHERE repo <> lower(repo);
  UPDATE OR IGNORE verify_checks SET repo = lower(repo);
  DELETE FROM verify_checks WHERE repo <> lower(repo);
  UPDATE OR IGNORE analyses SET repo = lower(repo);
  DELETE FROM analyses WHERE repo <> lower(repo);
  `,
  // Phase 2: runs live in the database (shared by the CLI and the server). Nothing writes
  // here yet; see src/core/store/runs.ts.
  `
  CREATE TABLE projects (
    id           TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    repo         TEXT NOT NULL,
    local_path   TEXT NOT NULL UNIQUE,
    default_base TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE runs (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects (id),
    title            TEXT NOT NULL,
    stage            TEXT NOT NULL,
    stage_note       TEXT,
    branch           TEXT NOT NULL,
    worktree_path    TEXT NOT NULL,
    run_dir          TEXT NOT NULL,
    base_ref         TEXT NOT NULL,
    base_sha         TEXT NOT NULL,
    head_sha         TEXT,
    pr_number        INTEGER,
    plan_path        TEXT NOT NULL,
    plan_hash        TEXT NOT NULL,
    implementer_json TEXT,
    rounds_json      TEXT NOT NULL,
    owner_pid        INTEGER,
    owner_host       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX runs_by_stage ON runs (stage);
  CREATE INDEX runs_by_updated ON runs (updated_at);

  CREATE TABLE stages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs (id),
    kind        TEXT NOT NULL,
    round       INTEGER NOT NULL,
    state       TEXT NOT NULL
                CHECK (state IN ('running', 'succeeded', 'failed', 'blocked', 'cancelled')),
    input_json  TEXT,
    output_json TEXT,
    started_at  TEXT NOT NULL,
    ended_at    TEXT
  );
  CREATE INDEX stages_by_run ON stages (run_id);

  CREATE TABLE run_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL REFERENCES runs (id),
    stage_id     INTEGER REFERENCES stages (id),
    ts           TEXT NOT NULL,
    type         TEXT NOT NULL,
    payload_json TEXT
  );
  CREATE INDEX run_events_by_run ON run_events (run_id, id);

  CREATE TABLE decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs (id),
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    attach      TEXT,
    created_at  TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX decisions_by_status ON decisions (status, created_at);
  `,
  `
  -- Answerable decisions: options, the answer and when it came. SQLite cannot change a CHECK
  -- constraint in place, so the table is rebuilt (with the new columns) to allow 'answered'.
  CREATE TABLE decisions_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL REFERENCES runs (id),
    kind         TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('open', 'answered', 'resolved', 'dismissed')),
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    attach       TEXT,
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    options_json TEXT,
    answer_json  TEXT,
    answered_at  TEXT
  );
  INSERT INTO decisions_new
    (id, run_id, kind, status, title, body, attach, created_at, resolved_at,
     options_json, answer_json, answered_at)
  SELECT id, run_id, kind, status, title, body, attach, created_at, resolved_at,
     NULL, NULL, NULL
  FROM decisions;
  DROP TABLE decisions;
  ALTER TABLE decisions_new RENAME TO decisions;
  CREATE INDEX decisions_by_status ON decisions (status, created_at);
  `,
];
