.PHONY: help init env-local ensure-env ensure-env-litellm ensure-env-pinai-agents ensure-env-root
.PHONY: up down build build-pinai-agents build-frontend restart restart-frontend status urls
.PHONY: local local-stop local-status
.PHONY: logs logs-litellm logs-postgres logs-pinai-agents logs-pinai-web logs-pinai-chat logs-frontend
.PHONY: migrate reset clean
.PHONY: deploy-pinai-dev deploy-pinai-prod deploy-frontend-dev deploy-frontend-prod deploy-reward-dashboard-dev
.PHONY: deploy-litellm-dev deploy-litellm-prod
.PHONY: ios android macos ngrok githooks install
.PHONY: tunnel-up tunnel-down tunnel-status

# Running stack: postgres + litellm + pinai-agents (web + chat) +
# proactive-ai-frontend. apis/ and pinai-openclaw/ are retired (source
# kept for git history only). ensure-env auto-decrypts the dotenvx-
# encrypted .env.dev → .env on each `make up`.

COMPOSE := docker compose
DOTENVX := npx @dotenvx/dotenvx

# Per-worktree Compose project name: multiple worktrees run as isolated
# groups (own containers / network / volumes), never colliding. Hash of the
# worktree root path — stable per worktree, unique across them (plain
# basenames all collide as "PIN-AI-ASSISTANT"). `make urls` shows live ports.
COMPOSE_PROJECT_NAME := pinai-$(shell git rev-parse --show-toplevel 2>/dev/null | shasum | cut -c1-8)
export COMPOSE_PROJECT_NAME

# Dev label (git branch) surfaced via web /health → frontend DebugPanel, so a
# phone tunneled to :8000 shows which worktree/branch it's hitting. The web
# container reads it only when docker-compose.override.yml passes it through
# (local dev); prod/CI never set it, so /health omits it. Harmless to export.
export PINAI_DEV_LABEL := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null)

# Auto-pick npm registry based on OS timezone: China → npmmirror, else npmjs.
# Manual override: export NPM_REGISTRY=... in shell before running make.
ifndef NPM_REGISTRY
NPM_REGISTRY := $(shell \
    tz=$$(readlink /etc/localtime 2>/dev/null | sed "s|.*zoneinfo/||"); \
    if [ "$$tz" = Asia/Shanghai ] || [ "$$tz" = Asia/Urumqi ] || [ "$$tz" = PRC ]; then \
      echo https://registry.npmmirror.com; \
    else \
      echo https://registry.npmjs.org; \
    fi)
endif
export NPM_REGISTRY

