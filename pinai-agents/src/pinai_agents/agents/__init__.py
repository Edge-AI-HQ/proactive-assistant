"""Agent factories.

Each module here builds a `create_deep_agent`-shaped agent for one of the
three production flows that Step 1 replaces:
    generator (unified-generator)
    main_chat
    card_chat

Step 1 keeps these stub-data only — Phase 1 context gathering uses default
DeepAgents tools (in-memory fs/shell/todo), no pin CLI, no Postgres reads.
Step 2 wires real tool calls into Agent API endpoints.
"""
