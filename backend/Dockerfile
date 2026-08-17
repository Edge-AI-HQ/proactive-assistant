# backend Python service
# Multi-stage: build deps with uv, slim runtime image.
# Mirrors the apis/Dockerfile pattern (multi-stage + dotenvx for runtime secrets).

# ── Stage 1: install deps via uv ──
ARG PYTHON_BASE_IMAGE=python:3.12-slim
ARG UV_BASE_IMAGE=ghcr.io/astral-sh/uv:0.11.21

FROM ${UV_BASE_IMAGE} AS uv-bin
FROM ${PYTHON_BASE_IMAGE} AS builder

# Keep the container CLI aligned with the version used to maintain uv.lock.
# uv 0.11+ also supports export from this pure workspace root.
COPY --from=uv-bin /uv /uvx /bin/

# Local CN builds export the canonical lock to fully pinned, hash-checked
# requirements, then fetch those exact artifacts from the selected mirror.
# The checked-in uv.lock remains canonical PyPI and is never rewritten.
# CI/Fly omit these args and retain the normal frozen-lock path.
ARG PINAI_DEV_REGION=us
ARG UV_DEFAULT_INDEX=https://pypi.org/simple
ENV UV_DEFAULT_INDEX=${UV_DEFAULT_INDEX}

WORKDIR /app

# uv install non-project deps first (layer cache friendly). uv workspace:
# the root pyproject is a pure workspace root that declares libs/* + services/*
# members, so resolving the lock needs every member's pyproject present
# (libs/contracts + libs/db + the api / agent-engine / reward-dashboard
# services). COPY the member pyprojects before the first sync.
COPY pyproject.toml uv.lock* ./
COPY libs ./libs
COPY services/api/pyproject.toml ./services/api/pyproject.toml
COPY services/agent-engine/pyproject.toml ./services/agent-engine/pyproject.toml
COPY services/reward-dashboard/pyproject.toml ./services/reward-dashboard/pyproject.toml
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ "$PINAI_DEV_REGION" = "cn" ]; then \
        uv --quiet export --frozen --all-packages --no-dev --no-emit-workspace \
            --output-file /tmp/requirements-cn.txt; \
        uv venv .venv; \
        uv pip sync --python .venv/bin/python --require-hashes \
            /tmp/requirements-cn.txt; \
    else \
        uv sync --frozen --no-install-project --no-dev \
        || uv sync --no-install-project --no-dev; \
    fi

# Single image — process groups select the entrypoint (api + agent-engine on
# this fly app; reward-dashboard is its own deploy). --all-packages installs
# every workspace member (pinai-api, pinai-contracts, pinai-db,
# agent-engine, pinai-reward-dashboard) so each entrypoint can run its
# own pinai_*.asgi module.
COPY services ./services
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --all-packages \
    || uv sync --no-dev --all-packages

# ── Stage 2: runtime ──
FROM ${PYTHON_BASE_IMAGE}

WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
# uv workspace members install editable: the .venv's _editable_impl_*.pth
# point at /app/libs/{contracts,db}/src and /app/services/*/src (api,
# agent-engine, reward-dashboard), so all member src trees must ship in the
# runtime image.
COPY libs ./libs
COPY services ./services

# Migration runner inputs: yoyo.ini config + db/migrations/ SQL files.
# Used by fly release_command and by the db-migrate compose service.
COPY yoyo.ini ./
COPY db ./db

# pinai_sdk source — copied into image so the agent-engine sandbox tool
# (agent_engine/tools/code_mode/sandbox.py) can
# Image.add_local_dir(/app/packages/pinai_sdk) at runtime when building the
# Daytona sandbox image.
COPY packages ./packages

# Secret loading is OUTSIDE the image:
#   * docker-compose dev: env_file: ./backend/.env (web) | .env.chat (chat)
#     Each process group sees only its scoped subset of secrets — chat
#     never gets master credentials. Trust boundary is enforced by
#     env_file selection, not by an in-image dotenvx wrapper.
#   * Fly prod: `flyctl secrets set --process-group=web ...` / chat-only
#     scoping. Same trust boundary, scoped at the platform layer.
#
# Removed the previous `COPY .env.dev .env.production*` + dotenvx CMD
# wrapper. Baking encrypted env files into the image leaked master creds
# into chat at runtime (dotenvx run loaded the full file regardless of
# the env_file scope). Fly secrets per process group is the right
# answer for prod.

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
# No PYTHONPATH needed: every workspace member (pinai_api, agent_engine,
# pinai_reward_dashboard, pinai_contracts, pinai_db) installs editable, so the
# venv's _editable_impl_*.pth files resolve their imports from
# /app/services/*/src and /app/libs/*/src.

EXPOSE 8000 8001

# Same image, two process groups (see docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx
# § 部署形态). docker-compose / fly.toml override these ENVs to switch:
#
#   web:  ENTRYPOINT_MODULE=pinai_api.asgi:app             ENTRYPOINT_PORT=8000
#   chat: ENTRYPOINT_MODULE=agent_engine.asgi:app    ENTRYPOINT_PORT=8001
#
# Defaults below pick the api (web) entrypoint so a bare `docker run` still
# gives a useful service.
ENV ENTRYPOINT_MODULE=pinai_api.asgi:app
ENV ENTRYPOINT_PORT=8000
CMD ["sh", "-c", "exec uvicorn ${ENTRYPOINT_MODULE} --host 0.0.0.0 --port ${ENTRYPOINT_PORT}"]
