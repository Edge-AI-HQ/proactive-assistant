-- Raw connector data: collab toolkits.
-- Slack / Notion / Discord / GitHub / Jira / Asana (workspaces + tasks) /
-- ClickUp (user + workspaces) / Trello.

-- ── Slack ──
CREATE TABLE pai_raw_slack_messages (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  channel_name       TEXT,
  ts                 TEXT NOT NULL,
  thread_ts          TEXT,
  slack_user_id      TEXT,
  slack_user_name    TEXT,
  text               TEXT,
  permalink          TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, channel_id, ts)
);
CREATE UNIQUE INDEX idx_pai_raw_slack_dedupe
  ON pai_raw_slack_messages (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_slack_occurred
  ON pai_raw_slack_messages (user_id, occurred_at DESC);

-- ── Notion ──
CREATE TABLE pai_raw_notion_pages (
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                  TEXT NOT NULL,
  page_id             TEXT NOT NULL,
  title               TEXT,
  url                 TEXT,
  parent_id           TEXT,
  parent_type         TEXT,
  icon                TEXT,
  last_edited_time    TIMESTAMPTZ,
  created_time        TIMESTAMPTZ,
  content_preview     TEXT,
  archived            BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at         TIMESTAMPTZ NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key          TEXT,
  reference_count     INTEGER NOT NULL DEFAULT 0,
  last_referenced_at  TIMESTAMPTZ,
  referenced_by_runs  JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, page_id)
);
CREATE UNIQUE INDEX idx_pai_raw_notion_dedupe
  ON pai_raw_notion_pages (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_notion_edited
  ON pai_raw_notion_pages (user_id, last_edited_time DESC);

-- ── Discord ──
CREATE TABLE pai_raw_discord_guilds (
  user_id                       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                            TEXT NOT NULL,
  guild_id                      TEXT NOT NULL,
  name                          TEXT,
  icon                          TEXT,
  is_owner                      BOOLEAN NOT NULL DEFAULT FALSE,
  permissions                   TEXT,
  features                      JSONB NOT NULL DEFAULT '[]'::jsonb,
  approximate_member_count      INTEGER,
  approximate_presence_count    INTEGER,
  occurred_at                   TIMESTAMPTZ NOT NULL,
  ingested_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key                    TEXT,
  reference_count               INTEGER NOT NULL DEFAULT 0,
  last_referenced_at            TIMESTAMPTZ,
  referenced_by_runs            JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, guild_id)
);
CREATE UNIQUE INDEX idx_pai_raw_discord_dedupe
  ON pai_raw_discord_guilds (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── GitHub Issues (includes PRs via is_pull_request flag) ──
CREATE TABLE pai_raw_github_issues (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  issue_id             TEXT NOT NULL,
  number               INTEGER,
  repo_full_name       TEXT,
  title                TEXT,
  body_preview         TEXT,
  state                TEXT,
  html_url             TEXT,
  is_pull_request      BOOLEAN NOT NULL DEFAULT FALSE,
  labels               JSONB NOT NULL DEFAULT '[]'::jsonb,
  assignees            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at_remote    TIMESTAMPTZ,
  updated_at_remote    TIMESTAMPTZ,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, issue_id)
);
CREATE UNIQUE INDEX idx_pai_raw_gh_issues_dedupe
  ON pai_raw_github_issues (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_gh_issues_repo_state
  ON pai_raw_github_issues (user_id, repo_full_name, state, updated_at_remote DESC);

-- ── Jira Projects ──
CREATE TABLE pai_raw_jira_projects (
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                  TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  project_key         TEXT,
  name                TEXT,
  description         TEXT,
  project_type        TEXT,
  lead_name           TEXT,
  url                 TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key          TEXT,
  reference_count     INTEGER NOT NULL DEFAULT 0,
  last_referenced_at  TIMESTAMPTZ,
  referenced_by_runs  JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, project_id)
);
CREATE UNIQUE INDEX idx_pai_raw_jira_dedupe
  ON pai_raw_jira_projects (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_jira_key
  ON pai_raw_jira_projects (user_id, project_key);

-- ── Asana Workspaces ──
CREATE TABLE pai_raw_asana_workspaces (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  workspace_gid      TEXT NOT NULL,
  name               TEXT,
  resource_type      TEXT,
  is_organization    BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, workspace_gid)
);
CREATE UNIQUE INDEX idx_pai_raw_asana_ws_dedupe
  ON pai_raw_asana_workspaces (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Asana Tasks ──
CREATE TABLE pai_raw_asana_tasks (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  task_gid             TEXT NOT NULL,
  workspace_gid        TEXT,
  project_gid          TEXT,
  name                 TEXT,
  notes                TEXT,
  completed            BOOLEAN NOT NULL DEFAULT FALSE,
  assignee_status      TEXT,
  due_at               TIMESTAMPTZ,
  due_on               DATE,
  modified_at_remote   TIMESTAMPTZ,
  created_at_remote    TIMESTAMPTZ,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, task_gid)
);
CREATE UNIQUE INDEX idx_pai_raw_asana_tasks_dedupe
  ON pai_raw_asana_tasks (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_asana_tasks_modified
  ON pai_raw_asana_tasks (user_id, modified_at_remote DESC);

-- ── ClickUp User ──
CREATE TABLE pai_raw_clickup_user (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  clickup_id         TEXT NOT NULL,
  username           TEXT,
  email              TEXT,
  color              TEXT,
  profile_picture    TEXT,
  timezone           TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, clickup_id)
);
CREATE UNIQUE INDEX idx_pai_raw_clickup_user_dedupe
  ON pai_raw_clickup_user (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── ClickUp Workspaces ──
CREATE TABLE pai_raw_clickup_workspaces (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  workspace_id       TEXT NOT NULL,
  name               TEXT,
  color              TEXT,
  avatar             TEXT,
  members_count      INTEGER,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, workspace_id)
);
CREATE UNIQUE INDEX idx_pai_raw_clickup_ws_dedupe
  ON pai_raw_clickup_workspaces (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Trello Boards ──
CREATE TABLE pai_raw_trello_boards (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  board_id           TEXT NOT NULL,
  name               TEXT,
  description        TEXT,
  url                TEXT,
  organization_id    TEXT,
  closed             BOOLEAN NOT NULL DEFAULT FALSE,
  starred            BOOLEAN NOT NULL DEFAULT FALSE,
  pinned             BOOLEAN NOT NULL DEFAULT FALSE,
  last_activity_at   TIMESTAMPTZ,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, board_id)
);
CREATE UNIQUE INDEX idx_pai_raw_trello_dedupe
  ON pai_raw_trello_boards (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_trello_activity
  ON pai_raw_trello_boards (user_id, last_activity_at DESC);
