"""Device ingest recipes — 每个 device kind 一条声明式配置。

取代原先散在四处的 per-kind dispatch:
  * policies.py `DEVICE_INGEST_POLICIES`  (kind → mode)
  * policies.py `_CONTEXT_ENTITY_TYPE`    (kind → entity_type)
  * pinai_contracts.rollup_policy          (entity → rollup 档，P3 collapse 进来)
  * event_projector._DEVICE_NO_PROJECT     (entity → 投不投，P3 收编)

一个 kind 只走一条 recipe:归一化到 `entity_type`(= pai_raw_device.kind)、标记
是否 `filtered`(卡子:接受但不落库)、是否 `latest_wins`(transcript window 增长
→ 覆盖更新)、是否 `snapshot`(apps/contacts/health 需专门解析 + full-replace)。
加一个新 device kind = 加一条 recipe,不改 dispatch 代码。

真实起点(见 docs/plans/2026-06-30-device-ingest-unification.mdx):存储早已统一进单
表 pai_raw_device(118 删 typed 表 / 119 拆域表),snapshot 的 apps/contacts/health 也
早就写 pai_raw_device(raw_device.ingest_apps/contacts/health)。所以本模块只是把入口
层的 kind→行为 映射从散落的硬编码收成一处,并让 dispatch 不再经"指向已删表名的
DeviceRawWrite + _apply_raw_write"死抽象。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SnapshotKind = Literal["apps", "contacts", "health"]


@dataclass(slots=True, frozen=True)
class DeviceRecipe:
    """一个 device kind 的入口处理规则。"""

    # 归一化后的 pai_raw_device.kind(投影管线的 entity)。signal_only/snapshot 都用它。
    entity_type: str
    # 接受但不落库(卡子:deprecated / 暂抑制的 kind,server 端 drop 不进 outbox)。
    filtered: bool = False
    # 覆盖更新(ON CONFLICT DO UPDATE):transcript window 随更多音频增长,latest-wins。
    latest_wins: bool = False
    # snapshot 源:需专门解析(bundle_id / metric) + full-sync 按 device 整体替换,
    # 走 raw_device.ingest_<snapshot> / replace_<snapshot>。None = 普通 context event。
    snapshot: SnapshotKind | None = None


# 未知 kind 兜底:落 context event,不丢数据(带 ingest_fallback_reason marker)。
UNKNOWN_RECIPE = DeviceRecipe(entity_type="context")

# device.media.* 前缀族:统一当 context event(见 resolve_recipe)。
_MEDIA_PREFIX_RECIPE = DeviceRecipe(entity_type="context")


DEVICE_RECIPES: dict[str, DeviceRecipe] = {
    # ── 语音会话(实时 1→1 投 utterance event,2026-06-30 起) ──
    "ambient.utterance": DeviceRecipe("utterance"),
    "session_summary": DeviceRecipe("utterance"),
    # ── 证据窗口(firehose,latest-wins + semantic rollup;不 1→1 投) ──
    "ambient.candidate_window": DeviceRecipe("transcript_window", latest_wins=True),
    # ── 位置/到访/运动/日历/专注(实时投,各自 entity) ──
    "ambient.visit": DeviceRecipe("visit"),
    "device.visit": DeviceRecipe("visit"),
    "device.motion_segment": DeviceRecipe("motion"),
    "device.sound_scene_run": DeviceRecipe("motion"),
    "ambient.calendar_event": DeviceRecipe("calendar"),
    "device.calendar_event": DeviceRecipe("calendar"),
    "ambient.focus_state": DeviceRecipe("focus"),
    "device.focus_state": DeviceRecipe("focus"),
    "ambient.audio_route": DeviceRecipe("focus"),
    "device.audio_route": DeviceRecipe("focus"),
    # ── DATA-FLOW OPEN (2026-06-30):放开的 sensor,落 context → 投 interaction。
    #    收紧 = 把某条改成 DeviceRecipe("context", filtered=True)。 ──
    "ambient.location": DeviceRecipe("context"),
    "device.location": DeviceRecipe("context"),
    "ambient.activity": DeviceRecipe("context"),
    "device.activity": DeviceRecipe("context"),
    "ambient.sound": DeviceRecipe("context"),
    "device.sound_classification": DeviceRecipe("context"),
    "ambient.device_state": DeviceRecipe("context"),
    "device.device_state": DeviceRecipe("context"),
    # ── ambient.health:deprecated alias,filtered。真 health 走 health.observation
    #    (snapshot,typed 解析 + window rollup),放开会双写。 ──
    "ambient.health": DeviceRecipe("context", filtered=True),
    # ── legacy context kinds(V2 ambient / 老 build) ──
    "moment": DeviceRecipe("context"),
    "attention_item": DeviceRecipe("context"),
    "ambient.image_chunk": DeviceRecipe("context"),
    "ambient.audio_chunk": DeviceRecipe("context"),
    "ambient.video_chunk": DeviceRecipe("context"),
    "ambient.timeline_event": DeviceRecipe("context"),
    # ── snapshot 源:一个 push item 展开成多行 + full-sync 按 device 整体替换 ──
    "app_inventory": DeviceRecipe("apps", snapshot="apps"),
    "app_inventory_bootstrap": DeviceRecipe("apps", snapshot="apps"),
    "app_inventory_snapshot": DeviceRecipe("apps", snapshot="apps"),
    "contact_directory": DeviceRecipe("contacts", snapshot="contacts"),
    "contact_bootstrap": DeviceRecipe("contacts", snapshot="contacts"),
    "contact_directory_snapshot": DeviceRecipe("contacts", snapshot="contacts"),
    "health.observation": DeviceRecipe("health", snapshot="health"),
}


def resolve_recipe(kind: str) -> DeviceRecipe:
    """kind → DeviceRecipe。device.media.* 前缀族当 context event;未知 kind 兜底
    落 context(不丢数据)。"""
    if kind.startswith("device.media."):
        return _MEDIA_PREFIX_RECIPE
    return DEVICE_RECIPES.get(kind, UNKNOWN_RECIPE)
