"""FastAPI 入口。/healthz + /webhook/linear + OAuth(actor=app) 安装。"""

from __future__ import annotations

import json
import logging
import time

from fastapi import BackgroundTasks, FastAPI, Header, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse

from dev_pipeline import __version__
from dev_pipeline.config import get_settings
from dev_pipeline.linear.models import TriggerKind, WebhookEnvelope, parse_trigger
from dev_pipeline.linear.webhook import timestamp_fresh, verify_signature
from dev_pipeline.service import PipelineService
from dev_pipeline.store import Store

log = logging.getLogger("dev_pipeline")
if not log.handlers:  # 自带 handler，绕过 uvicorn 把 root 压在 WARNING 导致 INFO 被吞
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(levelname)s:dev_pipeline:%(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

_AGENT_TRIGGERS = (TriggerKind.AGENT_SESSION_CREATED, TriggerKind.AGENT_SESSION_PROMPTED)


def _peek(raw: bytes) -> tuple[str | None, str | None]:
    """不验签也能 log 出 webhook 的 type/action，便于诊断 401。"""
    try:
        obj = json.loads(raw)
        return obj.get("type"), obj.get("action")
    except (ValueError, AttributeError):
        return None, None


def create_app() -> FastAPI:
    settings = get_settings()
    store = Store(settings.store_path)
    service = PipelineService(settings, store)

    app = FastAPI(title="dev-pipeline", version=__version__)

    @app.get("/healthz")
    def healthz() -> dict[str, str | bool]:
        return {
            "status": "ok",
            "service": "dev-pipeline",
            "version": __version__,
            "installed": service.is_installed(),
        }

    # --- OAuth(actor=app) 安装：点 /oauth/linear/authorize 一次即可 ---

    @app.get("/oauth/linear/authorize")
    def oauth_authorize() -> RedirectResponse:
        return RedirectResponse(service.authorize_url())

    @app.get("/oauth/linear/callback")
    async def oauth_callback(code: str = "", state: str = "") -> HTMLResponse:
        if not code:
            return HTMLResponse("<h3>缺 code</h3>", status_code=400)
        await service.complete_oauth(code, state)
        return HTMLResponse("<h3>✅ dev-pipeline 已安装为 Linear agent。可以关掉此页。</h3>")

    # --- Linear webhook ---

    @app.post("/webhook/linear")
    async def webhook_linear(
        request: Request,
        background: BackgroundTasks,
        linear_signature: str | None = Header(default=None, alias="Linear-Signature"),
    ) -> Response:
        # Linear 要求 5s 内响应：验签 + 解析后立刻 200，真处理丢后台。
        s = get_settings()
        raw = await request.body()
        etype, eaction = _peek(raw)
        if not verify_signature(raw, linear_signature, s.linear_webhook_secret):
            log.warning("webhook 401 (bad sig): type=%s action=%s", etype, eaction)
            return Response(status_code=401, content="bad signature")

        env = WebhookEnvelope.model_validate_json(raw)
        if not timestamp_fresh(env.webhook_timestamp, int(time.time() * 1000)):
            return Response(status_code=400, content="stale webhook")

        trigger = parse_trigger(env)
        log.info(
            "webhook ok: type=%s action=%s kind=%s issue=%s session=%s",
            etype, eaction, trigger.kind, trigger.issue_id, trigger.agent_session_id,
        )
        if trigger.kind in _AGENT_TRIGGERS:
            # 真链路诊断：打出真实 AgentSession payload，校准 parse_trigger 字段路径
            log.info("agent payload raw: %s", raw.decode("utf-8", "replace"))
            background.add_task(service.handle, trigger)
        app.state.last_trigger = trigger  # noqa: B010  (便于测试断言)
        return Response(status_code=200, content=trigger.kind.value)

    return app


app = create_app()
