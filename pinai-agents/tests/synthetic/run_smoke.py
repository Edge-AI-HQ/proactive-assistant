"""One-command card-generation smoke test.

Runs the REAL generator pipeline (planner → card writer → evaluator) end to
end against LiteLLM, fed by the synthetic Alice persona. No web, no DB, no
UI, no fixtures to construct — just call it:

    cd pinai-agents
    set -a && . ./.env && set +a            # loads LITELLM_MASTER_KEY (auto-loaded if you skip this)
    uv run python tests/synthetic/run_smoke.py

    # options
    uv run python tests/synthetic/run_smoke.py --cards 6 --lang en
    LITELLM_BASE_URL=http://litellm:4000/v1 uv run python tests/synthetic/run_smoke.py

Exit code 0 when cards were produced, 1 when zero cards (regression), 2 on a
pipeline error. Use this after any change to the generator to confirm cards
still come out before deploying.

Why this exists: a writer-prompt regression once made every card silently
fail and surface only as an opaque "no cards" 502. This catches that class of
bug in one local run.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PINAI_ROOT = _HERE.parent.parent  # .../pinai-agents

# Default to the dev LiteLLM endpoint; override with LITELLM_BASE_URL.
os.environ.setdefault("LITELLM_BASE_URL", "https://proactive-ai-litellm-dev.fly.dev/v1")
# Keep the smoke run self-contained — don't ship traces unless asked.
os.environ.setdefault("LANGSMITH_TRACING", "false")


def _load_env_file() -> None:
    """Populate LITELLM_MASTER_KEY from pinai-agents/.env if not already set,
    so the script runs with a bare `python tests/synthetic/run_smoke.py`."""
    if os.environ.get("LITELLM_MASTER_KEY"):
        return
    env_path = _PINAI_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = val


async def _main(cards: int, lang: str) -> int:
    _load_env_file()
    master_key = os.environ.get("LITELLM_MASTER_KEY")
    if not master_key:
        print(
            "LITELLM_MASTER_KEY not set. Run `set -a && . ./.env && set +a` "
            "from pinai-agents/ first (or export it).",
            file=sys.stderr,
        )
        return 2

    sys.path.insert(0, str(_HERE))
    import persona_alice  # noqa: PLC0415 — sibling fixture, path injected above

    from pinai_agents.chat.agents import generator as gen  # noqa: PLC0415

    phase1 = persona_alice.build_alice_phase1()

    async def _fake_context(**_kw: object) -> dict:
        return phase1

    gen.build_generation_context = _fake_context  # bypass web context fetch

    now = datetime.now(UTC)
    print(f"persona: {persona_alice.PERSONA_NAME}")
    print(f"litellm: {os.environ['LITELLM_BASE_URL']}  cards={cards} lang={lang}")
    print("running generator (planner → writer → evaluator)…")

    t0 = datetime.now(UTC)
    try:
        out = await gen.run_generator(
            virtual_key=master_key,
            current_date=now.strftime("%Y-%m-%d"),
            user_id=0,
            run_id="smoke-alice",
            run_jwt="unused-offline",
            cards_to_generate=cards,
            output_language=lang,
            matched_patterns=[],
            context_since=now - timedelta(days=2),
            context_until=now,
        )
    except Exception as exc:  # surface the real failure, like the route does
        dt = (datetime.now(UTC) - t0).total_seconds()
        print(f"\nFAILED after {dt:.0f}s — {type(exc).__name__}: {exc}")
        return 2

    dt = (datetime.now(UTC) - t0).total_seconds()
    print(f"\nOK in {dt:.0f}s — cards={len(out.cards)} evals={len(out.evaluations)}")
    for i, c in enumerate(out.cards):
        d = c.model_dump(by_alias=True)
        print(f"  [{i}] {d.get('goalBasket')}/{d.get('intentKey')}  «{d.get('title')}»")
    if not out.cards:
        print("REGRESSION: zero cards.  batch_feedback:", (out.batch_feedback or "")[:300])
        return 1
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="Card-generation smoke test (Alice persona).")
    ap.add_argument("--cards", type=int, default=6, help="cards to generate (default 6)")
    ap.add_argument("--lang", default="en", choices=["en", "zh"], help="output language")
    args = ap.parse_args()
    sys.exit(asyncio.run(_main(args.cards, args.lang)))


if __name__ == "__main__":
    main()
