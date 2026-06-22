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
import contextlib
import logging
import os
import time
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import daytona
import httpx
from langchain_daytona import DaytonaSandbox

logger = logging.getLogger(__name__)

# ── Tunables ──

# Per-command timeout passed to DaytonaSandbox.execute(). Long-running
# commands (e.g. package install) hit this ceiling.
_DEFAULT_COMMAND_TIMEOUT_SEC = 5 * 60

# Overall ceiling for a one-shot agent run (dream / crystallize / evolve).
# A hung tool call (e.g. the sandbox can't reach web, so an in-sandbox SDK call
# blocks) must NOT wedge the run indefinitely: on timeout the run is cancelled,
# the run's finally force-deletes the sandbox + reports usage, and the handler
# returns a degraded result instead of hanging until Daytona's own 60min
# auto_stop. 10min matches the generator's run ceiling (see scheduler
# dispatcher). Env-tunable for ops.
ONESHOT_AGENT_RUN_TIMEOUT_SEC = int(os.environ.get("ONESHOT_AGENT_RUN_TIMEOUT_SEC", str(10 * 60)))

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

# LRU cap. 256 = enough for a single dev backend to host hundreds
# of active conversations without OOM, while bounding the worst case
# (malicious client opening unlimited unique thread_ids).
_REGISTRY_MAX_ENTRIES = 256

# Diagnostic correlation only — registry is the source of truth for
# active sandboxes; this label just lets you eyeball Daytona dashboard.
_LABEL_THREAD = "pinai-agents-thread-id"


# ── Provision resilience (P0) ──
#
# Every Daytona blocking call runs on a DEDICATED bounded pool, never the
# default asyncio executor. `asyncio.wait_for` cancels the *await* on
# timeout but CANNOT kill the underlying thread — the SDK's sync HTTP call
# keeps running until it returns. A dedicated, bounded pool caps how many
# such stuck threads can pile up and isolates them from unrelated
# `to_thread` work, so a Daytona outage can't exhaust the process-wide pool
# and wedge every sandbox path (the failure mode behind the prod hang).
_PROVISION_POOL_SIZE = 8
_DAYTONA_EXECUTOR = ThreadPoolExecutor(
    max_workers=_PROVISION_POOL_SIZE,
    thread_name_prefix="daytona-provision",
)

# Outer asyncio ceilings (seconds). `resume` also passes the SDK's native
# start timeout (forwarded to the HTTP `_request_timeout`); these wait_for
# values sit just above it as the backstop for a wedged socket that ignores
# the SDK timeout. `refresh`/`create` have no native timeout, so wait_for is
# their only ceiling.
_REFRESH_TIMEOUT_SEC = 20.0
_RESUME_TIMEOUT_SEC = 90.0
_CREATE_TIMEOUT_SEC = 150.0
_SDK_START_TIMEOUT_SEC = 60.0


class SandboxProvisionError(Exception):
    """Thread-sandbox provisioning failed (timeout or unrecoverable Daytona
    error). Raised so callers fail-open — surface a tool/chat error instead
    of hanging the turn."""


async def _run_blocking[T](fn: Callable[..., T], *args: object, timeout: float, what: str) -> T:
    """Run a Daytona sync call on the dedicated pool under an outer timeout.

    Raises `SandboxProvisionError` on timeout. The underlying thread may
    still be running afterward (Python can't cancel it), but the bounded
    pool caps the blast radius until the SDK call drains or errors out."""
    loop = asyncio.get_running_loop()
    try:
        fut = loop.run_in_executor(_DAYTONA_EXECUTOR, lambda: fn(*args))
    except RuntimeError as exc:
        # Executor shut down (lifespan exit) while a stream was still
        # provisioning. Surface as a normal provision error so the
        # (DaytonaError, SandboxProvisionError) handlers catch it rather
        # than a bare RuntimeError leaking past them.
        raise SandboxProvisionError(f"{what} unavailable: provisioning pool shut down") from exc
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    except TimeoutError as exc:
        raise SandboxProvisionError(f"{what} timed out after {timeout:.0f}s") from exc


