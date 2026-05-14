"""Thin REST client for the LiteLLM admin API.

We only need a small slice of LiteLLM's admin surface (create user, generate
key, delete key, list keys, look up user info) — the full Python SDK isn't
worth the dependency footprint for ~150 lines of HTTP. Ported from apis's
`domain/litellm/client.ts`; field names match LiteLLM's REST shape.

Auth: every call carries `Authorization: Bearer <admin_key>` where
`admin_key` is the master key configured on the LiteLLM deployment. The
admin key is master-credential — it MUST stay in the web process only.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ...config import get_web_settings

logger = logging.getLogger(__name__)


# LiteLLM virtual keys always start with this prefix. We use it to filter
# stale / hashed values that previous bug paths may have written into
# users.litellm_virtual_key.
LITELLM_KEY_PREFIX = "sk-"


class LiteLLMError(Exception):
    """Raised on non-2xx responses or unparseable payloads."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"LiteLLM {status_code}: {message}")
        self.status_code = status_code


def _read_str(d: dict[str, Any], keys: list[str]) -> str | None:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _read_num(d: dict[str, Any], keys: list[str]) -> float | None:
    for k in keys:
        v = d.get(k)
        if isinstance(v, int | float):
            return float(v)
        if isinstance(v, str) and v.strip():
            try:
                return float(v)
            except ValueError:
                continue
    return None


def _records(payload: Any) -> list[dict[str, Any]]:
    """Walk LiteLLM's nested response envelope (data / info / user_info /
    key_info) and yield every dict-shaped record we find. Different LiteLLM
    versions nest differently; reading from the union is safer than
    hardcoding one path."""
    out: list[dict[str, Any]] = []

    def push(v: Any) -> None:
        if isinstance(v, dict) and v not in out:
            out.append(v)

    push(payload)
    if isinstance(payload, dict):
        for k in ("data", "info", "user_info", "key_info"):
            push(payload.get(k))
        data = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(data, dict):
            for k in ("info", "user_info", "key_info"):
                push(data.get(k))
    return out


async def _request(
    method: str, path: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    bearer_token: str | None = None,
) -> Any:
    """Make a LiteLLM admin request, raise LiteLLMError on non-2xx.

    LiteLLM admin endpoints (/user/new, /key/generate, /user/info ...)
    live at the root of the proxy. The OpenAI-compatible completions
    endpoints are under /v1, so most callers configure
    `LITELLM_BASE_URL=http://litellm:4000/v1`. We strip the trailing
    /v1 so admin paths resolve correctly regardless of which form the
    operator set.
    """
    s = get_web_settings()
    base_url = (s.litellm_base_url or "").rstrip("/")
    if base_url.endswith("/v1"):
        base_url = base_url[:-3]
    if not base_url:
        msg = "LITELLM_BASE_URL not configured"
        raise LiteLLMError(500, msg)
    token = bearer_token or s.litellm_master_key or ""
    if not token:
        msg = "LITELLM_MASTER_KEY not configured"
        raise LiteLLMError(500, msg)

    url = f"{base_url}{path if path.startswith('/') else '/' + path}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if json_body is not None:
        headers["Content-Type"] = "application/json"

    timeout = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.request(
            method, url, json=json_body, params=params, headers=headers,
        )
    text = resp.text
    parsed: Any = None
    if text:
        try:
            parsed = resp.json()
        except ValueError:
            parsed = {"message": text}
    if not resp.is_success:
        # Surface the inner LiteLLM error message rather than the bare
        # status — most diagnostic output we care about lives in the body.
        detail: str | None = None
        if isinstance(parsed, dict):
            detail = (
                _read_str(parsed, ["message", "detail", "error"])
                or _read_str(parsed.get("error", {}), ["message", "detail"])
                if isinstance(parsed.get("error"), dict)
                else _read_str(parsed, ["message", "detail", "error"])
            )
        raise LiteLLMError(resp.status_code, detail or text[:200])
    return parsed


