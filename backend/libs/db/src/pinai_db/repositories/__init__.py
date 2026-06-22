"""Shared user-scoped repositories living in the db leaf.

These repositories are pure SQL on `pinai_db.base.UserScopedRepository`
and are consumed by *more than one* service:

  * `PatternsRepository` / `UserFingerprintRepository` back both the
    card-generation pipeline (pinai_api) and the internal reward
    dashboard (pinai_reward_dashboard). Putting them in the db leaf both
    services already depend on keeps a single source of truth for the
    pattern-library SQL without either service importing the other.

Service-private repositories (auth, chat history, devices, scheduler,
phantom tokens, …) stay inside their owning service — only genuinely
cross-service tables belong here.
"""

from __future__ import annotations

from pinai_db.repositories.patterns import PatternsRepository
from pinai_db.repositories.user_fingerprint import UserFingerprintRepository

__all__ = ["PatternsRepository", "UserFingerprintRepository"]
