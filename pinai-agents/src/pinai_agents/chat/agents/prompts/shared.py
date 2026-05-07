"""Three text blocks every sandbox-using agent embeds.

Conventions:
  * No mechanical instructions ("write_file then execute"). Tool
    descriptions on `write_file` / `execute` already teach the
    canonical pattern; agent prompts shouldn't re-prescribe.
  * Direct, declarative phrasing (Claude Code style). Examples are
    illustrative, not "you MUST follow this exact shape".
  * Stable byte-for-byte across releases. Anthropic prompt cache hits
    on identical prefixes — keep these constant unless you really
    need to change them.
"""

from __future__ import annotations

# What the sandbox is, what's preinstalled, what auth looks like.
# Embedded by every agent that runs sandbox code (all 5 of them).
SANDBOX_PREAMBLE = """\
<sandbox>
You have a sandbox where you can write and run Python. The
`pinai_sdk` module is preinstalled with auth pre-injected — just
import and call:

    from pinai_sdk import client
    rows = await client.memory.list(min_quality=0.7, limit=30)
    signals = await client.signals.recent(status="open", hours=24)

Surface: `client.memory` / `client.signals` / `client.profile` /
`client.world` / `client.raw` (gmail, gcal, plus per-toolkit). All
methods are async. The chat-driving JWT and the user's virtual_key
are NOT in the sandbox — the SDK uses an opaque per-sandbox token.

The sandbox can also reach the public internet via httpx (e.g. for
fetching a URL the user mentioned) but no other internal hosts.
</sandbox>"""


# When to write a sandbox script vs use a single tool call.
# Direct, no mechanical "write_file + execute" prescription —
# DeepAgents tool descriptions cover the mechanics.
CODE_MODE_GUIDANCE = """\
<code_mode>
Use Code Mode when you need to combine multiple SDK calls, batch
fetches, or post-process results. Write one Python script that does
everything in one shot — typically:

    import asyncio, json
    from pinai_sdk import client

    async def gather():
        return await asyncio.gather(
            client.memory.list(min_quality=0.7, limit=30),
            client.signals.recent(status="open", hours=24),
            # ... more in parallel
            return_exceptions=True,
        )

    res = asyncio.run(gather())
    print(json.dumps(res, default=str)[:6000])

Run that in your sandbox. One script = one round-trip beats N
separate SDK calls. Truncate large outputs in `print` — your context
window is the bottleneck, not the SDK.
</code_mode>"""


# No-fabrication rule. Phrased to fit both side-effect agents
# (dream/evolve/crystallize/generator) and the conversational chat
# agent — the spirit is the same: ground in real data or admit gap.
GROUNDING_POLICY = """\
<grounding>
No fabrication. Everything you produce — cards, memories, signals,
chat replies — must be grounded in real data the SDK returned.
Never imagine emails, calendar events, profile facts, or any detail
not present in your tool output.

If a call errors or a source is empty, say so plainly. Empty is a
valid honest output; a fabricated answer is not.
</grounding>"""
