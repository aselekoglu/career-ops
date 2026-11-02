-- Career Ops durable cloud store. Applied by scripts/migrate-to-neon.mjs.
-- Keep raw source files alongside normalized rows so imports are lossless and
-- re-runnable while the API adapter is rolled out incrementally.
CREATE TABLE IF NOT EXISTS career_ops_documents (
  path TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS career_ops_imports (
  id BIGSERIAL PRIMARY KEY,
  source_root TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS career_ops_documents_updated_idx
  ON career_ops_documents (updated_at DESC);
