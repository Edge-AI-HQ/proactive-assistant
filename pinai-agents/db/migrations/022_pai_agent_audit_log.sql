-- Agent audit log — every /api/agent/* request lands here.
-- Used for replay / debug / "which agent run touched this row" queries.
-- args_summary is best-effort — repository helpers truncate sensitive fields.

CREATE TABLE pai_agent_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id       TEXT,
  endpoint     TEXT NOT NULL,
  method       TEXT NOT NULL,
  status       INTEGER,
  latency_ms   INTEGER,
  error_code   TEXT,
  args_summary JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pai_audit_user_time
  ON pai_agent_audit_log (user_id, created_at DESC);
-- run_id index is partial because most legacy / proxy paths don't set it.
CREATE INDEX idx_pai_audit_run
  ON pai_agent_audit_log (run_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX idx_pai_audit_endpoint_time
  ON pai_agent_audit_log (endpoint, created_at DESC);