# ── Circuit breaker (P2) ──
#
# When Daytona is down, every provision would otherwise burn its full
# timeout budget before failing — slow, wasteful, and it keeps hammering a
# dead dependency. After N consecutive provision failures the breaker
# OPENS: provisioning fast-fails for a cooldown window WITHOUT touching
# Daytona, so callers (LazyThreadSandbox → tool → SSE) degrade instantly
# instead of every turn eating the timeout. After cooldown it goes
# HALF-OPEN — the next attempt probes Daytona; success closes it, failure
# restarts the cooldown. Single-threaded asyncio: plain module globals are
# safe (no await between read and write in these helpers).
_BREAKER_FAIL_THRESHOLD = 3
_BREAKER_COOLDOWN_SEC = 60.0
_breaker_failures = 0
_breaker_opened_at: float | None = None


def _breaker_fast_fail_if_open() -> None:
    """Raise immediately if the breaker is OPEN and still within cooldown."""
    if _breaker_opened_at is None:
        return
    elapsed = time.monotonic() - _breaker_opened_at
    if elapsed < _BREAKER_COOLDOWN_SEC:
        raise SandboxProvisionError(
            f"sandbox provisioning circuit open "
            f"({_breaker_failures} consecutive failures); "
            f"retry in {_BREAKER_COOLDOWN_SEC - elapsed:.0f}s"
        )
    # Cooldown elapsed → HALF-OPEN: let this probe through.


def _breaker_record_success() -> None:
    global _breaker_failures, _breaker_opened_at
    if _breaker_opened_at is not None:
        # Only a HALF-OPEN probe (cooldown already elapsed) closes the
        # breaker. A success from a concurrent thread while still inside the
        # cooldown is NOT the probe — ignore it, so one in-flight success
        # can't reopen the floodgates while Daytona is still half-dead.
        if time.monotonic() - _breaker_opened_at >= _BREAKER_COOLDOWN_SEC:
            logger.info("sandbox provisioning circuit CLOSED (recovered)")
            _breaker_failures = 0
            _breaker_opened_at = None
    elif _breaker_failures > 0:
        # CLOSED: decay ONE failure rather than wiping the count. Under
        # concurrent provisioning against a half-dead Daytona, a single
        # success in the burst must not erase other in-flight threads'
        # accumulated failures — otherwise the count never reaches the
        # threshold and the breaker never opens.
        _breaker_failures -= 1


def _breaker_record_failure() -> None:
    global _breaker_failures, _breaker_opened_at
    _breaker_failures += 1
    if _breaker_failures >= _BREAKER_FAIL_THRESHOLD:
        was_closed = _breaker_opened_at is None
        _breaker_opened_at = time.monotonic()  # (re)open / restart cooldown
        if was_closed:
            logger.warning(
                "sandbox provisioning circuit OPEN after %d consecutive failures — "
                "fast-failing for %.0fs",
                _breaker_failures,
                _BREAKER_COOLDOWN_SEC,
            )


@dataclass
class _CacheEntry:
    backend: DaytonaSandbox
    raw: daytona.Sandbox
    last_used: float
    # Raw phantom token minted at sandbox-create time. Kept here so evict
    # can revoke without re-fetching from the DB. None for legacy sandboxes
    # created without a run_jwt (transition / test-only path).
    phantom_token: str | None = None
    # The chat-driving JWT the sandbox was created under. Needed for
    # late revoke calls — chat → web /phantom/revoke uses the same JWT
    # that authorized the original mint. May go stale if the chat thread
    # outlives the JWT TTL; we'll fall back to a sandbox-id-only revoke
    # in that case (caller still proves identity at next mint anyway).
    creator_jwt: str | None = field(default=None, repr=False)


