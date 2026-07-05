"""③ Events — L1 事件流:存储 + 统一检索(design doc 六节)。

一个模块两个接口面(读写共享 supersede / curated 不变量,不拆):
  * 写面 — append(dedupe 幂等)/ supersede / mark_curated(evolve 队列交接)
  * 读面 — search_structured / search_semantic / search_hybrid(events_search,
    客观排序 + reference bump)

接口稳定性:模块间 stable(改动同步 design doc);对 agent 的工具面
(events_search / event_append)与对消费者的检索面是 frozen。
藏在模块内的决策(可自由改):排序公式、RRF 融合、bump 策略、索引、dedupe。
"""

from .repository import AppendEventInput, EventRow, EventsRepository, gen_event_id

__all__ = ["AppendEventInput", "EventRow", "EventsRepository", "gen_event_id"]
