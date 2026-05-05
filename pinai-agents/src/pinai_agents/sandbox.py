"""Daytona sandbox lifecycle for DeepAgents — Manus/Claude-grade.

DeepAgents pattern (per official sandboxes guide):
    "Generally, each thread_id should use its own unique sandbox."
    "Created when the first run starts and reused for follow-up messages
     on the same thread."

Production-grade defenses layered on top of the basic registry:

    1. State-verify on cache hit
       Daytona's auto_stop / auto_delete can transition the sandbox under us
       between turns. Every cache hit refresh_data() and inspects the real
       state — never blindly hand back a stale backend.

    2. Lazy resume from STOPPED
       auto_stop preserves the filesystem; restart is cheap. STARTED →
       return; STOPPED → start() + wait; anything else (ARCHIVED,
       DESTROYED, ERROR) → evict + create fresh.

    3. Concurrent-request coalescing per thread
       Two parallel cache misses for the same thread_id are coalesced
       through a shared asyncio.Future so we don't create two sandboxes
       and orphan one. First caller creates; followers await the same
       Future.

    4. Bounded LRU cache
       OrderedDict keeps insertion/access order. At _REGISTRY_MAX_ENTRIES
       capacity, evict the LRU entry (and best-effort delete its sandbox).
       Defends against thread_id flooding (a runaway client / attacker
       creating many unique thread_ids would otherwise OOM the process).

    5. TTL configured for real chat patterns
       auto_stop=60min covers normal multi-turn conversation idle gaps;
       auto_delete=24h gives users overnight continuity without unbounded
       cost. App-level GC matches auto_delete so we drop registry refs at
       the same moment Daytona deletes the cloud resource.

Daytona SDK is sync-only; every blocking call goes through asyncio.to_thread
so the FastAPI event loop never stalls.

Lazy liveness (mid-stream sandbox failure recovery) is NOT implemented here
— that's a route-layer concern. routes/chat.py catches sandbox-related
exceptions and calls evict_thread() so the next chat send creates fresh.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, field

import daytona
from langchain_daytona import DaytonaSandbox

logger = logging.getLogger(__name__)

# ── Tunables ──

# Per-command timeout passed to DaytonaSandbox.execute(). Long-running
# commands (e.g. package install) hit this ceiling.
_DEFAULT_COMMAND_TIMEOUT_SEC = 5 * 60

# Daytona-side TTL. Layered:
#   auto_stop:   idle 60min  → STOPPED (compute released, fs preserved)
#   auto_delete: 1440min     → DESTROYED (fs gone, cost zero)
#
# Sized for real chat patterns: human users routinely idle 30-60min
# between turns; auto_stop=15 (the prior Step 1 placeholder) was killing
# alive sessions. 24h auto_delete gives overnight continuity without
# unbounded accumulation of stopped sandboxes.
_AUTO_STOP_MIN = 60
_AUTO_DELETE_MIN = 60 * 24

# App-level GC: drop registry entries idle longer than this. Matches
# auto_delete so we don't keep stale Python references after the cloud
# resource is gone.
_REGISTRY_IDLE_TTL_SEC = _AUTO_DELETE_MIN * 60

# LRU cap. 256 = enough for a single dev pinai-agents to host hundreds
# of active conversations without OOM, while bounding the worst case
# (malicious client opening unlimited unique thread_ids).
_REGISTRY_MAX_ENTRIES = 256

# Diagnostic correlation only — registry is the source of truth for
# active sandboxes; this label just lets you eyeball Daytona dashboard.
_LABEL_THREAD = "pinai-agents-thread-id"


@dataclass
class _CacheEntry:
    backend: DaytonaSandbox
    raw: daytona.Sandbox
    last_used: float


@dataclass
class _Metrics:
    hit_started: int = 0       # cache hit, sandbox still STARTED
    hit_resumed: int = 0       # cache hit, sandbox STOPPED → resumed
    miss_create: int = 0       # cache miss, fresh create
    coalesced: int = 0         # cache miss, joined an in-flight Future
    evicted_stale: int = 0     # cache hit, sandbox state unrecoverable → evicted
    evicted_lru: int = 0       # LRU evicted to free capacity
    evicted_gc: int = 0        # idle GC evicted
    evicted_manual: int = 0    # routes called evict_thread() (e.g. tool error)
    create_errors: int = 0     # daytona create_blocking raised


# OrderedDict for LRU semantics: move_to_end on access, popitem(last=False)
# evicts oldest. Single global lock — fine for ≤ ~hundred concurrent users
# on one pinai-agents process. Step 2+ multi-replica needs Redis-backed.
_REGISTRY: OrderedDict[str, _CacheEntry] = OrderedDict()
_CREATING: dict[str, "asyncio.Future[tuple[DaytonaSandbox, daytona.Sandbox]]"] = {}
_LOCK = asyncio.Lock()
_METRICS = _Metrics()


# ── Sync helpers (always called from asyncio.to_thread) ──


def _create_blocking(thread_id: str | None) -> daytona.Sandbox:
    sdk = daytona.Daytona()
    labels = {_LABEL_THREAD: thread_id} if thread_id else None
    params = daytona.CreateSandboxFromSnapshotParams(
        labels=labels,
        auto_stop_interval=_AUTO_STOP_MIN,
        auto_delete_interval=_AUTO_DELETE_MIN,
    )
    return sdk.create(params)


def _delete_blocking(raw: daytona.Sandbox) -> None:
    raw.delete()


def _refresh_state_blocking(raw: daytona.Sandbox) -> "daytona.SandboxState":
    """Pull fresh state from Daytona. Raises if sandbox no longer exists."""
    raw.refresh_data()
    return raw.state


def _start_and_wait_blocking(raw: daytona.Sandbox) -> None:
    """Resume a STOPPED sandbox. start() is async on Daytona's side; we
    explicitly wait for STARTED so callers can immediately use the sandbox."""
    raw.start()
    raw.wait_for_sandbox_start()


def _state_name(state: object) -> str:
    """Normalize SandboxState → lowercase string. Defensive against future
    Daytona SDK changes (enum value type may shift)."""
    return str(getattr(state, "name", state)).lower()


# ── Validation / recovery on cache hit ──


async def _validate_cached(
    thread_id: str, raw: daytona.Sandbox
) -> tuple[DaytonaSandbox, daytona.Sandbox] | None:
    """Refresh sandbox state and recover if needed.

    Returns the (now-healthy) backend pair, or None if the sandbox is
    unrecoverable and the cache entry should be dropped + recreated.
    """
    try:
        state = await asyncio.to_thread(_refresh_state_blocking, raw)
    except Exception:
        # NotFound, network blip, or DaytonaSDK changed — treat as gone.
        # Never raise to caller from validation; let the create path retry.
        logger.info(
            "sandbox state refresh failed thread=%s id=%s — treating as missing",
            thread_id, getattr(raw, "id", "?"),
        )
        return None

    name = _state_name(state)
    if name == "started":
        # Healthy. Caller already has the entry.
        async with _LOCK:
            entry = _REGISTRY.get(thread_id)
            if entry is not None:
                return entry.backend, entry.raw
        return None

    if name == "stopped":
        # auto_stop fired between turns — restart.
        try:
            await asyncio.to_thread(_start_and_wait_blocking, raw)
        except Exception:
            logger.warning(
                "sandbox start failed thread=%s id=%s — recreating",
                thread_id, raw.id,
            )
            return None
        logger.info("sandbox resumed thread=%s id=%s", thread_id, raw.id)
        async with _LOCK:
            entry = _REGISTRY.get(thread_id)
            if entry is not None:
                _METRICS.hit_resumed += 1
                return entry.backend, entry.raw
        return None

    # ARCHIVED / DESTROYED / DESTROYING / ERROR / BUILD_FAILED / UNKNOWN /
    # transient STARTING|STOPPING (we treat transient as unrecoverable — race
    # with another caller, simpler to recreate than to poll).
    logger.info(
        "sandbox in non-recoverable state thread=%s id=%s state=%s — recreating",
        thread_id, raw.id, name,
    )
    return None


# ── Public API ──


async def get_or_create_thread_sandbox(
    thread_id: str,
) -> tuple[DaytonaSandbox, daytona.Sandbox]:
    """Return the sandbox for `thread_id`, creating one on first call.

    Subsequent calls with the same thread_id return the SAME backend +
    sandbox (the DeepAgents-recommended pattern), with state-verify and
    lazy resume to recover from auto_stop / auto_delete transitions.
    """
    # Path A: validated cache hit (possibly with resume).
    async with _LOCK:
        cached = _REGISTRY.get(thread_id)
        if cached is not None:
            _REGISTRY.move_to_end(thread_id)  # LRU touch
            cached.last_used = time.monotonic()
            cached_raw = cached.raw  # snapshot for validate outside lock

    if cached is not None:
        validated = await _validate_cached(thread_id, cached_raw)
        if validated is not None:
            # Counter only counts the cheap path (no resume).
            # _validate_cached already bumped hit_resumed for the resume case.
            async with _LOCK:
                still = _REGISTRY.get(thread_id)
                if still is cached:
                    # Cheap hit — no resume happened
                    if validated[1] is cached_raw:
                        _METRICS.hit_started += 1
            return validated
        # Validation rejected — drop entry + fall through to creation.
        async with _LOCK:
            entry = _REGISTRY.get(thread_id)
            if entry is cached:
                _REGISTRY.pop(thread_id, None)
                _METRICS.evicted_stale += 1

    # Path B: create or join an in-flight creation.
    return await _create_or_coalesce(thread_id)


async def _create_or_coalesce(
    thread_id: str,
) -> tuple[DaytonaSandbox, daytona.Sandbox]:
    """Create sandbox for thread_id, coalescing duplicate concurrent
    requests through a shared Future."""
    # Phase 1: under lock, decide whether we're the creator or a follower.
    # NEVER await on the Future while holding _LOCK — the creator needs the
    # same lock at completion time to update the registry, so awaiting
    # inside it would deadlock.
    new_future: asyncio.Future[tuple[DaytonaSandbox, daytona.Sandbox]] | None = None
    follower_future: asyncio.Future[tuple[DaytonaSandbox, daytona.Sandbox]] | None = None
    async with _LOCK:
        existing = _CREATING.get(thread_id)
        if existing is not None:
            _METRICS.coalesced += 1
            follower_future = existing
        else:
            loop = asyncio.get_running_loop()
            new_future = loop.create_future()
            _CREATING[thread_id] = new_future
            _METRICS.miss_create += 1
            _evict_lru_locked()

    # Phase 2: outside lock — followers await, creator does the slow work.
    if follower_future is not None:
        return await follower_future
    assert new_future is not None  # narrowed by the else branch above

    try:
        raw = await asyncio.to_thread(_create_blocking, thread_id)
    except Exception as e:
        _METRICS.create_errors += 1
        async with _LOCK:
            _CREATING.pop(thread_id, None)
        if not new_future.done():
            new_future.set_exception(e)
        raise

    backend = DaytonaSandbox(sandbox=raw, timeout=_DEFAULT_COMMAND_TIMEOUT_SEC)

    async with _LOCK:
        _REGISTRY[thread_id] = _CacheEntry(
            backend=backend, raw=raw, last_used=time.monotonic()
        )
        _CREATING.pop(thread_id, None)

    if not new_future.done():
        new_future.set_result((backend, raw))
    logger.info(
        "daytona sandbox created id=%s thread_id=%s scope=thread", raw.id, thread_id
    )
    return backend, raw


def _evict_lru_locked() -> None:
    """Caller holds _LOCK. Drop oldest entries until under capacity.

    Async cleanup of evicted Daytona sandboxes is dispatched as detached
    tasks so creation isn't blocked on network deletion. Daytona TTL is
    the safety net if the detached task fails.
    """
    while len(_REGISTRY) >= _REGISTRY_MAX_ENTRIES:
        evicted_id, evicted_entry = _REGISTRY.popitem(last=False)
        _METRICS.evicted_lru += 1
        logger.info(
            "lru evicted thread=%s id=%s (registry at cap %d)",
            evicted_id, evicted_entry.raw.id, _REGISTRY_MAX_ENTRIES,
        )
        # Fire-and-forget delete. Don't await.
        asyncio.create_task(_best_effort_delete(evicted_entry.raw))


async def _best_effort_delete(raw: daytona.Sandbox) -> None:
    try:
        await asyncio.to_thread(_delete_blocking, raw)
    except Exception:
        logger.exception("background delete failed id=%s", getattr(raw, "id", "?"))


async def evict_thread(thread_id: str) -> None:
    """Manually drop a thread's cached sandbox + delete the cloud resource.

    Called by routes/chat.py when a tool execution surfaces a sandbox
    error mid-stream — the next chat send for this thread will create a
    fresh sandbox instead of retrying the broken one.
    """
    async with _LOCK:
        entry = _REGISTRY.pop(thread_id, None)
        if entry is None:
            return
        _METRICS.evicted_manual += 1
    await _best_effort_delete(entry.raw)
    logger.info("manual evict thread=%s id=%s", thread_id, entry.raw.id)


async def create_oneshot_sandbox() -> tuple[DaytonaSandbox, daytona.Sandbox]:
    """One-shot sandbox: NOT cached, caller MUST delete via delete_sandbox_now.

    Used for /agent/generate (single LLM round, no follow-up turns) and the
    /agent/sandbox-spike diagnostic.
    """
    raw = await asyncio.to_thread(_create_blocking, None)
    backend = DaytonaSandbox(sandbox=raw, timeout=_DEFAULT_COMMAND_TIMEOUT_SEC)
    logger.info("daytona sandbox created id=%s scope=oneshot", raw.id)
    return backend, raw


async def delete_sandbox_now(raw: daytona.Sandbox) -> None:
    """Explicit delete for one-shot sandboxes."""
    await _best_effort_delete(raw)


async def gc_idle_threads() -> int:
    """Background sweep: drop registry entries idle > _REGISTRY_IDLE_TTL_SEC.

    With auto_delete=24h, this matches: when a thread has been idle a full
    day, the cloud resource is also gone, so the registry ref is just
    dead weight.
    """
    now = time.monotonic()
    evicted: list[tuple[str, daytona.Sandbox]] = []
    async with _LOCK:
        for tid, entry in list(_REGISTRY.items()):
            if now - entry.last_used > _REGISTRY_IDLE_TTL_SEC:
                evicted.append((tid, entry.raw))
                _REGISTRY.pop(tid)
                _METRICS.evicted_gc += 1
    for tid, raw in evicted:
        await _best_effort_delete(raw)
        logger.info("gc evicted thread=%s id=%s", tid, raw.id)
    return len(evicted)


async def shutdown_all_sandboxes() -> None:
    """Lifespan shutdown: best-effort delete every cached sandbox."""
    async with _LOCK:
        entries = list(_REGISTRY.items())
        _REGISTRY.clear()
        _CREATING.clear()
    if not entries:
        return
    logger.info("shutdown: deleting %d cached sandboxes", len(entries))
    for tid, entry in entries:
        try:
            await asyncio.to_thread(_delete_blocking, entry.raw)
        except Exception:
            logger.exception("shutdown sandbox delete failed thread=%s", tid)


def registry_size() -> int:
    """Diagnostics only — no lock; value can be stale by the time you read."""
    return len(_REGISTRY)


def metrics_snapshot() -> dict[str, int]:
    """Diagnostics: counter snapshot. Returns dict (no lock — counters are
    int increments, atomic enough for diagnostic display)."""
    return {
        "registry_size": len(_REGISTRY),
        "in_flight_creations": len(_CREATING),
        "registry_max": _REGISTRY_MAX_ENTRIES,
        **{f.name: getattr(_METRICS, f.name) for f in _METRICS.__dataclass_fields__.values()},
    }