@dataclass
class _Metrics:
    hit_started: int = 0  # cache hit, sandbox still STARTED
    hit_resumed: int = 0  # cache hit, sandbox STOPPED → resumed
    miss_create: int = 0  # cache miss, fresh create
    coalesced: int = 0  # cache miss, joined an in-flight Future
    evicted_stale: int = 0  # cache hit, sandbox state unrecoverable → evicted
    evicted_lru: int = 0  # LRU evicted to free capacity
    evicted_gc: int = 0  # idle GC evicted
    evicted_manual: int = 0  # routes called evict_thread() (e.g. tool error)
    create_errors: int = 0  # daytona create_blocking raised


# OrderedDict for LRU semantics: move_to_end on access, popitem(last=False)
# evicts oldest. Single global lock — fine for ≤ ~hundred concurrent users
# on one backend process. Step 2+ multi-replica needs Redis-backed.
_REGISTRY: OrderedDict[str, _CacheEntry] = OrderedDict()
_CREATING: dict[str, asyncio.Future[tuple[DaytonaSandbox, daytona.Sandbox]]] = {}
_LOCK = asyncio.Lock()
_METRICS = _Metrics()


# ── Phantom-token client (chat → web HTTP) ──
#
# Trust split: the chat process has no DB credentials and no JWT signing
# key. To get a phantom token for the sandbox, it asks web — passing the
# same chat-driving JWT it received from upstream. Web mints in its own
# DB session, returns the raw token, chat ferries it into the Daytona
# env at create time. The raw token is never logged; it appears only in
# the cache entry and the response body.

_PHANTOM_HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=10.0)
_phantom_http_client: httpx.AsyncClient | None = None


def _web_url() -> str:
    """URL chat-worker uses internally to reach api (phantom mint,
    SDK proxy from this process). docker-internal hostname is fine —
    same docker network."""
    return os.environ.get("WEB_INTERNAL_URL", "http://api:8000")


def _sandbox_pai_api_url() -> str:
    """URL injected into the *sandbox* environment as PAI_API_URL.

    The sandbox runs on Daytona's remote host, NOT in our docker
    network — `api` won't resolve. Operators must expose api
    over a public URL (ngrok in dev, real domain in prod) and set
    `PAI_API_URL` on the chat container to that URL; this is what we
    forward to the sandbox. We deliberately don't reuse `_web_url()`
    here because chat-worker's *own* internal calls should keep
    using the docker hostname (faster, doesn't tunnel out and back)."""
    return os.environ.get("PAI_API_URL") or _web_url()


def _phantom_http() -> httpx.AsyncClient:
    """Module-level httpx client for phantom RPC. Closed implicitly at
    interpreter exit; we don't bother with explicit shutdown because the
    phantom endpoints are tiny and the chat process is supervised."""
    global _phantom_http_client
    if _phantom_http_client is None:
        _phantom_http_client = httpx.AsyncClient(
            base_url=_web_url(),
            timeout=_PHANTOM_HTTP_TIMEOUT,
            headers={"User-Agent": "agent-engine-sandbox/0.1"},
        )
    return _phantom_http_client


async def _phantom_mint(*, run_jwt: str, scope_label: str | None) -> tuple[str, str]:
    resp = await _phantom_http().post(
        "/api/agent/sandbox/phantom/mint",
        json={"scope_label": scope_label},
        headers={"Authorization": f"Bearer {run_jwt}"},
    )
    resp.raise_for_status()
    body = resp.json()
    return body["token"], body["token_hash"]


async def _phantom_bind(
    *,
    run_jwt: str,
    token_hash: str,
    sandbox_id: str,
) -> None:
    resp = await _phantom_http().post(
        "/api/agent/sandbox/phantom/bind",
        json={"token_hash": token_hash, "sandbox_id": sandbox_id},
        headers={"Authorization": f"Bearer {run_jwt}"},
    )
    resp.raise_for_status()


