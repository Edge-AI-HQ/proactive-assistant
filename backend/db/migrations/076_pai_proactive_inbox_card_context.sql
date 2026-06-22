-- Proactive inbox: carry optional card_context with an enqueued item.
--
-- When chat unified on the proactive infra, two flows enqueue a turn that
-- needs the card's JSON to reach the agent at DRAIN time (not enqueue time,
-- since /send is async — enqueue now, agent runs later):
--   * card-execution bootstrap (card_fanout) → first turn of a card thread;
--   * feedback-into-main → the user opened the assistant from a card.
-- chat/routes/chat.py injects it as a <card_context> SystemMessage (card
-- thread: first turn only; main thread: any turn carrying it).
--
-- Nullable: ticks and ordinary user messages leave it NULL.

ALTER TABLE pai_proactive_inbox ADD COLUMN card_context JSONB;
