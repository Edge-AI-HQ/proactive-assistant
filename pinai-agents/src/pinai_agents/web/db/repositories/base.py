"""UserScopedRepository — Repository pattern's Pin AI flavor.

Two design choices that matter:

1. user_id binds at construction, not at method call.
   Helpers cannot take user_id as a parameter — the binding is implicit
   via `self._user_id`. Concrete subclasses build SQL like:
       WHERE user_id = %(user_id)s
   with `user_id=self.user_id`. If a method ever forgets the WHERE,
   RLS (set up by user_scoped_tx) is the second wall.

2. Connection passed in, not held.
   Repositories are throwaway per-request objects. The caller (route /
   service layer) opens the user_scoped_tx, then constructs the
   Repository(user_id, conn). This keeps lifecycles obvious and avoids
   the "lazy DB connection" footgun where the Repository tries to open
   a connection at SQL time without a transaction.

Anti-patterns this layer enforces (by convention + test):
  - No method named like `list_for_user(user_id, ...)` — naming itself
    is a smell that the user_id is parameter rather than implicit.
  - Repositories don't open transactions; they use the caller's.
  - SQL never builds user_id from a string concatenation; always %s
    parameter. (Belt + suspenders against injection even though user_id
    is int.)
"""

from __future__ import annotations

from psycopg import AsyncConnection


class UserScopedRepository:
    """Base class. Concrete subclasses live in this directory."""

    def __init__(self, user_id: int, conn: AsyncConnection) -> None:
        if not isinstance(user_id, int) or user_id <= 0:
            msg = f"user_id must be a positive int, got {user_id!r}"
            raise ValueError(msg)
        self._user_id = user_id
        self._conn = conn

    @property
    def user_id(self) -> int:
        return self._user_id

    @property
    def conn(self) -> AsyncConnection:
        return self._conn
