"""Pin the prompt-side SDK cheat sheet to the SDK source.

The chat process can't import `pinai_sdk` (only the Daytona sandbox
has it installed), so `prompts/shared.py` keeps a verbatim copy of
`pinai_sdk._client.SDK_CHEAT_SHEET`. If the SDK surface changes and
only one side gets updated, agents see the wrong shape and start
inventing methods again — exactly the failure mode this cheat sheet
exists to prevent.

We can't `import pinai_sdk` here either (same reason — the wheel isn't
installed in the agents test env). So we read the SDK source file
directly and extract the literal value.
"""

from __future__ import annotations

import ast
from pathlib import Path

from agent_engine.agents.prompts.shared import _SDK_CHEAT_SHEET

_SDK_CLIENT_PY = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "pinai_sdk"
    / "src"
    / "pinai_sdk"
    / "_client.py"
)


def _extract_sdk_cheat_sheet_source() -> str:
    """Parse the SDK source and return the value of the
    `SDK_CHEAT_SHEET` module-level assignment as a string."""
    tree = ast.parse(_SDK_CLIENT_PY.read_text())
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if (
                isinstance(target, ast.Name)
                and target.id == "SDK_CHEAT_SHEET"
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ):
                return node.value.value
    msg = "SDK_CHEAT_SHEET literal not found in pinai_sdk._client"
    raise AssertionError(msg)


def test_prompt_cheat_sheet_matches_sdk_source() -> None:
    sdk_value = _extract_sdk_cheat_sheet_source()
    assert sdk_value == _SDK_CHEAT_SHEET, (
        "pinai_sdk._client.SDK_CHEAT_SHEET diverged from "
        "prompts/shared.py:_SDK_CHEAT_SHEET. Update both together so "
        "agents in the sandbox see the same surface the prompt promised."
    )
