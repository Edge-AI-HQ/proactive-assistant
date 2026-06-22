"""GitHubClient：注入 fake runner，验证 PR 解析 + CI rollup 归类。"""

from __future__ import annotations

import json
from collections.abc import Sequence

from dev_pipeline.github.client import CIStatus, GitHubClient


def _runner_returning(payload: object):
    def run(args: Sequence[str]) -> str:
        return json.dumps(payload)
    return run


def test_find_pr_by_branch_parses_pass() -> None:
    gh = GitHubClient(
        "Edge-AI-HQ/PIN-AI-ASSISTANT",
        runner=_runner_returning(
            [
                {
                    "number": 7,
                    "url": "https://github.com/x/y/pull/7",
                    "headRefName": "dev-pipeline/EDG-42",
                    "state": "OPEN",
                    "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "SUCCESS"}],
                }
            ]
        ),
    )
    pr = gh.find_pr_by_branch("dev-pipeline/EDG-42")
    assert pr is not None
    assert pr.number == 7
    assert pr.ci is CIStatus.PASS


def test_ci_rollup_fail_and_pending() -> None:
    gh_fail = GitHubClient(
        "x/y",
        runner=_runner_returning(
            [{"number": 1, "url": "u", "headRefName": "b", "state": "OPEN",
              "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}]}]
        ),
    )
    assert gh_fail.find_pr_by_branch("b").ci is CIStatus.FAIL  # type: ignore[union-attr]

    gh_pending = GitHubClient(
        "x/y",
        runner=_runner_returning(
            [{"number": 1, "url": "u", "headRefName": "b", "state": "OPEN",
              "statusCheckRollup": [{"status": "IN_PROGRESS"}]}]
        ),
    )
    assert gh_pending.find_pr_by_branch("b").ci is CIStatus.PENDING  # type: ignore[union-attr]


def test_find_pr_none_when_empty() -> None:
    gh = GitHubClient("x/y", runner=_runner_returning([]))
    assert gh.find_pr_by_branch("nope") is None
