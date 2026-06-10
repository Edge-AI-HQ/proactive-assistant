"""Push notification dispatch (web process only).

Send pipeline for "you have N new cards" notifications. The dispatcher
calls :func:`notify_new_cards` right after a generator run finalizes its
cards in DB; this module is responsible for:

  1. Loading the user's notification preference (notify_new_cards) and
     skipping the dispatch when it's off.
  2. Loading the user's push-eligible devices (active rows with a token
     and push_failure_count below the soft-disable threshold).
  3. Per-device send via the platform-specific transport (v1 only APNs
     is implemented; FCM / Web Push land later behind the same
     :class:`PushTransport` protocol).
  4. Soft-failure bookkeeping — Apple's "BadDeviceToken" / "Unregistered"
     clears the token row; transient codes bump push_failure_count and
     soft-disable the device after the threshold.

When APNs credentials (APNS_TEAM_ID / APNS_KEY_ID / APNS_AUTH_KEY /
APNS_BUNDLE_ID) are missing — local dev without secrets — we fall back
to a logging-only stub so the rest of the pipeline still exercises
end-to-end.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Protocol

from aioapns import APNs, NotificationRequest, PushType

from ...config import WebSettings, get_web_settings
from ..db.repositories.devices import DevicesRepository, UserDeviceRow
from ..db.repositories.profile import ProfileRepository
from ..db.rls import user_scoped_tx

logger = logging.getLogger(__name__)

# APNs reason strings that mean "this device token is permanently bad —
# stop sending to it". The pipeline clears push_token on these.
# Source: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
_TERMINAL_APNS_REASONS: frozenset[str] = frozenset(
    {
        "BadDeviceToken",
        "Unregistered",
        "DeviceTokenNotForTopic",
    }
)


@dataclass(slots=True)
class PushPayload:
    """Wire-shape-agnostic notification payload. Each transport renders
    this into its own envelope (APNs aps dict, FCM message, etc.)."""

    title: str
    body: str
    # Opaque deep-link target, e.g. ``"app://cards"`` or
    # ``"app://cards/<id>"``. Frontend resolves on notification tap.
    deep_link: str | None = None
    # Optional collapse key — APNs ``apns-collapse-id`` / FCM
    # ``collapse_key``. Multiple notifications with the same key are
    # squashed by the OS so the user sees only the latest.
    collapse_key: str | None = None


@dataclass(slots=True)
class PushResult:
    ok: bool
    # When ok=False, error_code carries the transport-level reason
    # (e.g. "BadDeviceToken", "Unregistered"). Used by the caller to
    # decide whether to bump push_failure_count.
    error_code: str | None = None


class PushTransport(Protocol):
    """One implementation per push provider. send() must be idempotent
    from the caller's perspective: the dispatcher already handles
    failure-counter bookkeeping; the transport just returns the
    platform's verdict."""

    async def send(
        self,
        *,
        device: UserDeviceRow,
        payload: PushPayload,
    ) -> PushResult: ...


class _LoggingTransport:
    """Fallback when APNs creds aren't configured. Logs intent and
    reports success — used in local dev so the rest of the pipeline
    (DB writes, route shape) still exercises end-to-end."""

    async def send(
        self,
        *,
        device: UserDeviceRow,
        payload: PushPayload,
    ) -> PushResult:
        logger.info(
            "push.stub.send user=%s device=%s provider=%s title=%r body=%r deep_link=%s",
            device.user_id,
            device.device_id,
            device.push_provider,
            payload.title,
            payload.body,
            payload.deep_link,
        )
        return PushResult(ok=True)


