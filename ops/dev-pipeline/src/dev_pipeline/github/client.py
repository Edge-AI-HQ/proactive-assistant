"""GitHub client（gh CLI 封装）。

单一子进程 seam = `_run`，测试注入 fake runner，不打真 gh。
查 PR + CI 结论，喂给状态机决定 CI_PASSED / CI_FAILED。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

Runner = Callable[[Sequence[str]], str]


class CIStatus(StrEnum):
    PENDING = "pending"
    PASS = "pass"
    FAIL = "fail"
    NONE = "none"


@dataclass
class PullRequest:
    number: int
    url: str
    branch: str
    state: str  # OPEN / MERGED / CLOSED
    ci: CIStatus


def _default_runner(args: Sequence[str]) -> str:
    return subprocess.run(  # noqa: S603
        list(args), capture_output=True, text=True, check=True
    ).stdout


class GitHubClient:
    def __init__(self, repo: str, runner: Runner | None = None) -> None:
        self._repo = repo
        self._run: Runner = runner or _default_runner

    def find_pr_by_branch(self, branch: str) -> PullRequest | None:
        out = self._run(
            [
                "gh", "pr", "list", "--repo", self._repo, "--head", branch,
                "--state", "all", "--limit", "1",
                "--json", "number,url,headRefName,state,statusCheckRollup",
            ]
        )
        rows = json.loads(out) if out.strip() else []
        if not rows:
            return None
        return _parse_pr(rows[0])

    def find_pr_for_issue(self, identifier: str) -> PullRequest | None:
        """按 Linear 标识(如 EDG-5)搜 PR —— Codex 开的 PR 会在标题/正文/分支引用它。"""
        out = self._run(
            [
                "gh", "pr", "list", "--repo", self._repo, "--search", identifier,
                "--state", "all", "--limit", "1",
                "--json", "number,url,headRefName,state,statusCheckRollup",
            ]
        )
        rows = json.loads(out) if out.strip() else []
        return _parse_pr(rows[0]) if rows else None

    def get_pr(self, number: int) -> PullRequest | None:
        out = self._run(
            [
                "gh", "pr", "view", str(number), "--repo", self._repo,
                "--json", "number,url,headRefName,state,statusCheckRollup",
            ]
        )
        if not out.strip():
            return None
        return _parse_pr(json.loads(out))

    def trigger_preview(self, pr_number: int) -> None:
        """触发 Fly preview workflow（.github/workflows/preview.yml）给指定 PR 起临时环境。

        workflow 自己 deploy 到 pinai-pr-<N>.fly.dev 并回贴 URL 到该 PR；PR 关闭时
        preview-cleanup.yml 自动销毁。这里只负责按一下按钮。
        """
        self._run(
            [
                "gh", "workflow", "run", "preview.yml",
                "--repo", self._repo, "-f", f"pr={pr_number}",
            ]
        )

    def trigger_teardown(self, pr_number: int) -> None:
        """触发 preview-down workflow，销毁该 PR 的临时 preview app（前端 + 后端副本）。
        对称于 trigger_preview；不关 PR 也能随时拆。"""
        self._run(
            [
                "gh", "workflow", "run", "preview-down.yml",
                "--repo", self._repo, "-f", f"pr={pr_number}",
            ]
        )


def _parse_pr(row: dict[str, Any]) -> PullRequest:
    return PullRequest(
        number=int(row["number"]),
        url=str(row["url"]),
        branch=str(row.get("headRefName", "")),
        state=str(row.get("state", "OPEN")),
        ci=_rollup_to_ci(row.get("statusCheckRollup")),
    )


def _rollup_to_ci(rollup: object) -> CIStatus:
    """statusCheckRollup 是 check 列表；任一 FAILURE→fail，有 pending→pending，全 success→pass。"""
    if not isinstance(rollup, list) or not rollup:
        return CIStatus.NONE
    states = []
    for check in rollup:
        if not isinstance(check, dict):
            continue
        # check run 用 'conclusion'+'status'，status context 用 'state'
        states.append(str(check.get("conclusion") or check.get("state") or "").upper())
    if any(s in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT") for s in states):
        return CIStatus.FAIL
    if any(s in ("", "PENDING", "IN_PROGRESS", "QUEUED") for s in states):
        return CIStatus.PENDING
    return CIStatus.PASS