# VITE_* build args sourced from pinai-agents/.env (single source of
# truth, decrypted by ensure-env-pinai-agents). Used by `docker compose
# build frontend` and the Capacitor ios/android targets.
define export_vite
set -a && . ./pinai-agents/.env && set +a
endef

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-26s\033[0m %s\n", $$1, $$2}'

githooks: ## Enable repo-local git hooks (.githooks/) for pre-commit checks
	@git config core.hooksPath .githooks
	@echo "Enabled .githooks/. Bypass a single commit with: git commit --no-verify"
	@echo "Disable entirely with: git config --unset core.hooksPath"

# Auto-install npm deps when package-lock.json changes (or on first run).
# Stamp file inside node_modules acts as the "last successful install" marker.
# If state is broken in subtle ways (corrupt package), force re-install with:
#   rm node_modules/.install-stamp && make install
install: node_modules/.install-stamp ## Install npm deps (auto-refreshes when package-lock.json changes)

node_modules/.install-stamp: package-lock.json
	@echo "==> Installing npm dependencies (lock changed or first run)..."
	npm install
	@mkdir -p node_modules
	@touch $@

# ── Environment: auto-decrypt .env.dev → .env ──
# Decrypts the dotenvx-encrypted .env.dev sources into plaintext .env on each
# `make up`. The private key comes from a DOTENV_PRIVATE_KEY_* env var (put it
# in your shell — recommended, nothing to distribute) OR a local .env.keys
# file. Re-runs when .env is missing/empty or .env.dev is newer; recover a
# stuck or empty env with `make env-local`. Atomic decrypt: see
# scripts/decrypt_env.sh.

ensure-env: ensure-env-litellm ensure-env-pinai-agents ensure-env-root ## Auto-decrypt all .env files if needed

ensure-env-litellm:
	@bash scripts/decrypt_env.sh ops/litellm

ensure-env-pinai-agents:
	@bash scripts/decrypt_env.sh pinai-agents
	@# Re-derive .env.chat (master creds stripped) whenever .env changes —
	@# atomically, and only with a valid FORBIDDEN_ENVS filter (an empty regex
	@# from a trust_boundary import failure would strip every line to nothing).
	@# The strip is line-based, so it assumes every secret is single-line; we
	@# assert that (total lines == KEY= lines) before stripping, so a future
	@# multi-line secret fails loudly here instead of silently leaking its
	@# continuation lines past the trust boundary into the chat container.
	@if [ ! -s pinai-agents/.env.chat ] || [ pinai-agents/.env -nt pinai-agents/.env.chat ]; then \
		echo "Deriving pinai-agents/.env.chat (master creds stripped for chat process)"; \
		FORBIDDEN_RE=$$(PYTHONPATH=pinai-agents/src python3 -c \
			"from pinai_agents.chat.trust_boundary import FORBIDDEN_ENVS; print('^(' + '|'.join(FORBIDDEN_ENVS) + ')=')"); \
		if [ -z "$$FORBIDDEN_RE" ]; then \
			echo "ERROR: could not compute FORBIDDEN_ENVS regex (trust_boundary import failed)."; \
			exit 1; \
		fi; \
		total=$$(grep -c '^' pinai-agents/.env); \
		kvlines=$$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' pinai-agents/.env); \
		if [ "$$total" != "$$kvlines" ]; then \
			echo "ERROR: pinai-agents/.env has multi-line values ($$total lines vs $$kvlines KEY= lines)."; \
			echo "  The line-based strip below would leak secret continuation lines into .env.chat."; \
			echo "  Store every secret on one line (e.g. base64-encode PEM keys)."; \
			exit 1; \
		fi; \
		grep -vE "$$FORBIDDEN_RE" pinai-agents/.env > pinai-agents/.env.chat.tmp; \
		if [ -s pinai-agents/.env.chat.tmp ]; then \
			mv pinai-agents/.env.chat.tmp pinai-agents/.env.chat; \
		else \
			rm -f pinai-agents/.env.chat.tmp; \
			echo "ERROR: deriving pinai-agents/.env.chat produced no output."; \
			exit 1; \
		fi; \
	fi

# Root ./.env holds local-infra config (NGROK_AUTHTOKEN), shared across the
# team via the encrypted ./.env.dev. docker compose reads ./.env automatically
# for the ngrok service.
ensure-env-root:
	@bash scripts/decrypt_env.sh .

env-local: ## Force re-decrypt all .env files
	@rm -f ops/litellm/.env pinai-agents/.env pinai-agents/.env.chat ./.env
	@$(MAKE) --no-print-directory ensure-env

# ── Setup ──

init: ## First-time setup: install deps and show next steps
	npm install
	cd proactive-ai-frontend && npm install
	@echo ""
	@echo "Next steps:"
	@echo "  1. Get .env.keys from team members"
	@echo "     Place:  ops/litellm/.env.keys"
	@echo "             pinai-agents/.env.keys"
	@echo "  2. make up  (auto-decrypts and starts everything)"

# ── Build ──

build: ensure-env ## Build all images (pinai-agents + frontend)
	$(export_vite) && $(COMPOSE) build pinai-web pinai-chat frontend

build-pinai-agents: ensure-env-pinai-agents ## Build only pinai-agents image (shared by web + chat + db-migrate)
	$(COMPOSE) build pinai-web

build-frontend: ensure-env-pinai-agents ## Build only frontend image
	$(export_vite) && $(COMPOSE) build frontend

# ── Run ──

up: build ## Build and start the full local stack (no tunnel — run `make tunnel-up` for generator/mobile)
	$(COMPOSE) up -d --remove-orphans
	@$(MAKE) --no-print-directory urls

down: ## Stop all services
	$(COMPOSE) down

restart: ensure-env ## Rebuild + recreate pinai-web + pinai-chat (most common dev loop)
	$(COMPOSE) build pinai-web
	@url=$$(bash scripts/ngrok_url.sh 2>/dev/null || true); \
	if [ -n "$$url" ]; then \
		echo "→ injecting PAI_API_URL=$$url into pinai-chat"; \
		PAI_API_URL="$$url" $(COMPOSE) up -d --force-recreate --no-deps pinai-web pinai-chat; \
	else \
		$(COMPOSE) up -d --force-recreate --no-deps pinai-web pinai-chat; \
	fi

restart-frontend: ensure-env-pinai-agents ## Rebuild + recreate frontend container
	$(export_vite) && $(COMPOSE) build frontend
	$(COMPOSE) up -d --force-recreate --no-deps frontend

status: ## Show running containers
	$(COMPOSE) ps

urls: ## Show this group's project name + live host ports
	@echo "Project:  $(COMPOSE_PROJECT_NAME)"
	@echo "Frontend: http://localhost:$$($(COMPOSE) port frontend 8080 2>/dev/null | cut -d: -f2)"
	@echo "API:      http://localhost:$$($(COMPOSE) port pinai-web 8000 2>/dev/null | cut -d: -f2)"
	@echo "Postgres: localhost:$$($(COMPOSE) port postgres 5432 2>/dev/null | cut -d: -f2)"
	@echo "LiteLLM:  http://localhost:$$($(COMPOSE) port litellm 4000 2>/dev/null | cut -d: -f2)"
	@url=$$(bash scripts/ngrok_url.sh 2>/dev/null) && echo "ngrok:    $$url" || true

# ── Local Hot mode ──

local: ## Start fixed-port hot-reload local mode (frontend 3000, web 8000, chat 8001)
	bash scripts/local_dev.sh start

local-stop: ## Stop Local Hot host processes and dependency containers (keeps DB volume)
	bash scripts/local_dev.sh stop

local-status: ## Show Local Hot process/container status and fixed URLs
	bash scripts/local_dev.sh status

# ── Logs ──

logs: ## Tail all logs
	$(COMPOSE) logs -f

logs-litellm: ## Tail LiteLLM logs
	$(COMPOSE) logs -f litellm

logs-postgres: ## Tail Postgres logs
	$(COMPOSE) logs -f postgres

logs-pinai-agents: ## Tail both pinai-web and pinai-chat logs
	$(COMPOSE) logs -f pinai-web pinai-chat

logs-pinai-web: ## Tail pinai-web (master-cred process) logs
	$(COMPOSE) logs -f pinai-web

logs-pinai-chat: ## Tail pinai-chat (LLM-loop process) logs
	$(COMPOSE) logs -f pinai-chat

logs-frontend: ## Tail frontend (nginx) logs
	$(COMPOSE) logs -f frontend

# ── Database ──

migrate: ## Run db-migrate one-shot (creates litellm db + applies pai_* migrations)
	@# `run --rm`, not `up`: db-migrate is a one-shot job. `up
	@# --abort-on-container-exit` (implied by --exit-code-from) stops EVERY
	@# container it touched the moment db-migrate exits — including a shared
	@# postgres that a running stack still depends on, tearing the stack down.
	@# `run` reuses postgres when it's already healthy (starts it + waits on
	@# the healthcheck only when needed), applies the migration, and leaves
	@# postgres alone; --rm removes the job container. `run` returns
	@# db-migrate's exit code, so a failed migration still fails make.
	$(COMPOSE) run --rm db-migrate

# ── Reset ──

clean: ## Stop everything and delete all volumes (data loss!)
	$(COMPOSE) --profile tunnel down -v --remove-orphans

reset: ## Stop everything, delete volumes, rebuild and start fresh (incl. ngrok tunnel when ./.env is configured)
	$(MAKE) clean
	$(MAKE) up
	@# Bring up the ngrok tunnel when ./.env carries NGROK_AUTHTOKEN — the
	@# same (and only) precondition `make tunnel-up` checks — so a generator
	@# run right after `make reset` lands SDK calls on a reachable URL. The
	@# public URL and PAI_API_URL are assigned at runtime by tunnel-up (read
	@# from ngrok's API, not stored in ./.env), so the token is the only gate.
	@# Soft-skip when it's missing — teammates without an ngrok account can
	@# still `make reset`.
	@if [ -f .env ] && grep -qE '^NGROK_AUTHTOKEN=.+' .env; then \
		$(MAKE) tunnel-up; \
	else \
		echo ""; \
		echo "Skipping ngrok tunnel — NGROK_AUTHTOKEN missing from ./.env."; \
		echo "  Generator runs without a tunnel will hit ConnectError"; \
		echo "  inside the Daytona sandbox. To enable: make tunnel-up"; \
		echo ""; \
	fi

# ── Deploy (Fly.io) ──
# pinai-agents has two process groups (web + chat) that share one fly
# app via [processes] in fly.dev.toml / fly.prod.toml. Frontend and
# internal reward dashboard are separate static SPA fly apps. LiteLLM is
# its own fly app under ops/litellm.

define extract_vite_args
$(shell $(DOTENVX) get -f pinai-agents/.env.$(1) --format json 2>/dev/null \
	| python3 -c 'import json,sys;d=json.load(sys.stdin);[print("--build-arg "+k+"="+v) for k,v in d.items() if k.startswith("VITE_")]')
endef

define extract_reward_dashboard_vite_args
$(shell $(DOTENVX) get -f pinai-agents/.env.$(1) --format json 2>/dev/null \
	| python3 -c 'import json,sys;d=json.load(sys.stdin);[print("--build-arg "+k+"="+v) for k,v in d.items() if k in {"VITE_SUPABASE_URL","VITE_SUPABASE_PUBLISHABLE_KEY"}]')
endef

deploy-pinai-dev: ## Deploy pinai-agents (web + chat) to dev
	cd pinai-agents && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.dev.toml --remote-only

deploy-pinai-prod: ## Deploy pinai-agents to prod (requires review)
	@echo "Deploying pinai-agents to PRODUCTION. Ctrl+C to cancel."
	@sleep 3
	cd pinai-agents && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.prod.toml --remote-only

deploy-frontend-dev: ## Deploy frontend SPA to dev (Fly nginx)
	cd proactive-ai-frontend && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --remote-only \
		$(call extract_vite_args,dev)

deploy-frontend-prod: ## Deploy frontend SPA to prod (Fly nginx)
	@echo "Deploying frontend to PRODUCTION. Ctrl+C to cancel."
	@sleep 3
	cd proactive-ai-frontend && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --remote-only \
		$(call extract_vite_args,production)

deploy-reward-dashboard-dev: ## Deploy internal reward dashboard to dev (Fly nginx)
	cd internal-reward-dashboard && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.toml --remote-only \
		$(call extract_reward_dashboard_vite_args,dev)

deploy-litellm-dev: ## Deploy LiteLLM to dev
	cd ops/litellm && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.litellm-dev.toml --remote-only

deploy-litellm-prod: ## Deploy LiteLLM to prod
	@echo "Deploying LiteLLM to PRODUCTION. Ctrl+C to cancel."
	@sleep 3
	cd ops/litellm && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.litellm-prod.toml --remote-only

# ── Mobile (Capacitor) ──
# Backend selection: NGROK=<url> | DEV=1 (fly dev) | PROD=1 (fly prod) |
# default = project .env PAI_API_URL. No LAN-IP fallback: mobile packages
# should keep working off the current Wi-Fi or fail loudly.

ngrok: ## Expose local pinai-web over public ngrok (foreground CLI; prefer `make tunnel-up`)
	@command -v ngrok >/dev/null 2>&1 || { echo "ngrok not found. brew install ngrok"; exit 1; }
	@port=$$($(COMPOSE) port pinai-web 8000 2>/dev/null | cut -d: -f2); \
	[ -n "$$port" ] || { echo "pinai-web not running — run 'make up' first."; exit 1; }; \
	echo "Starting ngrok → http://localhost:$$port (foreground CLI)."; \
	echo "Prefer 'make tunnel-up' (docker ngrok + auto-inject into pinai-chat; 'make ios' picks it up)."; \
	ngrok http $$port

# ── Daytona sandbox tunnel ──
# Generator / dreaming agents run code in Daytona cloud sandboxes. The
# pinai_sdk inside the sandbox calls back into pinai-web via PAI_API_URL.
# That URL must be reachable from the public internet — compose-internal
# DNS won't resolve from the cloud. tunnel-up runs an ngrok service
# (docker, profile=tunnel) that gives pinai-web a stable public URL,
# then re-creates pinai-chat so it picks up the public URL from ./.env
# and injects it into the sandbox env.
#
# Config: project-root ./.env (per-developer, gitignored). See
# .env.example for first-time setup. Different developer = different
# ngrok account + reserved domain (free tier: 1 simultaneous tunnel).

tunnel-up: ensure-env-root ## Open ngrok tunnel (this worktree's .ngrok.app subdomain) and inject it into pinai-chat
	@if ! grep -qE '^NGROK_AUTHTOKEN=.+' .env 2>/dev/null; then \
		echo "NGROK_AUTHTOKEN missing from ./.env — ./.env.dev did not decrypt."; \
		echo "  Set DOTENV_PRIVATE_KEY_DEV in your shell (team key), then retry."; \
		exit 1; \
	fi
	@echo "→ starting ngrok (this worktree's .ngrok.app subdomain)..."
	@$(COMPOSE) --profile tunnel up -d ngrok
	@url=$$(bash scripts/ngrok_url.sh) || exit 1; \
	echo "→ injecting PAI_API_URL=$$url into pinai-chat"; \
	PAI_API_URL="$$url" $(COMPOSE) up -d --force-recreate --no-deps pinai-chat; \
	echo ""; \
	echo "Tunnel ready: $$url"; \
	echo "  (Daytona sandbox python_exec / mobile reach pinai-web through this URL.)"

tunnel-down: ## Close ngrok tunnel and revert chat to internal PAI_API_URL
	$(COMPOSE) --profile tunnel rm -sf ngrok
	@echo "→ recreating pinai-chat with internal PAI_API_URL"
	@PAI_API_URL= $(COMPOSE) up -d --force-recreate --no-deps pinai-chat
	@echo "Tunnel closed. Sandbox SDK calls will fail until reopened."

tunnel-status: ## Show whether the tunnel is up and at what URL
	@url=$$(bash scripts/ngrok_url.sh 2>/dev/null) && echo "Tunnel UP at $$url" || echo "Tunnel DOWN. Start with: make tunnel-up"

ios: install ensure-env ## Build frontend, sync iOS, open Xcode
	@set -a && . ./pinai-agents/.env && set +a && \
	if [ -n "$(NGROK)" ]; then \
		echo "Using ngrok at $(NGROK)"; VITE_PIN_API_URL="$(NGROK)"; \
	elif [ "$(PROD)" = "1" ]; then \
		PROD_URL=$$(npx -y @dotenvx/dotenvx get VITE_PIN_API_URL -f pinai-agents/.env.production 2>/dev/null); \
		if [ -z "$$PROD_URL" ]; then echo "VITE_PIN_API_URL missing in prod env"; exit 1; fi; \
		VITE_PIN_API_URL="$$PROD_URL"; \
	elif [ "$(DEV)" = "1" ]; then \
		echo "Using fly dev at $$VITE_PIN_API_URL"; \
	else \
		echo "→ starting this worktree's ngrok tunnel for the mobile build..."; \
		$(MAKE) --no-print-directory tunnel-up || { echo "tunnel-up failed — check NGROK_AUTHTOKEN / network, or use DEV=1 / PROD=1 / NGROK=<url>."; exit 1; }; \
		VITE_PIN_API_URL=$$(bash scripts/ngrok_url.sh) || exit 1; \
		echo "Using this worktree's ngrok tunnel at $$VITE_PIN_API_URL"; \
	fi; \
	VITE_PIN_API_URL="$$VITE_PIN_API_URL" \
		bash proactive-ai-frontend/scripts/sync-ios.sh && \
		cd proactive-ai-frontend && npx cap open ios

android: install ensure-env ## Build frontend, sync Android, install on USB device
	@set -e; \
	set -a && . ./pinai-agents/.env && set +a; \
	if [ -n "$(NGROK)" ]; then \
		VITE_PIN_API_URL="$(NGROK)"; \
	elif [ "$(PROD)" = "1" ]; then \
		PROD_URL=$$(npx -y @dotenvx/dotenvx get VITE_PIN_API_URL -f pinai-agents/.env.production 2>/dev/null); \
		[ -z "$$PROD_URL" ] && { echo "VITE_PIN_API_URL missing in prod env"; exit 1; }; \
		VITE_PIN_API_URL="$$PROD_URL"; \
	elif [ "$(DEV)" = "1" ]; then \
		echo "Using fly dev at $$VITE_PIN_API_URL"; \
	else \
		echo "→ starting this worktree's ngrok tunnel for the mobile build..."; \
		$(MAKE) --no-print-directory tunnel-up || { echo "tunnel-up failed — check NGROK_AUTHTOKEN / network, or use DEV=1 / PROD=1 / NGROK=<url>."; exit 1; }; \
		VITE_PIN_API_URL=$$(bash scripts/ngrok_url.sh) || exit 1; \
		echo "Using this worktree's ngrok tunnel at $$VITE_PIN_API_URL"; \
	fi; \
	cd proactive-ai-frontend && \
		VITE_CAPACITOR=1 VITE_PIN_API_URL="$$VITE_PIN_API_URL" \
		VITE_API_BASE_URL="$$VITE_PIN_API_URL" \
		npx vite build && npx cap sync android && \
		cd android && ./gradlew installDebug && \
		adb shell am start -n ai.pin.proactive.dev/.MainActivity

macos: install ensure-env-pinai-agents ## Run the Electron desktop shell (this worktree's backend; DEV=1 fly dev, PROD=1 fly prod)
	@set -e; \
	set -a && . ./pinai-agents/.env && set +a; \
	if [ "$(PROD)" = "1" ]; then \
		TARGET=$$(npx -y @dotenvx/dotenvx get VITE_PIN_API_URL -f pinai-agents/.env.production 2>/dev/null); \
		[ -z "$$TARGET" ] && { echo "VITE_PIN_API_URL missing in prod env"; exit 1; }; \
		export VITE_SUPABASE_URL=$$(npx -y @dotenvx/dotenvx get VITE_SUPABASE_URL -f pinai-agents/.env.production 2>/dev/null); \
		export VITE_SUPABASE_PUBLISHABLE_KEY=$$(npx -y @dotenvx/dotenvx get VITE_SUPABASE_PUBLISHABLE_KEY -f pinai-agents/.env.production 2>/dev/null); \
		echo "→ Electron vs fly prod ($$TARGET) + prod Supabase"; \
	elif [ "$(DEV)" = "1" ]; then \
		TARGET="$$VITE_PIN_API_URL"; \
		echo "→ Electron vs fly dev ($$TARGET)"; \
	else \
		PORT=$$($(COMPOSE) port pinai-web 8000 2>/dev/null | cut -d: -f2); \
		[ -z "$$PORT" ] && { echo "pinai-web not running in this worktree — run 'make up' first, or use DEV=1 / PROD=1."; exit 1; }; \
		TARGET="http://127.0.0.1:$$PORT"; \
		echo "→ Electron vs this worktree's backend ($$TARGET)"; \
	fi; \
	VITE_PIN_API_PROXY_TARGET="$$TARGET" npm run dev --workspace=@pin-ai/desktop
