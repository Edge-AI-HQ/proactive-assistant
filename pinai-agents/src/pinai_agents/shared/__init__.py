"""Pure model / protocol shared between web and chat process groups.

No IO, no credentials, no business logic. Anything heavier belongs in
`web/` or `chat/`. ruff banned-api forbids importing `pinai_agents.web`
or `pinai_agents.chat` from here — keeps shared truly shared.
"""