class _ApnsTransport:
    """aioapns-backed iOS transport. Token-based auth: the .p8 PEM goes
    straight into PyJWT (aioapns passes ``key=`` through), so no tmpfile
    juggling. One APNs client per process; aioapns owns the HTTP/2
    connection pool and re-issues the auth JWT every ~30 min internally.

    Wakes lazily on first :meth:`send` to keep boot independent of APNs
    reachability (a flaky network at startup shouldn't crash the web
    process — settings.notify_new_cards just won't deliver until APNs
    recovers, which is the right failure mode).
    """

    def __init__(self, settings: WebSettings) -> None:
        self._settings = settings
        self._client: APNs | None = None

    def _ensure_client(self) -> APNs:
        if self._client is None:
            # All four required fields are present per _select_transport's
            # gate above — this assertion narrows for the type-checker.
            assert self._settings.apns_team_id
            assert self._settings.apns_key_id
            assert self._settings.apns_auth_key
            assert self._settings.apns_bundle_id
            self._client = APNs(
                key=base64.b64decode(self._settings.apns_auth_key).decode(),
                key_id=self._settings.apns_key_id,
                team_id=self._settings.apns_team_id,
                topic=self._settings.apns_bundle_id,
                use_sandbox=self._settings.apns_use_sandbox,
            )
        return self._client

    async def send(
        self,
        *,
        device: UserDeviceRow,
        payload: PushPayload,
    ) -> PushResult:
        if device.push_provider not in (None, "apns"):
            # Phase 1 only ships APNs; FCM / web rows shouldn't have
            # gotten this far (find_push_targets is provider-agnostic),
            # so surface as an explicit error instead of silently
            # failing on the JWT topic check.
            return PushResult(ok=False, error_code=f"unsupported_provider:{device.push_provider}")
        if not device.push_token:
            return PushResult(ok=False, error_code="missing_token")

        # Build the APNs payload. `aps.alert` is the visible banner; the
        # extra deep_link key rides alongside aps so the iOS client can
        # route the tap. `collapse_key` here maps to apns-collapse-id —
        # the OS coalesces banners with the same id.
        message: dict = {
            "aps": {
                "alert": {"title": payload.title, "body": payload.body},
                "sound": "default",
            },
        }
        if payload.deep_link:
            message["deep_link"] = payload.deep_link

        request = NotificationRequest(
            device_token=device.push_token,
            message=message,
            push_type=PushType.ALERT,
            collapse_key=payload.collapse_key,
        )
        try:
            client = self._ensure_client()
            response = await client.send_notification(request)
        except Exception as e:
            return PushResult(
                ok=False,
                error_code=f"transport_exception:{type(e).__name__}",
            )
        if response.is_successful:
            return PushResult(ok=True)
        # response.description is the APNs `reason` field (e.g.
        # "BadDeviceToken"). Callers pattern-match against
        # _TERMINAL_APNS_REASONS to decide whether to clear the token.
        return PushResult(
            ok=False,
            error_code=response.description or f"status:{response.status}",
        )


def _select_transport() -> PushTransport:
    settings = get_web_settings()
    have_all = all(
        [
            settings.apns_team_id,
            settings.apns_key_id,
            settings.apns_auth_key,
            settings.apns_bundle_id,
        ]
    )
    if have_all:
        logger.info("push.transport.apns enabled (sandbox=%s)", settings.apns_use_sandbox)
        return _ApnsTransport(settings)
    logger.warning(
        "push.transport.stub enabled — APNs credentials missing "
        "(have team=%s key=%s auth=%s bundle=%s)",
        bool(settings.apns_team_id),
        bool(settings.apns_key_id),
        bool(settings.apns_auth_key),
        bool(settings.apns_bundle_id),
    )
    return _LoggingTransport()


_transport: PushTransport = _select_transport()


def _build_new_cards_payload(*, card_count: int) -> PushPayload:
    body = "你有 1 张新的卡片" if card_count == 1 else f"你有 {card_count} 张新的卡片"
    return PushPayload(
        title="新卡片生成",
        body=body,
        deep_link="app://cards",
        # All "new cards" notifications collapse into one OS-level
        # banner — multiple generator runs in close succession show
        # as the most recent count, not a stack.
        collapse_key="new_cards",
    )


async def notify_new_cards(
    pool,
    *,
    user_id: int,
    card_count: int,
) -> int:
    """Dispatch the "new cards" notification to every push-eligible
    device the user has. Returns the count of devices we actually sent
    to (0 when the user opted out or has no push-registered device).

    Safe to call from the scheduler tick — wraps its own RLS-scoped tx
    and never raises into the caller. Generation must not fail because
    push is broken.
    """
    if card_count <= 0:
        return 0
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            settings = await ProfileRepository(user_id, conn).get_settings()
            if not settings.notify_new_cards:
                logger.info(
                    "push.skip user=%s reason=opted_out card_count=%d",
                    user_id,
                    card_count,
                )
                return 0
            targets = await DevicesRepository(user_id, conn).find_push_targets()
        if not targets:
            logger.info(
                "push.skip user=%s reason=no_targets card_count=%d",
                user_id,
                card_count,
            )
            return 0

        payload = _build_new_cards_payload(card_count=card_count)
        return await _send_to_targets(
            pool,
            user_id=user_id,
            targets=targets,
            payload=payload,
        )
    except Exception:
        logger.exception("push.dispatch_failed user=%s", user_id)
        return 0


