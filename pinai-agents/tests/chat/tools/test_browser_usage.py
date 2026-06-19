from __future__ import annotations

import pytest

from pinai_agents.chat.auth.run_jwt import RunPrincipal
from pinai_agents.chat.tools.browser import routes

pytestmark = pytest.mark.asyncio


async def test_clear_site_cookies_reports_browserbase_usage(monkeypatch):
    cleared: dict[str, str] = {}
    reported: dict[str, object] = {}

    class FakeBrowserManager:
        async def clear_site_cookies(self, context_id: str, site_domain: str) -> None:
            cleared["context_id"] = context_id
            cleared["site_domain"] = site_domain

    monkeypatch.setattr(routes, "get_browser_manager", lambda: FakeBrowserManager())
    monkeypatch.setattr(
        routes,
        "_principal_or_401",
        lambda _auth: RunPrincipal(
            user_id=123,
            run_id="run-x",
            virtual_key="sk-test",
            browserbase_context_id="ctx-123",
            raw={},
        ),
    )
    monkeypatch.setattr(routes, "report_compute_usage", lambda **kwargs: reported.update(kwargs))

    resp = await routes.browser_context_clear_site(
        routes.ClearSiteBody(siteDomain="Example.COM"),
        authorization="Bearer jwt-browser",
    )

    assert resp == {"ok": True, "siteDomain": "example.com"}
    assert cleared == {"context_id": "ctx-123", "site_domain": "example.com"}
    assert reported["provider"] == "browserbase"
    assert reported["source"] == "browser:clear_site"
    assert reported["run_jwt"] == "jwt-browser"
    assert reported["metadata"] == {"siteDomain": "example.com"}
