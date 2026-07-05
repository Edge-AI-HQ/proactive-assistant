"""UI-facing L2 portrait read — the Mirror page renders the markdown slots.

/api/user-strings — Supabase JWT (current_user), under user_scoped_tx (RLS).
Read-only: the whole portrait is agent-maintained via memory_edit — the user
view (USER/GOALS) plus the agent's persona slots (IDENTITY/SOUL/TOOLS). The user
only reads it; there is no UI write path here — the Mirror page just renders the
five slots. The agent-facing read + write live in user_strings_agent.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pinai_db.rls import user_scoped_tx

from ....platform.auth.deps import current_user, get_pool
from ....platform.auth.user_service import User
from .repository import UserStringsRepository

router = APIRouter(prefix="/api/user-strings", tags=["user-strings"])


@router.get("/")
async def get_portrait(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """The five-slot portrait (markdown content per slot) for the Mirror page."""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = UserStringsRepository(user.id, conn)
        portrait = await repo.get_all()
    return {"slots": portrait}
