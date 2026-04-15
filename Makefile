.PHONY: help init env-local ensure-env ensure-env-apis ensure-env-litellm
.PHONY: up down build build-apis build-openclaw restart status
.PHONY: logs logs-apis logs-litellm logs-postgres
.PHONY: migrate reset clean
.PHONY: deploy-dev deploy-prod deploy-litellm-dev deploy-litellm-prod build-openclaw-image
.PHONY: ios-sim ios-device

COMPOSE := docker compose
DOTENVX := npx @dotenvx/dotenvx

# Extract VITE_* as shell exports for docker-compose build args.
# docker-compose.yml references ${VITE_*} in apis.build.args;
# these exports make them available during `docker compose build`.
define export_vite
export VITE_SUPABASE_URL=$$($(DOTENVX) get VITE_SUPABASE_URL -f apis/.env.dev 2>/dev/null) && \
export VITE_SUPABASE_PUBLISHABLE_KEY=$$($(DOTENVX) get VITE_SUPABASE_PUBLISHABLE_KEY -f apis/.env.dev 2>/dev/null) && \
export VITE_API_BASE_URL=$$($(DOTENVX) get VITE_API_BASE_URL -f apis/.env.dev 2>/dev/null)
endef

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ── Environment: auto-decrypt .env.dev → .env ──
# Triggers when .env is missing or .env.dev is newer.
# Requires .env.keys (get from team members).

ensure-env: ensure-env-apis ensure-env-litellm ## Auto-decrypt all .env files if needed

ensure-env-apis:
	@if [ ! -f apis/.env ] || [ apis/.env.dev -nt apis/.env ]; then \
		if [ ! -f apis/.env.keys ]; then \
			echo "Missing apis/.env.keys"; \
			echo "  Get .env.keys from team members"; \
			exit 1; \
		fi; \
		echo "Decrypting apis/.env.dev -> apis/.env"; \
		$(DOTENVX) get -f apis/.env.dev --format json 2>/dev/null \
			| python3 -c 'import json,sys;[print(k+"="+chr(39)+str(v)+chr(39)) for k,v in json.load(sys.stdin).items() if not k.startswith("DOTENV_PUBLIC_KEY")]' \
			> apis/.env; \
	fi

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

env-local: ## Force re-decrypt all .env files
	@rm -f apis/.env ops/litellm/.env
	@$(MAKE) --no-print-directory ensure-env

# ── Setup ──

init: ## First-time setup: install deps and show next steps
	npm install
	@echo ""
	@echo "Next steps:"
	@echo "  1. Get .env.keys from team members"
	@echo "     Place:  apis/.env.keys"
	@echo "             ops/litellm/.env.keys"
	@echo "  2. make up  (auto-decrypts and starts everything)"

# ── Build ──

build: ## Build all images (APIs + OpenClaw)
	$(export_vite) && $(COMPOSE) build apis openclaw-image

build-apis: ## Build only the APIs image
	$(export_vite) && $(COMPOSE) build apis

build-openclaw: ## Build only the local OpenClaw image
	$(COMPOSE) build openclaw-image

# ── Run ──

up: ensure-env ## Build and start all services
	$(export_vite) && $(COMPOSE) build apis openclaw-image
	$(COMPOSE) up -d

down: ## Stop all services
	$(COMPOSE) down

restart: ensure-env ## Restart all services (rebuild APIs to pick up changes)
	$(export_vite) && $(COMPOSE) build apis
	$(COMPOSE) up -d --force-recreate apis

status: ## Show running containers
	$(COMPOSE) ps

# ── Logs ──

logs: ## Tail all logs
	$(COMPOSE) logs -f

logs-apis: ## Tail APIs logs
	$(COMPOSE) logs -f apis

logs-litellm: ## Tail LiteLLM logs
	$(COMPOSE) logs -f litellm

logs-postgres: ## Tail Postgres logs
	$(COMPOSE) logs -f postgres

# ── Database ──

migrate: ## Run database migrations
	$(COMPOSE) up db-migrate

# ── Reset ──

reset: ensure-env ## Stop everything, delete volumes, rebuild and start fresh
	$(COMPOSE) down -v
	$(export_vite) && $(COMPOSE) build apis openclaw-image
	$(COMPOSE) up -d

clean: ## Stop everything and delete all volumes (data loss!)
	$(COMPOSE) down -v
	@echo "All containers and volumes removed."

# ── Deploy (Fly.io) ──
# VITE_* are extracted from dotenvx encrypted files and passed as --build-arg.
# Runtime secrets are decrypted inside the container via dotenvx run (Dockerfile CMD).

define extract_vite_args
$(shell $(DOTENVX) get -f apis/.env.$(1) --format json 2>/dev/null \
	| python3 -c 'import json,sys;d=json.load(sys.stdin);[print("--build-arg "+k+"="+v) for k,v in d.items() if k.startswith("VITE_")]')
endef

deploy-dev: ## Deploy APIs to dev environment
	env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.api-dev.toml --remote-only \
		$(call extract_vite_args,dev)

deploy-prod: ## Deploy APIs to prod environment (requires review)
	@echo "Deploying to PRODUCTION. Ctrl+C to cancel."
	@sleep 3
	env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.api-prod.toml --remote-only \
		$(call extract_vite_args,production)

deploy-litellm-dev: ## Deploy LiteLLM to dev environment
	cd ops/litellm && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.litellm-dev.toml --remote-only

deploy-litellm-prod: ## Deploy LiteLLM to prod environment
	@echo "Deploying LiteLLM to PRODUCTION. Ctrl+C to cancel."
	@sleep 3
	cd ops/litellm && env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.litellm-prod.toml --remote-only

build-openclaw-image: ## Build and push OpenClaw image to shared registry
	env -u all_proxy -u http_proxy -u https_proxy \
		bash scripts/build-openclaw-image.sh

# ── iOS ──

ios-sim: ensure-env ## Build frontend and run in iOS Simulator (local backend)
	cd proactive-ai-frontend && \
		VITE_API_BASE_URL=http://localhost:3000 \
		VITE_SUPABASE_URL=$$($(DOTENVX) get VITE_SUPABASE_URL -f ../apis/.env.dev 2>/dev/null) \
		VITE_SUPABASE_PUBLISHABLE_KEY=$$($(DOTENVX) get VITE_SUPABASE_PUBLISHABLE_KEY -f ../apis/.env.dev 2>/dev/null) \
		VITE_CAPACITOR=1 npx vite build && \
		npx cap run ios --target "iPhone 16"
