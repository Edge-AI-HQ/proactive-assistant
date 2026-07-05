-- L0 raw 按「域」分表(回 doc §三 设计):统一 pai_raw → pai_raw_apps + pai_raw_device。
--
-- WP6(110/111/114/118)曾把 12 typed 表 + pai_raw_events 收成单一 pai_raw(toolkit +
-- entity_type 判别)。本 migration 按 doc §三「L0·Raw:契约,不是表」+ §62 原则 7「统一消费
-- 接口,不强求统一存储」把存储拆回两张域表——统一发生在投影管线 + source→table registry,
-- 不在物理表:
--
--   pai_raw_apps   所有 Composio app / generic connector(gmail/slack/github/notion…)
--                  discriminator = toolkit + entity_type(= 旧 pai_raw 的非 device 行)
--   pai_raw_device 设备数据(apps/contacts/health snapshot + ambient utterance/visit/…)
--                  discriminator = kind(= 旧 device 行的 entity_type;无 toolkit 列,
--                  external_id 仍是 device_id 供 full-sync DELETE 限定单设备)
--
-- 域有限(5–6 个,doc §119),connector 无限——域内用 discriminator 区分,新域(finance)再加
-- 表不碰别人。world/chat/feedback 本就是独立域表,不在本 migration。
--
-- expand-contract 的 contract 步:DROP 是 additive-only 的破例,经用户授权(坚持回 doc 域表)。
-- 数据迁移 FIRST、幂等(ON CONFLICT DO NOTHING)、先于 DROP。两表 unique 与旧表等价(apps =
-- 原 (toolkit,entity_type,dedupe_key);device 的 (kind,dedupe_key) = 原 (entity_type,
-- dedupe_key),因只迁 toolkit='device' 行,原 unique 已保证其内唯一),迁移无冲突。
--
-- envelope / reference triple / TTL 列与 110 完全一致,两表各保留一套(reference triple 给
-- 检索命中 bump、replace_health 的 reference_count=0 保护;expires_at 给 evolve forgetting)。

-- ── pai_raw_apps:Composio app / generic connector 域 ─────────────────────
CREATE TABLE pai_raw_apps (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT   NOT NULL,
  toolkit            TEXT   NOT NULL,
  entity_type        TEXT   NOT NULL,
  external_id        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ,
  title              TEXT,
  snippet            TEXT,
  payload            JSONB  NOT NULL,
  dedupe_key         TEXT   NOT NULL,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB  NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);

CREATE UNIQUE INDEX idx_pai_raw_apps_dedupe
  ON pai_raw_apps (user_id, toolkit, entity_type, dedupe_key);
CREATE INDEX idx_pai_raw_apps_window
  ON pai_raw_apps (user_id, toolkit, entity_type, occurred_at DESC);
CREATE INDEX idx_pai_raw_apps_ttl
  ON pai_raw_apps (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE pai_raw_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_raw_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY pai_raw_apps_user_scope ON pai_raw_apps
  FOR ALL TO PUBLIC
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
CREATE POLICY pai_raw_apps_service_role ON pai_raw_apps
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

-- ── pai_raw_device:设备数据域(discriminator = kind,无 toolkit)────────────
CREATE TABLE pai_raw_device (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT   NOT NULL,
  kind               TEXT   NOT NULL,
  external_id        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ,
  title              TEXT,
  snippet            TEXT,
  payload            JSONB  NOT NULL,
  dedupe_key         TEXT   NOT NULL,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB  NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);

CREATE UNIQUE INDEX idx_pai_raw_device_dedupe
  ON pai_raw_device (user_id, kind, dedupe_key);
CREATE INDEX idx_pai_raw_device_window
  ON pai_raw_device (user_id, kind, occurred_at DESC);
CREATE INDEX idx_pai_raw_device_scope
  ON pai_raw_device (user_id, kind, external_id);
CREATE INDEX idx_pai_raw_device_ttl
  ON pai_raw_device (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE pai_raw_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_raw_device FORCE ROW LEVEL SECURITY;
CREATE POLICY pai_raw_device_user_scope ON pai_raw_device
  FOR ALL TO PUBLIC
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
CREATE POLICY pai_raw_device_service_role ON pai_raw_device
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

-- ── 数据迁移(幂等,先于 DROP)─────────────────────────────────────────────
-- 非 device 行 → pai_raw_apps(列一一对应)。
INSERT INTO pai_raw_apps (user_id, id, toolkit, entity_type, external_id, occurred_at,
                          ingested_at, expires_at, title, snippet, payload, dedupe_key,
                          reference_count, last_referenced_at, referenced_by_runs)
SELECT user_id, id, toolkit, entity_type, external_id, occurred_at,
       ingested_at, expires_at, title, snippet, payload, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw
WHERE toolkit <> 'device'
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

-- device 行 → pai_raw_device(entity_type → kind,丢弃恒为 'device' 的 toolkit)。
INSERT INTO pai_raw_device (user_id, id, kind, external_id, occurred_at,
                            ingested_at, expires_at, title, snippet, payload, dedupe_key,
                            reference_count, last_referenced_at, referenced_by_runs)
SELECT user_id, id, entity_type, external_id, occurred_at,
       ingested_at, expires_at, title, snippet, payload, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw
WHERE toolkit = 'device'
ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING;

-- ── contract:drop 统一表 ─────────────────────────────────────────────────
DROP TABLE IF EXISTS pai_raw CASCADE;