async def create_user(
    *,
    user_id: str, user_alias: str,
    auto_create_key: bool = False,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Idempotent — Litellm returns 409 / "already exists" / "duplicate"
    when the user is already there, which we swallow. We never use the
    auto-created key (we generate a fresh one immediately afterward via
    /key/generate so we can pin alias / budget / models)."""
    body: dict[str, Any] = {
        "user_id": user_id,
        "user_alias": user_alias,
        "auto_create_key": auto_create_key,
    }
    if metadata:
        body["metadata"] = metadata
    try:
        await _request("POST", "/user/new", json_body=body)
    except LiteLLMError as e:
        msg = str(e).lower()
        if any(s in msg for s in ("409", "already", "exists", "duplicate")):
            return
        raise


async def generate_key(
    *,
    user_id: str, key_alias: str,
    max_budget_usd: float | None,
    budget_duration: str | None,
    rpm_limit: int | None,
    tpm_limit: int | None,
    models: list[str],
    metadata: dict[str, Any] | None = None,
) -> str:
    """Mint a new virtual key and return the raw `sk-*` token. The token
    is shown ONCE by LiteLLM — caller must persist it."""
    body: dict[str, Any] = {"user_id": user_id, "key_alias": key_alias}
    if max_budget_usd is not None:
        body["max_budget"] = max_budget_usd
    if budget_duration is not None:
        body["budget_duration"] = budget_duration
    if rpm_limit is not None:
        body["rpm_limit"] = rpm_limit
    if tpm_limit is not None:
        body["tpm_limit"] = tpm_limit
    if models:
        body["models"] = models
    if metadata:
        body["metadata"] = metadata

    parsed = await _request("POST", "/key/generate", json_body=body)
    for r in _records(parsed):
        token = _read_str(r, ["key", "token", "virtual_key"])
        if token and token.startswith(LITELLM_KEY_PREFIX):
            return token
    msg = "/key/generate response missing virtual key material"
    raise LiteLLMError(500, msg)


async def list_models_for_key(virtual_key: str) -> set[str]:
    """Return model aliases visible to a user virtual key.

    Used to detect stale keys minted with an older allowlist. LiteLLM serves
    OpenAI-compatible model listing under /v1, so this intentionally does not
    use `_request`, which strips /v1 for admin endpoints.
    """
    s = get_web_settings()
    base_url = (s.litellm_base_url or "").rstrip("/")
    if base_url and not base_url.endswith("/v1"):
        base_url = f"{base_url}/v1"
    if not base_url:
        msg = "LITELLM_BASE_URL not configured"
        raise LiteLLMError(500, msg)
    if not virtual_key:
        msg = "virtual key not configured"
        raise LiteLLMError(500, msg)

    headers = {"Authorization": f"Bearer {virtual_key}", "Accept": "application/json"}
    timeout = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.get(f"{base_url}/models", headers=headers)
    if not resp.is_success:
        raise LiteLLMError(resp.status_code, resp.text[:200])
    try:
        parsed = resp.json()
    except ValueError as e:
        msg = "/v1/models response was not JSON"
        raise LiteLLMError(500, msg) from e
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if not isinstance(data, list):
        return set()
    return {
        item["id"]
        for item in data
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }


async def delete_keys(tokens: list[str]) -> None:
    if not tokens:
        return
    try:
        await _request("POST", "/key/delete", json_body={"keys": tokens})
    except LiteLLMError as e:
        # Best-effort cleanup — don't bubble up if the key was already gone.
        logger.warning("LiteLLM /key/delete failed (ignored): %s", e)


async def list_keys_for_user(user_id: str) -> list[dict[str, Any]]:
    """Return [{token, key_alias}, ...] for the given LiteLLM user.

    LiteLLM's /user/info embeds the keys list at one of several nested
    locations depending on version; we walk all candidates."""
    try:
        parsed = await _request(
            "GET", "/user/info", params={"user_id": user_id},
        )
    except LiteLLMError as e:
        # Some LiteLLM versions reject GET; fall back to POST.
        if e.status_code in (404, 405):
            parsed = await _request(
                "POST", "/user/info", json_body={"user_id": user_id},
            )
        else:
            raise
    out: list[dict[str, Any]] = []
    for r in _records(parsed):
        keys = r.get("keys")
        if isinstance(keys, list):
            for k in keys:
                if not isinstance(k, dict):
                    continue
                token = _read_str(k, ["token", "key"])
                alias = _read_str(k, ["key_alias", "key_name"])
                if token:
                    out.append({"token": token, "key_alias": alias})
            break  # take the first records-shaped match
    return out
