# Pin AI Daytona sandbox snapshot.
#
# Built into a Daytona snapshot named `pinai-sandbox:<version>` which the
# chat agent's python_exec passes to `daytona.create(snapshot=...)`. AI-
# generated Python code runs inside this image — `from pinai_sdk import
# client` works out of the box because we install it here.
#
# Build / register:
#   bash infra/daytona/build_snapshot.sh 0.1.0
#
# References:
#   docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx
#   https://www.daytona.io/docs/en/snapshots/
#
# Conventions enforced:
#   * --platform=linux/amd64 — Daytona runners are AMD64 only.
#   * slim-bookworm base — keeps image under ~150 MB.
#   * non-root `daytona` user (uid 1000) — sandbox prints / writes go to
#     /home/daytona; matches Daytona's default home expectation.
#   * NO CMD — Daytona injects `sleep infinity`; code_interpreter.run_code
#     execs into the running container against the file the SDK writes.
#   * Install only wheels (no source builds) → no gcc, faster build.
#
# Build context expects `packages/pinai_sdk/` adjacent to this Dockerfile,
# i.e. invoke from backend root with --file infra/daytona/Dockerfile.

FROM --platform=linux/amd64 python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ONLY_BINARY=:all:

# pinai_sdk runtime deps (mirror packages/pinai_sdk/pyproject.toml).
# Pinned major versions to avoid silent drift.
RUN pip install --no-cache-dir \
        "httpx>=0.27.0,<1.0" \
        "pydantic>=2.6.0,<3.0" \
        "anyio>=4.0.0,<5.0" \
        "orjson>=3.10.0,<4.0"

# Copy + install the SDK from the local repo (not PyPI).
COPY packages/pinai_sdk/ /opt/pinai_sdk/
RUN pip install --no-cache-dir /opt/pinai_sdk

# Non-root by convention. AI-generated code shouldn't be able to apt-get.
RUN useradd -m -u 1000 daytona
USER daytona
WORKDIR /home/daytona

# Smoke check: snapshot build fails fast if pinai_sdk fails to import.
RUN python3 -c "from pinai_sdk import client; print('pinai_sdk preinstalled')"

# No CMD / ENTRYPOINT — Daytona injects sleep infinity. Confirmed via
# https://www.daytona.io/docs/en/snapshots/ § "Custom snapshots".
