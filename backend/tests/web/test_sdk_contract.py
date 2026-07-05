"""Contract: every hand-written pinai_sdk resource maps to a live
`/api/agent/*` endpoint group on web.

Guards one leg of the "three hand-written copies" drift — the agent data
plane is reachable three ways (`/api/agent/*` route ← native `@tool` ←
`pinai_sdk`), and the sdk is hand-written (object-style `client.events.search()`,
kept hand-written on purpose: `openapi-python-client` emits a function-style
API that would break every Code Mode script + SDK_CHEAT_SHEET — see plan
2026-06-02 §PR-A). If a web resource group is renamed/removed and the sdk
isn't updated, this goes red.

Scope = resource level (prefix). Per-method suffixes are f-strings assembled
at call time; SDK_CHEAT_SHEET ↔ sdk is covered by `test_sdk_cheat_sheet_sync`,
and a full per-path contract (ast of the sdk's f-string paths) is deferred
as YAGNI for a low-frequency drift.

`pinai_sdk` is NOT installed in the web/test venv (it's baked into the
Daytona sandbox image only), so we read its source instead of importing it.
"""

from __future__ import annotations

import re
from pathlib import Path

from pinai_api.app import create_app

_REPO = Path(__file__).resolve().parents[2]
_SDK_CLIENT = _REPO / "packages" / "pinai_sdk" / "src" / "pinai_sdk" / "_client.py"

# Each sdk resource declares its endpoint group as `super().__init__(parent,
# "/api/agent/...")` (the _Endpoint subclasses). Raw is the lone non-_Endpoint
# resource (dynamic toolkit/entity path) and is asserted separately.
_PREFIX_RE = re.compile(r'super\(\)\.__init__\(\s*parent,\s*"(/api/agent/[^"]+)"')


def _sdk_prefixes() -> set[str]:
    return set(_PREFIX_RE.findall(_SDK_CLIENT.read_text()))


def _web_agent_paths() -> set[str]:
    app = create_app()
    return {r.path for r in app.routes if getattr(r, "path", "").startswith("/api/agent/")}


def test_sdk_resource_prefixes_have_web_endpoints() -> None:
    web = _web_agent_paths()
    prefixes = _sdk_prefixes()
    # 5 resources since cards retired (recently-proposed cards are
    # agent_decision events — read via client.events, not a cards resource).
    assert len(prefixes) >= 5, f"expected ≥5 sdk resource prefixes, got {sorted(prefixes)}"
    missing = [p for p in prefixes if not any(w == p or w.startswith(p + "/") for w in web)]
    assert not missing, (
        f"sdk resource prefixes with no matching web /api/agent endpoint: {missing} "
        f"(sdk↔endpoint drift — update packages/pinai_sdk or the web route)"
    )


def test_sdk_raw_resource_has_web_endpoint() -> None:
    # client.raw is the one resource that isn't an _Endpoint subclass.
    web = _web_agent_paths()
    assert any(w.startswith("/api/agent/raw") for w in web), (
        "no /api/agent/raw endpoint backing sdk client.raw"
    )
