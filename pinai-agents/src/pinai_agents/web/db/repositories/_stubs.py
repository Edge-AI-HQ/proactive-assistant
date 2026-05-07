"""Repository stubs for tables whose detailed CRUD lands in Step C.

Each class is a typed shell — `UserScopedRepository` subclass with
no methods yet. The point is:
  1. Import paths are stable. Step C endpoint PRs add methods here
     without renaming or moving files.
  2. The class hierarchy enforces user_id binding from day one.
  3. Tests that compose the full Repository surface can iterate the
     subclasses without forward-referencing modules that don't exist.

When implementing a method, MOVE the class out of this file into its
own module (e.g. skill_index.py) — `_stubs.py` is intentionally
ephemeral. Once empty, delete it.

Stubs deliberately have NO methods (not even abstract ones). NotImplementedError
on a stub call is a `AttributeError`, which makes "I forgot to implement
this" loud rather than silently returning None.
"""

from __future__ import annotations

from .base import UserScopedRepository


class CardsRepository(UserScopedRepository):
    """pai_card_evaluations + pai_intent_card_state + pai_intent_thread_state.
    Step C-cards."""


class PipelineRepository(UserScopedRepository):
    """pai_pipeline_runs. Step C-runs."""


class EvolutionRepository(UserScopedRepository):
    """pai_evolution_runs. Step C-evolution."""


class CrystallizeRepository(UserScopedRepository):
    """Specialized AppStateRepository wrapper for crystallize namespace.
    Step C-crystallize. Until then use AppStateRepository directly with
    namespace='crystallize'."""


class TasksRepository(UserScopedRepository):
    """pai_background_tasks + pai_task_attempts + pai_background_task_schedules
    (plugin's historical queue, distinct from pai_scheduled_tasks).
    Step C-tasks (plugin retire flow)."""


class RawRepository(UserScopedRepository):
    """Generic reader for the 33 typed pai_raw_* tables.
    Step C-raw — likely a single .list(toolkit, entity, **filters) method
    that builds SQL by table-name resolution from a static map."""


class WorldFeedRepository(UserScopedRepository):
    """Public-read shared world signals — convenience wrapper. Step C-world
    if needed; for now WorldSignalsRepository covers it."""
