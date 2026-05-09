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

The SDK_CHEAT_SHEET block embedded in SANDBOX_PREAMBLE is a verbatim
copy of `pinai_sdk._client.SDK_CHEAT_SHEET`. We can't `import pinai_sdk`
here (it's only installed in the Daytona sandbox, not in the chat
process) so the two are kept in sync by hand. If you change the SDK
public surface, update both the SDK source AND this string. The
`tests/chat/test_sdk_cheat_sheet_sync.py` test asserts they match.
"""

from __future__ import annotations

# Mirror of `pinai_sdk._client.SDK_CHEAT_SHEET`. Update both together.
_SDK_CHEAT_SHEET = """\
client.memory
  .list(*, min_quality=0.7, subject=None, subject_prefix=None,
        since=None, limit=30, offset=0, order_by="created_at_desc") -> list
  .search(*, q, min_quality=None, limit=10) -> list
  .get(id) -> dict | None
  .add(*, text, source="agent", subject=None, quality=0.6,
       confidence=0.5, source_run_id=None, tags=None, id=None) -> dict
  .archive(id) -> dict | None
  .supersede(*, old_id, new_id) -> dict | None

client.signals
  .recent(*, status="open", kind=None, hours=24,
          min_salience=None, limit=30) -> list      # status: open|consumed|archived|all
  .get(id) -> dict | None
  .consume(*, id, run_id) -> None
  .add(*, kind, title, summary="", salience=0.0, confidence=0.0,
       dedupe_key=None, subject=None, source="agent",
       payload=None, occurred_at=None, id=None) -> dict
  .ingest(**fields) -> dict                          # legacy; prefer .add

client.profile
  .get() -> {"profile": ... | None, "goals": [...]}
  .upsert(*, display_name=None, locale=None, timezone=None,
          summary=None, facts=None, preferences=None,
          constraints=None) -> dict                  # JSONB buckets replaced wholesale
  .upsert_goal(*, key, title, id=None, priority="medium",
               status="active", summary=None) -> dict

client.cards
  .recent(*, limit=30) -> list

client.feedback
  .list(*, kind=None, action=None, since=None, limit=50) -> list
  .log(*, kind, action=None, intent_card_id=None, intent_key=None,
       source="agent", basket=None, value=None, text=None,
       metadata=None, channel=None) -> dict

client.world
  .recent(*, status="open", provider=None, hours=None,
          min_salience=None, limit=30) -> list
  .score(*, id, salience, scored_reason=None, status="open") -> None
  .consume(*, id, run_id) -> None
  .reference(*, id, run_id) -> None

client.raw                                           # canonical entry: .list(toolkit, entity, ...)
  .list(toolkit, entity, *, hours=None, since=None, until=None,
        limit=50, dedupe_key=None) -> list           # pass hours OR since, not both
  .gmail.recent(*, hours=24, limit=20) -> list       # convenience
  .gcal.today(*, hours=48, limit=20) -> list         # convenience
  # other toolkits: use .list("slack","messages"), .list("github","issues"),
  #                 .list("gdrive","files"), .list("calendly","events"), ...
  # client.raw.slack / .github / etc DO NOT EXIST — use .list(...)

Supported (toolkit, entity) for raw.list:
  gmail/messages, gcal/events, gdrive/files, slack/messages,
  github/issues, calendly/events, stripe/invoices,
  twitter/bookmarks, youtube/subscriptions, linkedin/profile,
  device/{apps,contacts,health}

client.composio                                      # live SaaS access via Composio Tool Router
  .connections() -> list                             # ACTIVE connected toolkits for the user
  .search(query, *, toolkit=None, limit=10) -> list  # discover tool slugs by use case
  .schema(slug) -> dict                              # full JSON schema for one slug
  .execute(slug, args=None, *,                       # run one tool
           connected_account_id=None) -> dict        # → {successful, data, error}
  .multi_execute(calls, *, parallelism=8) -> list    # run many in parallel
                                                      # calls: [{slug, args, connected_account_id?}]

All methods are async — `await` everything. Errors return
`{"error": "http_4xx", "detail": "..."}` instead of raising; check
`isinstance(res, dict) and "error" in res`."""


# What the sandbox is, what's preinstalled, what auth looks like.
# Embedded by every agent that runs sandbox code (all 5 of them).
# The cheat sheet is inlined here so the FIRST tool call has the full
# SDK shape — fixes the observed pattern of agents inventing methods
# (raw.slack.messages / raw.github.commits / signals.upsert) on the
# first gather, then burning 5+ rounds on dir() / inspect introspection.
SANDBOX_PREAMBLE = f"""\
<sandbox>
You have a sandbox where you can write and run Python. The
`pinai_sdk` module is preinstalled with auth pre-injected — just
import and call:

    from pinai_sdk import client
    rows = await client.memory.list(min_quality=0.7, limit=30)
    signals = await client.signals.recent(status="open", hours=24)

The chat-driving JWT and the user's virtual_key are NOT in the
sandbox — the SDK uses an opaque per-sandbox token.

The sandbox can also reach the public internet via httpx (e.g. for
fetching a URL the user mentioned) but no other internal hosts.

<sdk_surface>
{_SDK_CHEAT_SHEET}
</sdk_surface>
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
