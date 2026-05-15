.PHONY: help init env-local ensure-env ensure-env-litellm ensure-env-pinai-agents
.PHONY: up down build build-pinai-agents build-frontend restart restart-frontend status
.PHONY: logs logs-litellm logs-postgres logs-pinai-agents logs-pinai-web logs-pinai-chat logs-frontend
.PHONY: migrate reset clean
.PHONY: deploy-pinai-dev deploy-pinai-prod deploy-frontend-dev deploy-frontend-prod deploy-reward-dashboard-dev
.PHONY: deploy-litellm-dev deploy-litellm-prod
.PHONY: ios android ngrok githooks install
.PHONY: tunnel-up tunnel-down tunnel-status

# Running stack: postgres + litellm + pinai-agents (web + chat) +
# proactive-ai-frontend. apis/ and pinai-openclaw/ are retired (source
# kept for git history only). ensure-env auto-decrypts the dotenvx-
# encrypted .env.dev → .env on each `make up`.

COMPOSE := docker compose
DOTENVX := npx @dotenvx/dotenvx

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
# Triggers when .env is missing or .env.dev is newer.
# Requires .env.keys (get from team members; never commit).

ensure-env: ensure-env-litellm ensure-env-pinai-agents ## Auto-decrypt all .env files if needed

ensure-env-litellm:
	@if [ ! -f ops/litellm/.env ] || [ ops/litellm/.env.dev -nt ops/litellm/.env ]; then \
		if [ ! -f ops/litellm/.env.keys ]; then \
			echo "Missing ops/litellm/.env.keys"; \
			echo "  Get .env.keys from team members"; \
			exit 1; \
		fi; \
		echo "Decrypting ops/litellm/.env.dev -> ops/litellm/.env"; \
		$(DOTENVX) get -f ops/litellm/.env.dev --format json 2>/dev/null \
			| python3 -c 'import json,sys;[print(k+"="+chr(39)+str(v)+chr(39)) for k,v in json.load(sys.stdin).items() if not k.startswith("DOTENV_PUBLIC_KEY")]' \
			> ops/litellm/.env; \
	fi

ensure-env-pinai-agents:
	@if [ ! -f pinai-agents/.env ] || [ pinai-agents/.env.dev -nt pinai-agents/.env ]; then \
		if [ ! -f pinai-agents/.env.keys ]; then \
			echo "Missing pinai-agents/.env.keys"; \
			echo "  Get .env.keys from team members"; \
			exit 1; \
		fi; \
		echo "Decrypting pinai-agents/.env.dev -> pinai-agents/.env"; \
		$(DOTENVX) get -f pinai-agents/.env.dev --format json 2>/dev/null \
			| python3 -c 'import json,sys;[print(k+"="+chr(39)+str(v)+chr(39)) for k,v in json.load(sys.stdin).items() if not k.startswith("DOTENV_PUBLIC_KEY")]' \
			> pinai-agents/.env; \
	fi
	@# Re-derive .env.chat whenever .env changes (covers both fresh-decrypt
	@# above and the manual-edit case where the user tweaks .env directly).
	@if [ ! -f pinai-agents/.env.chat ] || [ pinai-agents/.env -nt pinai-agents/.env.chat ]; then \
		echo "Deriving pinai-agents/.env.chat (master creds stripped for chat process)"; \
		FORBIDDEN_RE=$$(PYTHONPATH=pinai-agents/src python3 -c \
			"from pinai_agents.chat.trust_boundary import FORBIDDEN_ENVS; print('^(' + '|'.join(FORBIDDEN_ENVS) + ')=')"); \
		grep -vE "$$FORBIDDEN_RE" pinai-agents/.env > pinai-agents/.env.chat; \
	fi

env-local: ## Force re-decrypt all .env files
	@rm -f ops/litellm/.env pinai-agents/.env pinai-agents/.env.chat
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

up: build ## Build and start the full local stack
	$(COMPOSE) up -d --remove-orphans

down: ## Stop all services
	$(COMPOSE) down

restart: ensure-env ## Rebuild + recreate pinai-web + pinai-chat (most common dev loop)
	$(COMPOSE) build pinai-web
	$(COMPOSE) up -d --force-recreate --no-deps pinai-web pinai-chat

