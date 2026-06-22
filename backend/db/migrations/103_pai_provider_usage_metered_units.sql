-- Provider usage now records both duration-based providers (seconds) and
-- per-call/credit providers such as Tavily and Composio.

ALTER TABLE pai_provider_usage_events
  DROP CONSTRAINT IF EXISTS pai_provider_usage_events_units_check;

ALTER TABLE pai_provider_usage_events
  ADD CONSTRAINT pai_provider_usage_events_units_check
  CHECK (units IN ('seconds', 'api_credits', 'tool_calls'));
