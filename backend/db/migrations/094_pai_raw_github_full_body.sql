-- GitHub issues/PRs were only storing body[:800] in body_preview, dropping the
-- rest of the issue/PR body. Add a full-text `body` column (mirrors gmail's
-- snippet+body split: body_preview stays as the short summary source, body holds
-- the complete text). Additive only. Existing rows refill on the next github
-- sync (the upsert is ON CONFLICT DO UPDATE).
ALTER TABLE pai_raw_github_issues ADD COLUMN body TEXT;
