"""Pure model / protocol shared between web and chat process groups.

The workspace's leaf package (`libs/contracts`). No IO, no credentials,
no business logic — anything heavier belongs in `pinai_api` or
`agent_engine`. As a standalone package it cannot import either
service, which keeps the trust boundary's shared layer truly shared.
"""
