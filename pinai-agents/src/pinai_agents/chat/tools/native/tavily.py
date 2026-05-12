"""tavily_search + tavily_extract — Tavily web tools via langchain_tavily.

Two complementary tools:
- `tavily_search` for "what's X / look up Y" — returns ranked snippets,
  covers most chat questions without a separate fetch step.
- `tavily_extract` for "read these URLs in full" — pass 1-20 URLs,
  get back markdown/text. Preferred over a sandbox httpx script for
  search→read flows: batched, no sandbox spin-up, results are clean
  markdown ready to feed back into the LLM.

Configuration:
- `TAVILY_API_KEY` must be set in the chat process env. Provisioned via
  `dotenvx set TAVILY_API_KEY <key> -f pinai-agents/.env.dev`. Get a
  key at https://www.tavily.com/ (free tier: 1k searches / month).
- Search: `include_raw_content=False` keeps results to snippets only —
  saves context tokens. `topic="general"` default; `news` is valid for
  time-sensitive queries (per-call arg on TavilySearch).
- Extract: `extract_depth="basic"` (1 credit / 5 URLs); LLM can pass
  `extract_depth="advanced"` per call to pull tables / embedded content
  (2x credits, slower). `format="markdown"` keeps output consistent
  with the rest of the chat surface.
"""

from __future__ import annotations

from langchain_tavily import TavilyExtract, TavilySearch

# Module-level singletons — pick up TAVILY_API_KEY from os.environ at
# import time (langchain_tavily validates the key in __init__). Chat
# module import will fail loudly if the key is missing — same posture
# as Daytona / Browserbase keys. dotenvx-decrypted via `make ensure-env`,
# then `make ensure-env-pinai-agents` flows it into .env.chat.
tavily_search = TavilySearch(
    max_results=5,
    topic="general",
    include_raw_content=False,
)

tavily_extract = TavilyExtract(
    extract_depth="basic",
    format="markdown",
    include_images=False,
)