async def _phantom_revoke(
    *,
    run_jwt: str,
    token: str | None = None,
    sandbox_id: str | None = None,
    reason: str | None = None,
) -> None:
    """Best-effort revoke. Logs and swallows network/HTTP errors — the
    phantom row's TTL (= sandbox auto_delete) is the safety net so a
    failed revoke just delays cleanup, doesn't leak access permanently."""
    body: dict[str, str | None] = {"reason": reason}
    if token is not None:
        body["token"] = token
    if sandbox_id is not None:
        body["sandbox_id"] = sandbox_id
    try:
        resp = await _phantom_http().post(
            "/api/agent/sandbox/phantom/revoke",
            json=body,
            headers={"Authorization": f"Bearer {run_jwt}"},
        )
        resp.raise_for_status()
    except Exception:
        logger.exception(
            "phantom revoke failed sandbox_id=%s reason=%s — TTL will catch up",
            sandbox_id or "?",
            reason or "-",
        )


# ── Sync helpers (always called from asyncio.to_thread) ──


def _create_blocking(
    thread_id: str | None,
    env_vars: dict[str, str] | None = None,
) -> daytona.Sandbox:
    """Create a sandbox.

    Two modes:
    - Default: declarative `CreateSandboxFromImageParams` with the Pin AI
      image (slim Python 3.12 + pinai_sdk preinstalled). Daytona caches
      the image build by content hash so the first sandbox in a 24h
      window pays the build cost (~30s); subsequent ones reuse the cache.
      This is the path used in production — Python scripts the agent
      writes via `write_file` + runs via `execute` can
      `from pinai_sdk import client` without ModuleNotFoundError.
    - Snapshot override: set `PINAI_DAYTONA_SNAPSHOT=<name:version>` env to
      use a pre-registered snapshot instead. Useful when the org's
      snapshot tier is enabled (avoids rebuild even after 24h).

    `env_vars` carries phantom token + API URL — set at create time
    because Daytona has no post-create env update API.
    """
    sdk = daytona.Daytona()
    labels = {_LABEL_THREAD: thread_id} if thread_id else None

    snapshot = os.environ.get("PINAI_DAYTONA_SNAPSHOT")
    params: daytona.CreateSandboxFromSnapshotParams | daytona.CreateSandboxFromImageParams
    if snapshot:
        params = daytona.CreateSandboxFromSnapshotParams(
            snapshot=snapshot,
            labels=labels,
            env_vars=env_vars,
            auto_stop_interval=_AUTO_STOP_MIN,
            auto_delete_interval=_AUTO_DELETE_MIN,
        )
    else:
        params = daytona.CreateSandboxFromImageParams(
            image=_pinai_image(),
            labels=labels,
            env_vars=env_vars,
            auto_stop_interval=_AUTO_STOP_MIN,
            auto_delete_interval=_AUTO_DELETE_MIN,
        )
    return sdk.create(params)


def _pinai_image() -> daytona.Image:
    """Mirror of infra/daytona/Dockerfile, declarative-builder form.

    Build is cached by Daytona on first use; subsequent sandbox creates
    in the same 24h window reuse the cached image. Pinned major versions
    so a downstream surprise pip resolver doesn't drift the image
    silently — bump explicitly when pinai_sdk needs newer deps.
    """
    sdk_dir = _pinai_sdk_local_dir()
    return (
        daytona.Image.debian_slim("3.12")
        .pip_install(
            [
                "httpx>=0.27.0,<1.0",
                "pydantic>=2.6.0,<3.0",
                "anyio>=4.0.0,<5.0",
                "orjson>=3.10.0,<4.0",
            ]
        )
        .add_local_dir(sdk_dir, "/opt/pinai_sdk")
        # Each command becomes its own RUN layer. Daytona's run_commands
        # treats a list arg as Docker exec-form (RUN ["a", "b"]), so we
        # MUST pass commands as separate positional string args, not a
        # single Python list. Past pitfall: the list form generated
        # `RUN "pip install ..." "python3 -c ..."` which Docker
        # interpreted as `/bin/sh -c <cmd1> <cmd2>` — second arg becomes
        # $0, so cmd2 silently never ran (or broke the build).
        .run_commands(
            "pip install --no-cache-dir /opt/pinai_sdk",
            "python3 -c 'from pinai_sdk import client; print(\"pinai_sdk preinstalled\")'",
        )
    )


