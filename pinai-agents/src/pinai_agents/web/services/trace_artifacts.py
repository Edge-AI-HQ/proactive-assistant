"""LangSmith trace to deterministic dashboard artifact.

The first reward dashboard iteration stores a structure the UI can render
and re-render. The SVG is intentionally plain: its value is repeatable
debugging, not illustration.
"""

from __future__ import annotations

import html
import os
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from langsmith import Client

from ...config import get_web_settings
from ..db.repositories.reward import RewardRepository

STAGES = ("data-collector", "planner", "card-generator", "evaluator")
DATA_SOURCES = ("profile", "memory", "signals", "gmail", "gcal", "cards_recent", "feedback", "world")


def _clip(value: Any, limit: int = 500) -> str:
    text = "" if value is None else str(value)
    return text if len(text) <= limit else text[: limit - 1] + "..."


def _run_to_node(run: Any) -> dict[str, Any]:
    return {
        "id": str(getattr(run, "id", "")),
        "traceId": str(getattr(run, "trace_id", "") or ""),
        "parentRunId": str(getattr(run, "parent_run_id", "") or ""),
        "url": getattr(run, "url", None),
        "name": getattr(run, "name", "") or "",
        "runType": getattr(run, "run_type", "") or "",
        "startTime": _iso(getattr(run, "start_time", None)),
        "endTime": _iso(getattr(run, "end_time", None)),
        "error": getattr(run, "error", None),
        "inputsPreview": _clip(getattr(run, "inputs", None), 600),
        "outputsPreview": _clip(getattr(run, "outputs", None), 800),
        "metadata": getattr(run, "extra", None) or {},
    }


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _stages_for_text(text: str) -> list[str]:
    lowered = text.lower()
    stages: list[str] = []
    for stage in STAGES:
        if stage in lowered:
            stages.append(stage)
    # DeepAgents records subagent dispatches as generic `task` tool calls;
    # the subagent type only appears inside the serialized input/output.
    if "subagent_type" in lowered or "subagent type" in lowered:
        if "data" in lowered and "collector" in lowered:
            stages.append("data-collector")
        if "planner" in lowered:
            stages.append("planner")
        if "card" in lowered and "generator" in lowered:
            stages.append("card-generator")
        if "evaluator" in lowered:
            stages.append("evaluator")
    return list(dict.fromkeys(stages))


def _node_text(node: dict[str, Any]) -> str:
    return " ".join(
        str(node.get(key) or "")
        for key in ("name", "inputsPreview", "outputsPreview", "error")
    )


def _stage_snippet(text: str, stage: str) -> str | None:
    lowered = text.lower()
    for needle in (stage, "phase1", "skipped", "pass", "overall", "feedback"):
        idx = lowered.find(needle)
        if idx >= 0:
            return _clip(text[max(0, idx - 120): idx + 420], 500)
    return None


def _summarize(nodes: Sequence[dict[str, Any]]) -> dict[str, Any]:
    stages: dict[str, dict[str, Any]] = {
        stage: {"seen": False, "nodes": 0, "errors": [], "snippets": []}
        for stage in STAGES
    }
    data_sources: set[str] = set()
    skipped_intents: list[str] = []
    evaluator_verdicts: list[str] = []
    tools: list[str] = []
    errors: list[str] = []
    for node in nodes:
        text = _node_text(node)
        node_stages = _stages_for_text(text)
        for stage in node_stages:
            stages[stage]["seen"] = True
            stages[stage]["nodes"] += 1
            snippet = _stage_snippet(text, stage)
            if snippet and len(stages[stage]["snippets"]) < 3:
                stages[stage]["snippets"].append(snippet)
        if node.get("runType") == "tool" and node.get("name"):
            tools.append(str(node["name"]))
        lowered = text.lower()
        if "data-collector" in node_stages:
            data_sources.update(source for source in DATA_SOURCES if source in lowered)
        if "planner" in node_stages and (
            "skipped" in lowered or "skip" in lowered or "跳过" in text
        ):
            skipped_intents.append(_clip(text, 500))
        if "evaluator" in node_stages and ("pass" in lowered or "overall" in lowered):
            evaluator_verdicts.append(_clip(text, 500))
        if node.get("error"):
            error = _clip(node["error"], 300)
            errors.append(error)
            for stage in node_stages:
                stages[stage]["errors"].append(error)
    missing_stages = [stage for stage, payload in stages.items() if not payload["seen"]]
    return {
        "stages": stages,
        "missingStages": missing_stages,
        "dataSources": sorted(data_sources),
        "skippedIntents": skipped_intents[:5],
        "evaluatorVerdicts": evaluator_verdicts[:5],
        "weakestCard": evaluator_verdicts[-1] if evaluator_verdicts else None,
        "tools": sorted(set(tools)),
        "errors": errors,
        "nodeCount": len(nodes),
    }


