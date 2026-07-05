"""② Projection — L0→L1 规则投影,临界路径零 LLM(design doc 四节)。

个人域管线的投影 stage:projector(1 raw → 1 event)+ rollup off/window 档
(semantic 档住 agent-engine 的 rollup_semantic,声明共享
pinai_contracts.rollup_policy)。幂等:source_ref 已投影即跳过,dedupe 撞键
no-op,可对历史 raw backfill。

接口稳定性:stable。藏在模块内的决策(可自由改):(toolkit, entity)→
event_type map、rollup 档位、window 聚合函数。
"""

from .projector import project_unprojected, raw_to_event_input

__all__ = ["project_unprojected", "raw_to_event_input"]