def _pinai_sdk_local_dir() -> str:
    configured = os.environ.get("PINAI_SDK_LOCAL_DIR")
    if configured:
        return configured
    docker_path = Path("/app/packages/pinai_sdk")
    if docker_path.exists():
        return str(docker_path)
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "pinai_sdk"
        if candidate.exists():
            return str(candidate)
    return str(docker_path)


def _delete_blocking(raw: daytona.Sandbox) -> None:
    raw.delete()


def _refresh_state_blocking(raw: daytona.Sandbox) -> daytona.SandboxState | None:
    """Pull fresh state from Daytona. Raises if sandbox no longer exists.

    `state` may be None if the SDK hasn't populated it; the caller routes
    that through _state_name() (which normalizes None → "none"), so keep it
    in the return type rather than forcing a raise here.
    """
    raw.refresh_data()
    return raw.state


def _start_and_wait_blocking(raw: daytona.Sandbox) -> None:
    """Resume a STOPPED sandbox. Pass the SDK's native timeout (forwarded to
    the HTTP `_request_timeout`) so the blocking call can't wait forever even
    when the outer `asyncio.wait_for`'s thread-cancel can't reach it."""
    raw.start(_SDK_START_TIMEOUT_SEC)
    raw.wait_for_sandbox_start(_SDK_START_TIMEOUT_SEC)


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
        state = await _run_blocking(
            _refresh_state_blocking, raw, timeout=_REFRESH_TIMEOUT_SEC, what="refresh"
        )
    except daytona.DaytonaNotFoundError:
        logger.info(
            "sandbox not found thread=%s id=%s — recreating",
            thread_id,
            getattr(raw, "id", "?"),
        )
        return None
    except (daytona.DaytonaError, SandboxProvisionError) as e:
        # Auth / connection / rate-limit / timeout / validation — sandbox
        # state unknown this turn. Conservative: drop the cached entry and
        # let the create path retry, rather than hand back a backend whose
        # health we can't confirm. Programmer-bug exceptions (TypeError /
        # AttributeError / etc.) deliberately not caught — they should
        # surface, not be silently masked as "sandbox missing".
        logger.warning(
            "sandbox state refresh transient error thread=%s id=%s err=%s — recreating",
            thread_id,
            getattr(raw, "id", "?"),
            type(e).__name__,
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
        logger.info("sandbox resume start thread=%s id=%s", thread_id, raw.id)
        resume_started = time.monotonic()
        try:
            await _run_blocking(
                _start_and_wait_blocking, raw, timeout=_RESUME_TIMEOUT_SEC, what="resume"
            )
        except Exception as e:
            logger.warning(
                "sandbox resume failed thread=%s id=%s err=%s — recreating",
                thread_id,
                raw.id,
                type(e).__name__,
            )
            return None
        logger.info(
            "sandbox resumed thread=%s id=%s in %.1fs",
            thread_id,
            raw.id,
            time.monotonic() - resume_started,
        )
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
        thread_id,
        raw.id,
        name,
    )
    return None


# ── Public API ──


