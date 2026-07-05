"""Lifelong-memory 系统(modular monolith)— 设计 SSOT:
docs/plans/2026-06-23-lifelong-memory-system.mdx §十一 模块地图。

api 侧四子包:events(③ L1 存储+检索)/ projection(② L0→L1 投影)/
portrait(⑤ L2 画像)/ curation(④ evolve 的 api 侧)。① Ingest 住
connector domain,⑥ World 住 connector/world(独立写管线)。
"""