restart-frontend: ensure-env-pinai-agents ## Rebuild + recreate frontend container
	$(export_vite) && $(COMPOSE) build frontend
	$(COMPOSE) up -d --force-recreate --no-deps frontend

status: ## Show running containers
	$(COMPOSE) ps

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
	$(COMPOSE) up --abort-on-container-exit --exit-code-from db-migrate db-migrate postgres

# ── Reset ──

clean: ## Stop everything and delete all volumes (data loss!)
	$(COMPOSE) --profile tunnel down -v --remove-orphans

reset: ## Stop everything, delete volumes, rebuild and start fresh (incl. ngrok tunnel when ./.env is configured)
	$(MAKE) clean
	$(MAKE) up
	@# Bring up the ngrok tunnel if ./.env has all three values, so a
	@# generator run right after `make reset` lands SDK calls on a
	@# reachable URL. Soft-skip when the file is missing or partial —
	@# teammates without an ngrok account can still `make reset`.
	@if [ -f .env ] \
		&& grep -qE '^NGROK_AUTHTOKEN=.+' .env \
		&& grep -qE '^NGROK_DOMAIN=.+' .env \
		&& grep -qE '^PAI_API_URL=https://' .env; then \
		$(MAKE) tunnel-up; \
	else \
		echo ""; \
		echo "Skipping ngrok tunnel — ./.env not fully configured."; \
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

ngrok: ## Expose local pinai-web (:8000) over public ngrok for mobile dev
	@command -v ngrok >/dev/null 2>&1 || { echo "ngrok not found. brew install ngrok"; exit 1; }
	@echo "Starting ngrok → http://localhost:8000"
	@echo "For mobile: rebuild with NGROK=<printed https URL> make ios, or put it in ./.env as PAI_API_URL."
	@ngrok http 8000

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

tunnel-up: ## Open ngrok tunnel for Daytona sandbox SDK access
	@if [ ! -f .env ]; then \
		echo ""; \
		echo "ngrok config not set up yet."; \
		echo ""; \
		echo "First-time setup:"; \
		echo "  1. Sign up at https://dashboard.ngrok.com/signup (free)"; \
		echo "  2. Copy authtoken: https://dashboard.ngrok.com/get-started/your-authtoken"; \
		echo "  3. Reserve a domain: https://dashboard.ngrok.com/domains → New Domain"; \
		echo "  4. cp .env.example .env  (then fill in the three values)"; \
		echo "  5. make tunnel-up"; \
		echo ""; \
		exit 1; \
	fi
	@set -a && . ./.env && set +a; \
	missing=""; \
	[ -z "$$NGROK_AUTHTOKEN" ] && missing="$$missing NGROK_AUTHTOKEN"; \
	[ -z "$$NGROK_DOMAIN" ]    && missing="$$missing NGROK_DOMAIN"; \
	[ -z "$$PAI_API_URL" ]     && missing="$$missing PAI_API_URL"; \
	if [ -n "$$missing" ]; then \
		echo ""; \
		echo "Missing in ./.env:$$missing"; \
		echo ""; \
		echo "Get authtoken / reserve domain at https://dashboard.ngrok.com,"; \
		echo "then fill values per .env.example."; \
		echo ""; \
		exit 1; \
	fi; \
	echo "→ starting ngrok ($$NGROK_DOMAIN)"; \
	$(COMPOSE) --profile tunnel up -d ngrok && \
	echo "→ recreating pinai-chat with PAI_API_URL=$$PAI_API_URL"; \
	$(COMPOSE) up -d --force-recreate --no-deps pinai-chat && \
	echo "" && \
	echo "Tunnel ready:" && \
	echo "  Public URL: $$PAI_API_URL" && \
	echo "  Inspector:  http://localhost:4040" && \
	echo "  Daytona sandbox python_exec → reaches pinai-web through the tunnel."

tunnel-down: ## Close ngrok tunnel and revert chat to internal PAI_API_URL
	$(COMPOSE) --profile tunnel rm -sf ngrok
	@echo "→ recreating pinai-chat with internal PAI_API_URL"
	@PAI_API_URL= $(COMPOSE) up -d --force-recreate --no-deps pinai-chat
	@echo "Tunnel closed. Sandbox SDK calls will fail until reopened."

