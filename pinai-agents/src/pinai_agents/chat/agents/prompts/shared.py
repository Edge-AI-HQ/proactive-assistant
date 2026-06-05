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
  .kinds(*, status="all", hours=None) -> list       # discover what kinds exist
                                                     # → [{kind, count, latestAt, latestTitle, latestSummaryPreview}]
  .recent(*, status="open", kind=None, hours=24,
          min_salience=None, limit=30,
          include_payload=False) -> list            # status: open|consumed|archived|all
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
  .merge_preference(*, key, value) -> dict           # safe one-key merge into profile.preferences
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
        limit=50, offset=0, dedupe_key=None) -> list # pass hours OR since, not both
  .gmail.recent(*, hours=24, limit=20) -> list       # convenience
  .gcal.today(*, hours=48, limit=20) -> list         # convenience
  # other toolkits: use .list("slack","messages"), .list("github","issues"),
  #                 .list("gdrive","files"), .list("calendly","events"), ...
  # client.raw.slack / .github / etc DO NOT EXIST — use .list(...)

Supported (toolkit, entity) for raw.list:
  gmail/messages, gcal/events, gdrive/files, slack/messages,
  github/issues, calendly/events, stripe/invoices,
  youtube/subscriptions, linkedin/profile,
  device/{apps,contacts,health}

client.composio                                      # live SaaS access via Composio Tool Router
  .connections() -> list                             # ACTIVE connected toolkits for the user
  .search(query, *, toolkit=None, limit=10) -> list  # discover tool slugs by use case
  .schema(slug) -> dict                              # full JSON schema for one slug
  .execute(slug, args=None, *,                       # run one tool
           connected_account_id=None) -> dict        # → {successful, data, error}
  .multi_execute(calls, *, parallelism=8) -> list    # run many in parallel
                                                      # calls: [{slug, args, connected_account_id?}]

client.preferences                                   # high-weight stated preferences (main-chat)
  .list(*, status="active", scope=None, limit=50) -> list  # newest first; read active for generation
  .add(*, statement, scope, polarity, weight=None,   # source stamped server-side, not here
       confidence=None, durability="persistent",
       expires_at=None, evidence=None) -> dict        # scope: topic|source|timing|format|global
                                                      # polarity: positive|negative
  .supersede(*, old_id, new_id) -> dict | None       # new_id must already be active

client.settings                                      # user settings the agent may change
  .set_generation_language(language) -> dict         # 'en' | 'zh-Hans' | ...; deterministic, re-stamps schedule

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


# Two-paradigm tool choice (direct vs Code Mode) + how to write a
# sandbox script. Direct, no mechanical "write_file + execute"
# prescription — DeepAgents tool descriptions cover the mechanics.
CODE_MODE_GUIDANCE = """\
<tool_paradigm>
You can act two ways — choose per task:
- Direct tool calls (memory_search / signals_recent / Composio meta / …):
  single-step, immediate, and the user sees each step. DEFAULT to these for
  everyday lookups, single reads/writes, and anything the user should review.
- Code Mode (write Python in your sandbox, `from pinai_sdk import client`):
  for multi-source aggregation (3+ sources), batch processing, filtering or
  reducing a large intermediate result, or loop/conditional logic — one
  script runs it all and returns only the conclusion.
Trade-off: a thread's sandbox is reused, but the FIRST Code Mode call in a
thread pays a few-seconds cold start and the user can't see inside the
sandbox. Don't reach for Code Mode when a direct call or two already does
the job.
</tool_paradigm>

<code_mode>
When you do use Code Mode, write one script that does everything in one
shot — typically:

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

One script = one round-trip beats N separate SDK calls. Truncate large
outputs in `print` — your context window is the bottleneck, not the SDK.
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

For ambient transcript signals, speaker attribution is part of the
evidence. `self:` lines and `payload.self_text` are the user's own
speech and should carry extra weight as stated intent. Other speaker
labels are context only; never attribute non-self speech to the user.
</grounding>"""


# Parallel reads + post-result reflection + multi-step planning. These
# are the Anthropic Sonnet-4.6 harness-tuning snippets
# (use_parallel_tool_calls / tool_result_reflection) DeepAgents would
# inject as a system_prompt_suffix for a `claude-sonnet-4-6` model — but
# only when the model is a ChatAnthropic instance. pinai routes through
# LiteLLM as ChatOpenAI, so the harness profile never matches and the
# suffix never lands (see plan 2026-06-01 §12 verification 2); we carry
# the equivalent here, adapted to the assistant's tools, plus the
# `write_todos` planning nudge. The third snippet
# (investigate_before_answering) is already covered by GROUNDING_POLICY.
TOOL_DISCIPLINE = """\
<tool_discipline>
Parallelize independent reads. When you need several pieces of context
that don't depend on each other — e.g. recent signals AND a memory
search AND today's calendar — make those tool calls in the same turn so
they run together instead of one after another. Only chain calls
sequentially when a later call needs a value an earlier one returns.
Never guess or placeholder a parameter just to force parallelism.

Reflect on results before the next step. After a tool returns, read
what actually came back and pick the best next action — don't fire the
next call on autopilot. Pay extra attention when a result is empty,
errored, or contradicts what you expected.

Plan multi-step work with todos. For a task with several distinct steps
(gather → draft → act, or a multi-part request), call `write_todos`
first to lay out the steps and keep it updated as you go — the user
sees the plan and your progress. Skip it for single-step asks; don't
narrate trivial work as todos.
</tool_discipline>"""
