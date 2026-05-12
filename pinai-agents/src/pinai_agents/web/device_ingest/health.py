"""Health observation parser — port of plugin device-ingest/health.ts.

Pulls observations[] out of an item's payload, normalizes per-row
fields, and emits a flat list ready for the raw-health writer.

The "full replace scope" decision: when the client sends sync_mode=full,
we don't want to delete *all* observations for the device — only the
narrowed slice the upload covers. payload.local_date narrows by date;
otherwise we infer from the observations themselves (single localDate
= use it; multiple = no full replace, fall back to incremental insert
to avoid wiping unrelated data).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .policies import DeviceIngestItem


@dataclass(slots=True)
class DeviceHealthObservationInput:
    observation_type: str
    metric: str | None = None
    value: float | None = None
    unit: str | None = None
    start_at: str | None = None
    end_at: str | None = None
    local_date: str | None = None
    source_app: str | None = None
    payload: dict[str, Any] | None = None
    occurred_at: str | None = None
    dedupe_key: str | None = None
    id: str | None = None


@dataclass(slots=True)
class DeviceHealthReplaceScope:
    device_id: str
    local_date: str
    # When all observations share a single metric (the common path for the
    # iOS / Android plugins, which emit one item per metric), narrow the
    # full-replace scope so a steps push doesn't wipe a sibling heart_rate
    # row that another tick just landed. Multi-metric payloads (end-of-day
    # batches that intentionally cover the full set) fall back to
    # date-only scope by leaving this None.
    metric: str | None = None


def _str_field(row: dict[str, Any], *keys: str) -> str | None:
    for k in keys:
        v = row.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _num_field(row: dict[str, Any], *keys: str) -> float | None:
    for k in keys:
        v = row.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
        if isinstance(v, str) and v.strip():
            try:
                return float(v)
            except ValueError:
                continue
    return None


def parse_health_observations(item: DeviceIngestItem) -> list[DeviceHealthObservationInput]:
    payload = item.payload or {}
    rows = payload.get("observations")
    if not isinstance(rows, list):
        return []
    payload_local_date = _str_field(payload, "local_date", "localDate")
    out: list[DeviceHealthObservationInput] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        otype = _str_field(row, "observation_type", "observationType")
        if not otype:
            continue
        local_date = _str_field(row, "local_date", "localDate") or payload_local_date
        out.append(DeviceHealthObservationInput(
            id=_str_field(row, "id"),
            observation_type=otype,
            metric=_str_field(row, "metric"),
            value=_num_field(row, "value"),
            unit=_str_field(row, "unit"),
            start_at=_str_field(row, "start_at", "startAt"),
            end_at=_str_field(row, "end_at", "endAt"),
            local_date=local_date,
            source_app=_str_field(row, "source_app", "sourceApp"),
            payload=row,
            occurred_at=_str_field(row, "occurred_at", "occurredAt") or item.occurred_at,
            dedupe_key=_str_field(row, "dedupe_key", "dedupeKey"),
        ))
    return out


def health_full_replace_scope(item: DeviceIngestItem) -> DeviceHealthReplaceScope | None:
    """Build a safe full-replace scope.

    Strategy:
      * Require an unambiguous ``local_date`` — either ``payload.local_date``
        or a single shared ``local_date`` across all observations. Return
        None otherwise so the route degrades to an
        ``unsupported_full_sync`` fallback signal.
      * Narrow scope to a single ``metric`` when the envelope carries
        only one (the common path for per-metric polling). Multi-metric
        end-of-day batches fall back to date-only scope.
    """
    payload = item.payload or {}
    payload_local_date = _str_field(payload, "local_date", "localDate")
    obs = parse_health_observations(item)

    if payload_local_date:
        local_date = payload_local_date
    else:
        if not obs:
            return None
        dates = {o.local_date for o in obs if o.local_date}
        if len(dates) != 1 or not all(o.local_date for o in obs):
            return None
        local_date = next(iter(dates))

    payload_metric = _str_field(payload, "metric")
    if payload_metric:
        metric: str | None = payload_metric
    elif obs:
        metrics = {o.metric for o in obs if o.metric}
        metric = (
            next(iter(metrics))
            if len(metrics) == 1 and all(o.metric for o in obs)
            else None
        )
    else:
        metric = None

    return DeviceHealthReplaceScope(
        device_id=item.device_id, local_date=local_date, metric=metric,
    )
