"""tavily_search — Tavily web search via langchain_tavily partner package.

Replaces the previous `web_fetch` tool. Tavily returns top-K results
with snippets, which covers most chat questions ("what's X", "search
for Y") without a separate fetch step. If the agent later needs full
page content, write a Python script in its sandbox and use httpx
(`write_file('/tmp/fetch.py', ...) + execute('python3 /tmp/fetch.py')`).

Configuration:
- `TAVILY_API_KEY` must be set in the chat process env. Provisioned via
  `dotenvx set TAVILY_API_KEY <key> -f pinai-agents/.env.dev`. Get a
  key at https://www.tavily.com/ (free tier: 1k searches / month).
- `include_raw_content=False` keeps results to snippets only — saves
  context tokens. The LLM can fetch raw content via the
  write_file+execute pattern if it really needs it.
- `topic="general"` is the default; `news` is also valid for time-
  sensitive queries — TavilySearch exposes `topic` as a per-call arg.
"""

from __future__ import annotations

from langchain_tavily import TavilySearch

# Module-level singleton — picks up TAVILY_API_KEY from os.environ at
# import time (TavilySearch validates the key in __init__). Chat module
# import will fail loudly if the key is missing — same posture as
# Daytona / Browserbase keys. dotenvx-decrypted via `make ensure-env`,
# then `make ensure-env-pinai-agents` flows it into .env.chat.
tavily_search = TavilySearch(
    max_results=5,
    topic="general",
    include_raw_content=False,
)
