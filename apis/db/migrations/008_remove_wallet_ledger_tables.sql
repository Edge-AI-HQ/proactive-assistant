-- Delegate budget/spend accounting fully to LiteLLM.
-- Local credit wallet + ledger tables are deprecated.

BEGIN;

DROP TRIGGER IF EXISTS update_user_credit_wallets_updated_at ON user_credit_wallets;

DROP TABLE IF EXISTS credit_ledger;
DROP TABLE IF EXISTS user_credit_wallets;

COMMIT;