async def _send_to_targets(
    pool,
    *,
    user_id: int,
    targets: list[UserDeviceRow],
    payload: PushPayload,
) -> int:
    """Per-device send + soft-failure bookkeeping. Shared by every notify_*
    entry point. Returns the count of devices we delivered to."""
    sent = 0
    for device in targets:
        try:
            result = await _transport.send(device=device, payload=payload)
        except Exception:
            logger.exception(
                "push.transport_error user=%s device=%s",
                user_id,
                device.device_id,
            )
            continue
        if result.ok:
            sent += 1
            logger.info("push.sent user=%s device=%s", user_id, device.device_id)
            continue
        logger.warning(
            "push.failed user=%s device=%s code=%s",
            user_id,
            device.device_id,
            result.error_code,
        )
        # Terminal codes: the token will never deliver again. Clear it so we
        # stop trying. Anything else is transient; bump the counter and let
        # find_push_targets's threshold soft-disable after enough strikes.
        terminal = result.error_code in _TERMINAL_APNS_REASONS
        try:
            async with user_scoped_tx(pool, user_id) as conn:
                repo = DevicesRepository(user_id, conn)
                if terminal:
                    await repo.clear_push_token(device.device_id)
                else:
                    await repo.bump_push_failure(device.device_id)
        except Exception:
            logger.exception(
                "push.bookkeeping_failed user=%s device=%s terminal=%s",
                user_id,
                device.device_id,
                terminal,
            )
    return sent


def _build_proactive_payload(*, message: str) -> PushPayload:
    # Single banner per outreach; collapse so a burst shows the latest only.
    # We always emit the push; the OS banner only shows when the app is NOT
    # foregrounded. Foreground suppression is client-side: iOS willPresent is
    # gated by capacitor.config `PushNotifications.presentationOptions: []`, so
    # an in-app user sees nothing here (the message arrives on the live stream).
    return PushPayload(
        title="Pin AI",
        body=message[:240],
        deep_link="app://proactive",
        collapse_key="proactive",
    )


async def notify_proactive_message(
    pool,
    *,
    user_id: int,
    message: str,
) -> int:
    """Dispatch a proactive notify_user message to the user's push-eligible
    devices. Unlike notify_new_cards there is no opt-in gate — proactive
    outreach is the product; the client decides whether to surface the
    banner. Never raises into the caller (the emit route)."""
    if not message.strip():
        return 0
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            targets = await DevicesRepository(user_id, conn).find_push_targets()
        if not targets:
            logger.info("push.skip user=%s reason=no_targets kind=proactive", user_id)
            return 0
        return await _send_to_targets(
            pool,
            user_id=user_id,
            targets=targets,
            payload=_build_proactive_payload(message=message),
        )
    except Exception:
        logger.exception("push.proactive_dispatch_failed user=%s", user_id)
        return 0


def _build_turn_completed_payload(*, session_key: str) -> PushPayload:
    # One banner per session — back-to-back long turns collapse to the
    # latest. NOTE: the client does NOT currently suppress foreground
    # banners (capacitor presentationOptions shows alerts in-app), so a
    # user watching the stream finish also sees this — acceptable for the
    # rare >120s turn; client-side suppression is the proper fix and would
    # cover the proactive push too.
    return PushPayload(
        title="Pin AI",
        body="Your long-running task just finished — the results are ready.",
        deep_link="app://chat",
        collapse_key=f"turn_done_{session_key}",
    )


async def notify_turn_completed(
    pool,
    *,
    user_id: int,
    session_key: str,
) -> int:
    """Dispatch the "long task finished" notification. The agent worker calls
    this after finalizing a turn that ran past its long-turn threshold — by
    then the user has almost certainly backgrounded the app. Same opt-in
    exemption as notify_proactive_message (the user asked for this work);
    never raises into finalize."""
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            targets = await DevicesRepository(user_id, conn).find_push_targets()
        if not targets:
            logger.info("push.skip user=%s reason=no_targets kind=turn_done", user_id)
            return 0
        return await _send_to_targets(
            pool,
            user_id=user_id,
            targets=targets,
            payload=_build_turn_completed_payload(session_key=session_key),
        )
    except Exception:
        logger.exception("push.turn_done_dispatch_failed user=%s", user_id)
        return 0


def _build_reminder_payload(*, title: str, message: str, task_id: str) -> PushPayload:
    # 同一任务的重复提醒折叠成一条 banner;不同任务互不折叠。
    return PushPayload(
        title=title[:80],
        body=message[:240],
        deep_link="app://cards",
        collapse_key=f"reminder_{task_id}",
    )


async def notify_reminder(
    pool,
    *,
    user_id: int,
    title: str,
    message: str,
    task_id: str,
) -> int:
    """用户显式创建的提醒 — 不受 notify_new_cards 开关约束(那是系统
    广播的 opt-in;这是用户自己要求的打扰),与 notify_proactive_message
    同一豁免逻辑。卡片已落库,push 失败不重试任务,所以永不上抛。"""
    if not message.strip():
        return 0
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            targets = await DevicesRepository(user_id, conn).find_push_targets()
        if not targets:
            logger.info("push.skip user=%s reason=no_targets kind=reminder", user_id)
            return 0
        return await _send_to_targets(
            pool,
            user_id=user_id,
            targets=targets,
            payload=_build_reminder_payload(title=title, message=message, task_id=task_id),
        )
    except Exception:
        logger.exception("push.reminder_dispatch_failed user=%s", user_id)
        return 0
