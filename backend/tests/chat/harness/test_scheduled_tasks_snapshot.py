"""render_scheduled_tasks — prospective-memory 快照的有界渲染(design §三)。"""

from __future__ import annotations

from agent_engine.harness.middleware import (
    _SCHEDULE_SNAPSHOT_CAP,
    render_scheduled_tasks,
)


def _task(i: int, **overrides) -> dict:
    return {
        "id": f"sched.gen.{i}",
        "title": f"task {i}",
        "status": "active",
        "scheduleLabel": "daily 08:00",
        "nextRunAt": "2026-07-03T08:00:00+08:00",
        **overrides,
    }


def test_empty_list_renders_nothing() -> None:
    # 空列表不注入任何块(省 token;agent 仍可调 list 工具)。
    assert render_scheduled_tasks([]) == ""


def test_renders_one_line_per_task_with_cadence_and_next_run() -> None:
    out = render_scheduled_tasks([_task(1)])
    assert "<scheduled_tasks>" in out
    assert "- [sched.gen.1] task 1 — daily 08:00 (next: 2026-07-03T08:00:00+08:00)" in out
    assert "scheduled_generator_" in out  # 管理工具指引


def test_falls_back_to_frequency_and_marks_paused() -> None:
    out = render_scheduled_tasks(
        [_task(1, scheduleLabel=None, frequency="weekly", localTime="09:30", status="paused")]
    )
    assert "weekly 09:30" in out
    assert "[paused]" in out


def test_caps_and_reports_overflow() -> None:
    items = [_task(i) for i in range(_SCHEDULE_SNAPSHOT_CAP + 3)]
    out = render_scheduled_tasks(items)
    assert out.count("- [sched.gen.") == _SCHEDULE_SNAPSHOT_CAP
    assert "and 3 more" in out