def _svg(summary: dict[str, Any]) -> str:
    width = 980
    height = 260
    x0 = 52
    gap = 226
    boxes: list[str] = []
    arrows: list[str] = []
    for idx, stage in enumerate(STAGES):
        x = x0 + idx * gap
        payload = summary["stages"][stage]
        seen = bool(payload["seen"])
        errored = bool(payload["errors"])
        fill = "#ecfdf5" if seen and not errored else "#fff7ed" if seen else "#f8fafc"
        stroke = "#059669" if seen and not errored else "#c2410c" if errored else "#94a3b8"
        label = stage
        status = "ready" if seen and not errored else "error" if errored else "missing"
        boxes.append(
            f'<rect x="{x}" y="76" width="170" height="96" rx="8" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="2"/>'
        )
        boxes.append(
            f'<text x="{x + 16}" y="112" font-family="Inter,Arial" '
            f'font-size="15" font-weight="700" fill="#0f172a">{html.escape(label)}</text>'
        )
        boxes.append(
            f'<text x="{x + 16}" y="140" font-family="Inter,Arial" '
            f'font-size="13" fill="#475569">{status} - {payload["nodes"]} nodes</text>'
        )
        if idx < len(STAGES) - 1:
            ax = x + 178
            arrows.append(
                f'<path d="M {ax} 124 L {ax + 38} 124" stroke="#64748b" '
                f'stroke-width="2" marker-end="url(#arrow)"/>'
            )
    source_text = ", ".join(summary.get("dataSources") or []) or "no data source summary"
    error_text = "; ".join(summary["errors"][:2]) or f"Sources: {source_text}"
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        "<defs><marker id=\"arrow\" markerWidth=\"8\" markerHeight=\"8\" refX=\"5\" "
        "refY=\"3\" orient=\"auto\" markerUnits=\"strokeWidth\">"
        "<path d=\"M0,0 L0,6 L6,3 z\" fill=\"#64748b\"/></marker></defs>"
        '<rect width="100%" height="100%" fill="#ffffff"/>'
        '<text x="52" y="38" font-family="Inter,Arial" font-size="18" '
        'font-weight="800" fill="#0f172a">Generation trace</text>'
        f'{"".join(arrows)}{"".join(boxes)}'
        '<text x="52" y="218" font-family="Inter,Arial" font-size="13" '
        f'fill="#475569">{html.escape(error_text)}</text>'
        "</svg>"
    )


def _client() -> Client | None:
    settings = get_web_settings()
    api_key = settings.langsmith_api_key
    if not api_key:
        return None
    os.environ.setdefault("LANGSMITH_API_KEY", api_key)
    os.environ.setdefault("LANGCHAIN_API_KEY", api_key)
    return Client(api_key=api_key, api_url=settings.langsmith_endpoint)


class TraceArtifactService:
    def __init__(self, repo: RewardRepository) -> None:
        self._repo = repo

    async def get_or_generate(self, run_id: str, *, force: bool = False) -> dict[str, Any]:
        canonical_run_id = await self._repo.resolve_run_id(run_id)
        if canonical_run_id is None:
            msg = "run not found"
            raise LookupError(msg)

        if not force:
            existing = await self._repo.get_trace_artifact(canonical_run_id)
            if existing is not None and existing["status"] in {"ready", "missing", "failed"}:
                return existing

        client = _client()
        settings = get_web_settings()
        if client is None:
            return await self._repo.upsert_trace_artifact(
                run_id=canonical_run_id,
                status="missing",
                summary={"reason": "LANGSMITH_API_KEY is not configured"},
                error="LANGSMITH_API_KEY is not configured",
            )

        try:
            root_runs = list(client.list_runs(
                project_name=settings.langsmith_project,
                filter=(
                    "and("
                    "eq(metadata_key, 'pinai_run_id'), "
                    f"eq(metadata_value, '{canonical_run_id}')"
                    ")"
                ),
                is_root=True,
                start_time=datetime.now(UTC) - timedelta(days=7),
                limit=1,
            ))
        except Exception as e:
            return await self._repo.upsert_trace_artifact(
                run_id=canonical_run_id,
                status="failed",
                summary={"reason": "LangSmith query failed"},
                error=f"{type(e).__name__}: {e}",
            )

        if not root_runs:
            return await self._repo.upsert_trace_artifact(
                run_id=canonical_run_id,
                status="missing",
                summary={
                    "reason": "No LangSmith root trace matched pinai_run_id metadata",
                    "metadata": {
                        "requested_run_id": run_id,
                        "pinai_run_id": canonical_run_id,
                        "pinai_agent": "generator",
                    },
                },
                error="No LangSmith root trace matched pinai_run_id metadata",
            )

        root = root_runs[0]
        trace_id = str(getattr(root, "trace_id", None) or getattr(root, "id", ""))
        langsmith_url = getattr(root, "url", None)
        try:
            runs = list(client.list_runs(
                project_name=settings.langsmith_project,
                trace_id=trace_id,
                start_time=datetime.now(UTC) - timedelta(days=7),
                limit=100,
            ))
        except Exception as e:
            return await self._repo.upsert_trace_artifact(
                run_id=canonical_run_id,
                status="failed",
                langsmith_trace_id=trace_id,
                summary={"reason": "LangSmith child run query failed"},
                error=f"{type(e).__name__}: {e}",
            )

        nodes = [_run_to_node(r) for r in runs]
        summary = _summarize(nodes)
        svg = _svg(summary)
        trace_tree = {
            "rootRunId": str(getattr(root, "id", "")),
            "traceId": trace_id,
            "langsmithUrl": langsmith_url,
            "nodes": nodes,
            "svg": svg,
        }
        summary["langsmithUrl"] = langsmith_url
        return await self._repo.upsert_trace_artifact(
            run_id=canonical_run_id,
            status="ready",
            langsmith_trace_id=trace_id,
            trace_tree=trace_tree,
            summary=summary,
            image_format="svg",
            image_path=f"inline-svg:{canonical_run_id}",
            error=None,
        )
