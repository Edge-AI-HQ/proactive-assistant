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
  `dotenvx set TAVILY_API_KEY <key> -f backend/.env.dev`. Get a
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

import math
from typing import Any

from langchain_core.tools import ToolException
from langchain_tavily import TavilyExtract, TavilySearch

from ..usage_report import report_metered_usage


def _raise_on_error_payload(result: dict[str, Any]) -> dict[str, Any]:
    """langchain_tavily swallows API failures into a normal `{"error": e}`
    return value (only EMPTY results raise ToolException) — so a quota/auth
    outage came back as status=ok and the agent kept retrying blind (prod:
    30x "Error 432" all green). Re-raise so handle_tool_error=True turns it
    into a real status="error" ToolMessage the agent and UI can see.
    """
    if isinstance(result, dict) and "error" in result:
        raise ToolException(f"tavily request failed: {result['error']}")
    return result


class _TavilySearch(TavilySearch):
    def _run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        result = _raise_on_error_payload(super()._run(*args, **kwargs))
        _report_tavily_search_usage(args=args, kwargs=kwargs)
        return result

    async def _arun(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        result = _raise_on_error_payload(await super()._arun(*args, **kwargs))
        _report_tavily_search_usage(args=args, kwargs=kwargs)
        return result


class _TavilyExtract(TavilyExtract):
    def _run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        result = _raise_on_error_payload(super()._run(*args, **kwargs))
        _report_tavily_extract_usage(result, args=args, kwargs=kwargs)
        return result

    async def _arun(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        result = _raise_on_error_payload(await super()._arun(*args, **kwargs))
        _report_tavily_extract_usage(result, args=args, kwargs=kwargs)
        return result


def _report_tavily_search_usage(*, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
    depth = _arg_value("search_depth", args=args, kwargs=kwargs) or "basic"
    credits = 2 if str(depth).lower() == "advanced" else 1
    report_metered_usage(
        provider="tavily",
        product="tavily_search",
        api_credits=credits,
        source="tavily:search",
        metadata={"search_depth": str(depth).lower()},
    )


def _report_tavily_extract_usage(
    result: dict[str, Any], *, args: tuple[Any, ...], kwargs: dict[str, Any]
) -> None:
    depth = _arg_value("extract_depth", args=args, kwargs=kwargs) or "basic"
    url_count = _successful_extract_url_count(result) or _requested_url_count(
        args=args, kwargs=kwargs
    )
    if url_count <= 0:
        return
    credits_per_batch = 2 if str(depth).lower() == "advanced" else 1
    credits = math.ceil(url_count / 5) * credits_per_batch
    report_metered_usage(
        provider="tavily",
        product="tavily_extract",
        api_credits=credits,
        source="tavily:extract",
        metadata={"extract_depth": str(depth).lower(), "url_count": url_count},
    )


def _arg_value(name: str, *, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
    if name in kwargs:
        return kwargs[name]
    for arg in args:
        if isinstance(arg, dict) and name in arg:
            return arg[name]
    return None


def _requested_url_count(*, args: tuple[Any, ...], kwargs: dict[str, Any]) -> int:
    urls = _arg_value("urls", args=args, kwargs=kwargs)
    if isinstance(urls, str):
        return 1
    if isinstance(urls, list):
        return len([u for u in urls if isinstance(u, str) and u.strip()])
    return 0


def _successful_extract_url_count(result: dict[str, Any]) -> int:
    items = result.get("results")
    if not isinstance(items, list):
        return 0
    return len([item for item in items if isinstance(item, dict) and not item.get("error")])


# Module-level singletons — pick up TAVILY_API_KEY from os.environ at
# import time (langchain_tavily validates the key in __init__). Chat
# module import will fail loudly if the key is missing — same posture
# as Daytona / Browserbase keys. dotenvx-decrypted via `make ensure-env`,
# then `make ensure-env-backend` flows it into .env.chat.
tavily_search = _TavilySearch(
    max_results=5,
    topic="general",
    include_raw_content=False,
)

tavily_extract = _TavilyExtract(
    extract_depth="basic",
    format="markdown",
    include_images=False,
)
