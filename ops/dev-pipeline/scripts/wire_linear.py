#!/usr/bin/env python3
"""把 Linear OAuth app 的回调 / webhook 指到 dev-pipeline 的公网 URL。

双模式：
- 能自动就自动：用 LINEAR_API_KEY 调 oauthApplicationUpdate（需 `oauth:create` scope）。
- 不能就降级：打印要在 Linear UI 粘的精确值 + 设置页链接（personal key 缺 scope 时）。

用法（在 ops/dev-pipeline 下）：
    uv run python scripts/wire_linear.py --base-url https://<tunnel-or-fly-url>
    uv run python scripts/wire_linear.py --base-url https://... --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from dev_pipeline.config import get_settings
from dev_pipeline.linear.client import LinearClient, LinearError

# Agent 会话 + 基础数据。具体 enum 值以 Linear 当前 schema 为准（M4 对照 live 校正）。
WEBHOOK_RESOURCE_TYPES = ["Issue", "Comment", "AgentSession"]


def _urls(base: str) -> tuple[str, str]:
    base = base.rstrip("/")
    return f"{base}/oauth/linear/callback", f"{base}/webhook/linear"


def _print_manual(settings_urlkey: str, redirect: str, webhook: str) -> None:
    print("\n⚠️  当前 key 没有 oauth:create scope，无法 API 自助配置。请去 Linear UI 手动粘：")
    print(f"   设置页: https://linear.app/{settings_urlkey}/settings/api/applications")
    print("   打开 OAuth app `proactive-ai-dev`，填两处：")
    print(f"   1) Redirect URI  = {redirect}")
    print(f"   2) Webhook URL   = {webhook}")
    print("      勾 Webhook events: Agent session events / Issues / Comments；保存。")
    print("   （或：换一个带 oauth scope 的 token 重跑本脚本即可自动配置）\n")


async def _run(base_url: str, dry_run: bool) -> int:
    s = get_settings()
    redirect, webhook = _urls(base_url)
    print(f"redirect_uri = {redirect}")
    print(f"webhook_url  = {webhook}")
    print(f"resource_types = {WEBHOOK_RESOURCE_TYPES}")
    if dry_run:
        print("\n[dry-run] 不调用 API。")
        return 0
    if not s.linear_api_key or not s.linear_oauth_client_id:
        print("缺 LINEAR_API_KEY / LINEAR_OAUTH_CLIENT_ID（见 .env）", file=sys.stderr)
        return 2

    client = LinearClient(s.linear_api_key, s.linear_api_url)
    try:
        app_id = await client.find_oauth_app_id(s.linear_oauth_client_id)
        if app_id is None:
            print("没找到匹配 clientId 的 OAuth app（确认 client id 对）", file=sys.stderr)
            return 2
        await client.update_oauth_app(
            app_id,
            redirect_uris=[redirect],
            webhook_url=webhook,
            webhook_resource_types=WEBHOOK_RESOURCE_TYPES,
            webhook_enabled=True,
        )
        print(f"\n✅ 已自动配置 OAuth app {app_id} 的 redirect + webhook。")
        return 0
    except LinearError as e:
        if "oauth:create" in str(e) or "FORBIDDEN" in str(e) or "forbidden" in str(e):
            _print_manual(_urlkey(), redirect, webhook)
            return 0
        print(f"LinearError: {e}", file=sys.stderr)
        return 1


def _urlkey() -> str:
    # org urlkey 用于拼设置页链接；固定 edge-ai-hq（见 plan 凭证现状节）
    return "edge-ai-hq"


def main() -> int:
    p = argparse.ArgumentParser(description="wire Linear OAuth app redirect/webhook")
    p.add_argument("--base-url", required=True, help="dev-pipeline 的公网 HTTPS base URL")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    return asyncio.run(_run(args.base_url, args.dry_run))


if __name__ == "__main__":
    raise SystemExit(main())
