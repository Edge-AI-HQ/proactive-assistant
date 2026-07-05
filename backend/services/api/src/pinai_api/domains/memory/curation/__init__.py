"""④ Curation — evolve 的 api 侧:运行审计 + agent/ui 面(design doc 八节)。

LLM 蒸馏本体住 agent-engine(agents/evolve + rollup_semantic 编排);本包是
它在信任侧的落点:pai_evolution_runs 审计(provenance:refs_consumed /
refs_produced)+ 触发/历史的 agent/ui 路由。调度经 orchestration(task kind
`auto.dreaming` / 路由 `run/dream` 是 daily evolve 的 legacy 命名)。

接口稳定性:stable。藏在模块内的决策(可自由改):审计字段形态、run 摘要。
"""

from .runs import EvolutionRepository, EvolutionRunRow

__all__ = ["EvolutionRepository", "EvolutionRunRow"]