tunnel-status: ## Show whether the tunnel is up and at what URL
	@if curl -fsS http://localhost:4040/api/tunnels 2>/dev/null \
		| python3 -c "import json,sys; t=json.load(sys.stdin).get('tunnels',[]); sys.exit(0) if t and print('Tunnel UP at', t[0]['public_url']) is None else sys.exit(1)" 2>/dev/null; then \
		: ; \
	else \
		echo "Tunnel DOWN. Start with: make tunnel-up"; \
	fi

ios: install ensure-env ## Build frontend, sync iOS, open Xcode
	@set -a && . ./pinai-agents/.env && set +a && \
	MOBILE_TUNNEL_URL=$$(sed -n 's/^PAI_API_URL=//p' .env 2>/dev/null | tail -n 1 | sed -e 's/^"//' -e 's/"$$//'); \
	if [ -n "$(NGROK)" ]; then \
		echo "Using ngrok at $(NGROK)"; VITE_PIN_API_URL="$(NGROK)"; \
	elif [ "$(PROD)" = "1" ]; then \
		PROD_URL=$$(npx -y @dotenvx/dotenvx get VITE_PIN_API_URL -f pinai-agents/.env.production 2>/dev/null); \
		if [ -z "$$PROD_URL" ]; then echo "VITE_PIN_API_URL missing in prod env"; exit 1; fi; \
		VITE_PIN_API_URL="$$PROD_URL"; \
	elif [ "$(DEV)" = "1" ]; then \
		echo "Using fly dev at $$VITE_PIN_API_URL"; \
	elif [ -n "$$MOBILE_TUNNEL_URL" ]; then \
		VITE_PIN_API_URL="$$MOBILE_TUNNEL_URL"; \
		echo "Using local tunnel at $$VITE_PIN_API_URL (from ./.env PAI_API_URL)"; \
	else \
		echo "Using fly dev (default) at $$VITE_PIN_API_URL — override with NGROK=<url>, DEV=1, or PROD=1"; \
	fi; \
	VITE_PIN_API_URL="$$VITE_PIN_API_URL" \
		bash proactive-ai-frontend/scripts/sync-ios.sh && \
		cd proactive-ai-frontend && npx cap open ios

android: install ensure-env ## Build frontend, sync Android, install on USB device
	@set -e; \
	set -a && . ./pinai-agents/.env && set +a; \
	MOBILE_TUNNEL_URL=$$(sed -n 's/^PAI_API_URL=//p' .env 2>/dev/null | tail -n 1 | sed -e 's/^"//' -e 's/"$$//'); \
	if [ -n "$(NGROK)" ]; then \
		VITE_PIN_API_URL="$(NGROK)"; \
	elif [ "$(PROD)" = "1" ]; then \
		PROD_URL=$$(npx -y @dotenvx/dotenvx get VITE_PIN_API_URL -f pinai-agents/.env.production 2>/dev/null); \
		[ -z "$$PROD_URL" ] && { echo "VITE_PIN_API_URL missing in prod env"; exit 1; }; \
		VITE_PIN_API_URL="$$PROD_URL"; \
	elif [ "$(DEV)" = "1" ]; then \
		echo "Using fly dev at $$VITE_PIN_API_URL"; \
	elif [ -n "$$MOBILE_TUNNEL_URL" ]; then \
		VITE_PIN_API_URL="$$MOBILE_TUNNEL_URL"; \
		echo "Using local tunnel at $$VITE_PIN_API_URL (from ./.env PAI_API_URL)"; \
	else \
		echo "Using fly dev (default) at $$VITE_PIN_API_URL — override with NGROK=<url>, DEV=1, or PROD=1"; \
	fi; \
	cd proactive-ai-frontend && \
		VITE_CAPACITOR=1 VITE_PIN_API_URL="$$VITE_PIN_API_URL" \
		VITE_API_BASE_URL="$$VITE_PIN_API_URL" \
		npx vite build && npx cap sync android && \
		cd android && ./gradlew installDebug && \
		adb shell am start -n ai.pin.proactive.dev/.MainActivity