async def get_or_create_thread_sandbox(
    thread_id: str,
    *,
    run_jwt: str | None = None,
) -> tuple[DaytonaSandbox, daytona.Sandbox]:
    """Return the sandbox for `thread_id`, creating one on first call.

    Subsequent calls with the same thread_id return the SAME backend +
    sandbox (the DeepAgents-recommended pattern), with state-verify and
    lazy resume to recover from auto_stop / auto_delete transitions.

    When `run_jwt` is supplied, a phantom token is minted via web and
    injected into the sandbox env at create time (PAI_SANDBOX_TOKEN).
    Inside the sandbox, pinai_sdk reads this token; web's
    `current_agent_run` resolves it back to the user without ever
    exposing the chat-driving JWT (and its `vk` claim) to the sandbox.

    `run_jwt` is omitted only by legacy / test callers; in that mode
    pinai_sdk will fall back to PAI_RUN_JWT (also unset, so SDK calls
    will raise — surfaces as 401 error in tool output, expected).
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
            # Counter only counts the cheap path (entry unchanged + raw same
            # object = cache hit with no resume happened). _validate_cached
            # already bumped hit_resumed for the resume branch.
            async with _LOCK:
                still = _REGISTRY.get(thread_id)
                if still is cached and validated[1] is cached_raw:
                    _METRICS.hit_started += 1
            return validated
        # Validation rejected — drop entry + fall through to creation.
        # Best-effort revoke the orphaned phantom so it doesn't sit
        # active for its TTL (24h) after the sandbox is gone.
        async with _LOCK:
            entry = _REGISTRY.get(thread_id)
            if entry is cached:
                _REGISTRY.pop(thread_id, None)
                _METRICS.evicted_stale += 1
        if cached.phantom_token and cached.creator_jwt:
            await _phantom_revoke(
                run_jwt=cached.creator_jwt,
                token=cached.phantom_token,
                reason="stale_recreated",
            )

    # Path B: create or join an in-flight creation.
    return await _create_or_coalesce(thread_id, run_jwt=run_jwt)


async def _create_or_coalesce(
    thread_id: str,
    *,
    run_jwt: str | None = None,
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

    # Circuit breaker: if Daytona has been failing repeatedly, fast-fail now
    # without minting a phantom token or touching Daytona at all.
    try:
        _breaker_fast_fail_if_open()
    except SandboxProvisionError as e:
        async with _LOCK:
            _CREATING.pop(thread_id, None)
        if not new_future.done():
            new_future.set_exception(e)
        raise

    # Phantom token must be minted BEFORE Daytona create — env vars are
    # fixed at create time, no post-create mutation API.
    phantom_token: str | None = None
    phantom_hash: str | None = None
    env_vars: dict[str, str] = {"PAI_API_URL": _sandbox_pai_api_url()}

    if run_jwt:
        try:
            phantom_token, phantom_hash = await _phantom_mint(
                run_jwt=run_jwt,
                scope_label=thread_id,
            )
            env_vars["PAI_SANDBOX_TOKEN"] = phantom_token
        except Exception as e:
            _METRICS.create_errors += 1
            async with _LOCK:
                _CREATING.pop(thread_id, None)
            if not new_future.done():
                new_future.set_exception(e)
            logger.exception(
                "phantom mint failed thread=%s — refusing to create sandbox",
                thread_id,
            )
            raise

    logger.info("sandbox create start thread_id=%s", thread_id)
    create_started = time.monotonic()
    try:
        raw = await _run_blocking(
            _create_blocking, thread_id, env_vars, timeout=_CREATE_TIMEOUT_SEC, what="create"
        )
    except Exception as e:
        _METRICS.create_errors += 1
        _breaker_record_failure()
        async with _LOCK:
            _CREATING.pop(thread_id, None)
        if not new_future.done():
            new_future.set_exception(e)
        # Sandbox create failed but phantom row exists — revoke so it
        # doesn't sit unused until TTL expiration. Best-effort.
        if phantom_token and run_jwt:
            with contextlib.suppress(Exception):
                await _phantom_revoke(
                    run_jwt=run_jwt,
                    token=phantom_token,
                    reason="sandbox_create_failed",
                )
        raise

    _breaker_record_success()  # create succeeded → Daytona is healthy again

    # Bind the sandbox id back to the phantom row so we can revoke-by-id
    # later if the raw token isn't around. Bind failure is non-fatal —
    # we still have the raw token cached for revoke-by-token.
    if phantom_hash and run_jwt:
        with contextlib.suppress(Exception):
            await _phantom_bind(
                run_jwt=run_jwt,
                token_hash=phantom_hash,
                sandbox_id=raw.id,
            )

    backend = DaytonaSandbox(sandbox=raw, timeout=_DEFAULT_COMMAND_TIMEOUT_SEC)

    async with _LOCK:
        _REGISTRY[thread_id] = _CacheEntry(
            backend=backend,
            raw=raw,
            last_used=time.monotonic(),
            phantom_token=phantom_token,
            creator_jwt=run_jwt,
        )
        _CREATING.pop(thread_id, None)

    if not new_future.done():
        new_future.set_result((backend, raw))
    logger.info(
        "daytona sandbox created id=%s thread_id=%s scope=thread phantom=%s in %.1fs",
        raw.id,
        thread_id,
        "yes" if phantom_token else "no",
        time.monotonic() - create_started,
    )
    return backend, raw


def _evict_lru_locked() -> None:
    """Caller holds _LOCK. Drop oldest entries until under capacity.

    Async cleanup of evicted Daytona sandboxes is dispatched as detached
    tasks so creation isn't blocked on network deletion. Daytona TTL is
    the safety net if the detached task fails.

    Phantom revoke runs in the same detached task as the Daytona delete
    — if either fails, the other still proceeds. The phantom-row TTL
    (= Daytona auto_delete) bounds the worst case.
    """
    while len(_REGISTRY) >= _REGISTRY_MAX_ENTRIES:
        evicted_id, evicted_entry = _REGISTRY.popitem(last=False)
        _METRICS.evicted_lru += 1
        logger.info(
            "lru evicted thread=%s id=%s (registry at cap %d)",
            evicted_id,
            evicted_entry.raw.id,
            _REGISTRY_MAX_ENTRIES,
        )
        # Fire-and-forget delete + revoke. Don't await.
        asyncio.create_task(_best_effort_cleanup(evicted_entry, reason="lru_evict"))


async def _best_effort_delete(raw: daytona.Sandbox) -> None:
    try:
        await asyncio.to_thread(_delete_blocking, raw)
    except Exception:
        logger.exception("background delete failed id=%s", getattr(raw, "id", "?"))


async def _best_effort_cleanup(entry: _CacheEntry, *, reason: str) -> None:
    """Revoke phantom + delete Daytona sandbox. Independent: a failure of
    one does not block the other."""
    if entry.phantom_token and entry.creator_jwt:
        with contextlib.suppress(Exception):
            await _phantom_revoke(
                run_jwt=entry.creator_jwt,
                token=entry.phantom_token,
                reason=reason,
            )
    await _best_effort_delete(entry.raw)


async def evict_thread(thread_id: str) -> None:
    """Manually drop a thread's cached sandbox + delete the cloud resource
    + revoke the phantom token.

    Called by routes/chat.py when a tool execution surfaces a sandbox
    error mid-stream — the next chat send for this thread will create a
    fresh sandbox instead of retrying the broken one.
    """
    async with _LOCK:
        entry = _REGISTRY.pop(thread_id, None)
        if entry is None:
            return
        _METRICS.evicted_manual += 1
    await _best_effort_cleanup(entry, reason="manual_evict")
    logger.info("manual evict thread=%s id=%s", thread_id, entry.raw.id)


# raw_sandbox_id → (phantom_token, run_jwt). Keeps the oneshot revoke
# state out of the main registry (which is keyed by thread_id, not
# sandbox id). Cleared by delete_sandbox_now.
_ONESHOT_PHANTOMS: dict[str, tuple[str, str]] = {}


async def create_oneshot_sandbox(
    *,
    run_jwt: str | None = None,
    scope_label: str | None = None,
) -> tuple[DaytonaSandbox, daytona.Sandbox]:
    """One-shot sandbox: NOT cached, caller MUST delete via delete_sandbox_now.

    Used for /agent/generate (single LLM round, no follow-up turns) and
    diagnostic spikes. Returns the same (backend, raw) tuple as the
    thread path; the phantom token (if minted) is held internally by
    `delete_sandbox_now` via `_ONESHOT_PHANTOMS` for revoke.
    """
    env_vars: dict[str, str] = {"PAI_API_URL": _sandbox_pai_api_url()}
    phantom_token: str | None = None
    phantom_hash: str | None = None
    if run_jwt:
        phantom_token, phantom_hash = await _phantom_mint(
            run_jwt=run_jwt,
            scope_label=scope_label,
        )
        env_vars["PAI_SANDBOX_TOKEN"] = phantom_token

    try:
        raw = await _run_blocking(
            _create_blocking, None, env_vars, timeout=_CREATE_TIMEOUT_SEC, what="oneshot create"
        )
    except Exception:
        if phantom_token and run_jwt:
            with contextlib.suppress(Exception):
                await _phantom_revoke(
                    run_jwt=run_jwt,
                    token=phantom_token,
                    reason="oneshot_create_failed",
                )
        raise

    if phantom_token and phantom_hash and run_jwt:
        with contextlib.suppress(Exception):
            await _phantom_bind(
                run_jwt=run_jwt,
                token_hash=phantom_hash,
                sandbox_id=raw.id,
            )
        _ONESHOT_PHANTOMS[raw.id] = (phantom_token, run_jwt)

    backend = DaytonaSandbox(sandbox=raw, timeout=_DEFAULT_COMMAND_TIMEOUT_SEC)
    logger.info(
        "daytona sandbox created id=%s scope=oneshot phantom=%s",
        raw.id,
        "yes" if phantom_token else "no",
    )
    return backend, raw


async def delete_sandbox_now(raw: daytona.Sandbox) -> None:
    """Explicit delete for one-shot sandboxes. Revokes the phantom token
    if we minted one for it."""
    pair = _ONESHOT_PHANTOMS.pop(raw.id, None)
    if pair is not None:
        phantom_token, run_jwt = pair
        with contextlib.suppress(Exception):
            await _phantom_revoke(
                run_jwt=run_jwt,
                token=phantom_token,
                reason="oneshot_delete",
            )
    await _best_effort_delete(raw)


async def gc_idle_threads() -> int:
    """Background sweep: drop registry entries idle > _REGISTRY_IDLE_TTL_SEC.

    With auto_delete=24h, this matches: when a thread has been idle a full
    day, the cloud resource is also gone, so the registry ref is just
    dead weight.
    """
    now = time.monotonic()
    evicted: list[tuple[str, _CacheEntry]] = []
    async with _LOCK:
        for tid, entry in list(_REGISTRY.items()):
            if now - entry.last_used > _REGISTRY_IDLE_TTL_SEC:
                evicted.append((tid, entry))
                _REGISTRY.pop(tid)
                _METRICS.evicted_gc += 1
    for tid, entry in evicted:
        await _best_effort_cleanup(entry, reason="gc_idle")
        logger.info("gc evicted thread=%s id=%s", tid, entry.raw.id)
    return len(evicted)


async def shutdown_all_sandboxes() -> None:
    """Lifespan shutdown: best-effort delete every cached sandbox + revoke
    every phantom token."""
    async with _LOCK:
        entries = list(_REGISTRY.items())
        _REGISTRY.clear()
        _CREATING.clear()
    if entries:
        logger.info("shutdown: deleting %d cached sandboxes", len(entries))
        for tid, entry in entries:
            try:
                await _best_effort_cleanup(entry, reason="shutdown")
            except Exception:
                logger.exception("shutdown sandbox cleanup failed thread=%s", tid)
    # Drop the provision pool last — wait=False so a wedged Daytona call
    # can't block lifespan shutdown; cancel_futures clears the queue.
    _DAYTONA_EXECUTOR.shutdown(wait=False, cancel_futures=True)


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
        "breaker_failures": _breaker_failures,
        "breaker_open": int(_breaker_opened_at is not None),
        **{f.name: getattr(_METRICS, f.name) for f in _METRICS.__dataclass_fields__.values()},
    }
