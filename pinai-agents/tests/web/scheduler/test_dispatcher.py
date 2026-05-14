from typing import Any, cast

from pinai_agents.web.scheduler.dispatcher import DefaultDispatcher


def test_generator_tasks_use_long_running_lease():
    dispatcher = DefaultDispatcher(pool=cast(Any, None), lease_seconds=60)

    assert dispatcher._lease_for("generator.manual") == 600
    assert dispatcher._lease_for("generator.auto") == 600
