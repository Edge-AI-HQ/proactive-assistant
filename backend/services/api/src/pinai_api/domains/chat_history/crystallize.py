"""Stub UI routes for endpoints whose Repository hasn't landed yet.

Each returns 200 with empty/default shape so the frontend doesn't crash;
returning 501 Not Implemented would break "click around the UI" smoke
tests where most features aren't wired yet.

Step C-fill replaces these per route as Repositories land.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from ...platform.auth.deps import User, current_user

# NOTE: skills_router and feedback_router moved to their own modules
# (routes/ui/skills.py, routes/ui/feedback.py) with real Repository
# backings. Step C-fill replaced these stubs.


# ── Crystallize ──
crystallize_router = APIRouter(prefix="/api/crystallize", tags=["crystallize"])


@crystallize_router.get("/state")
async def crystallize_state(user: User = Depends(current_user)):
    """Empty-but-complete shape matching the frontend's
    CrystallizeStateResponse contract (see api.ts). Real values land
    in Step C-fill when CrystallizeRepository is implemented."""
    return {
        "ok": True,
        "state": {
            "turn_count": 0,
            "last_crystallized_at": None,
            "last_session_key": None,
            "last_message_at": None,
        },
        "settings": {"auto_crystallize": True},
        "config": {
            "defaults": {},
            "override": {},
            "effective": {},
            "bounds": {},
        },
        "skillCounts": {"active": 0, "disabled": 0, "total": 0},
        "recentDecisions": [],
        "diagnostics": {
            "lastSessionKey": None,
            "lastSessionKind": None,
            "secondsSinceLastBump": None,
        },
    }


@crystallize_router.patch("/config")
async def crystallize_config(body: dict, user: User = Depends(current_user)):
    return {"detail": "crystallize config update — Step C-crystallize"}


@crystallize_router.post("/run", status_code=status.HTTP_202_ACCEPTED)
async def crystallize_run(user: User = Depends(current_user)):
    return {"detail": "crystallize manual trigger — Step F-3"}


# NOTE: dreaming_router moved to routes/ui/dreaming.py with real
# scheduler trigger + EvolutionRepository read.


# NOTE: composio_router moved to routes/ui/composio.py — real REST flow.
# NOTE: tasks_router moved to routes/ui/tasks.py — Step C-fill.


# NOTE: raw_router moved to routes/ui/raw.py — real per-table reads
# backed by user_scoped_tx. The stub returned empty items which made the
# Profile page look like there was no data even after gmail ingest.
