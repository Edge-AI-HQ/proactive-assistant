-- Lock in the User Identifier Convention (AGENTS.md "安全约束（P0）"):
-- supabase_user_id is the *only* user identifier that ever leaves this
-- system. Every external namespace (Composio user_id, LiteLLM user_id,
-- Supabase Storage path prefix, Stripe metadata) must derive from it.
--
-- That contract only works if the column is NOT NULL — code that derives
-- the namespace must never have to branch on "what if it's missing".
-- All sign-up paths go through Supabase Auth, so a NULL supabase_user_id
-- means a half-bootstrapped or pre-Supabase row that can never log in
-- again. Per product direction (pre-launch, no migration concerns),
-- purge them.
--
-- Cascade: pai_* tables FK to users.id ON DELETE CASCADE, so this also
-- wipes any orphan user-scoped data those rows owned.

DELETE FROM users WHERE supabase_user_id IS NULL;

ALTER TABLE users ALTER COLUMN supabase_user_id SET NOT NULL;
