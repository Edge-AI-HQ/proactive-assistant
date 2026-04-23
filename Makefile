.PHONY: help init env-local ensure-env ensure-env-apis ensure-env-litellm
.PHONY: up down build build-apis build-openclaw restart status
.PHONY: ensure-local-compose build-apis-local build-openclaw-local up-local down-local status-local logs-local restart-apis-local
.PHONY: logs logs-apis logs-litellm logs-postgres
.PHONY: migrate reset clean
.PHONY: deploy-dev deploy-prod deploy-litellm-dev deploy-litellm-prod build-openclaw-image
.PHONY: ios

COMPOSE := docker compose
DOTENVX := npx @dotenvx/dotenvx
LOCAL_COMPOSE_FILE := $(CURDIR)/.git/pinai-docker-compose.local.yml
LOCAL_IPV4_SUBNET ?= 172.21.0.0/16
LOCAL_IPV6_SUBNET ?= fd00:21::/64
COMPOSE_LOCAL := $(COMPOSE) --project-directory $(CURDIR) -f $(LOCAL_COMPOSE_FILE)

# Auto-pick npm registry based on OS timezone: China → npmmirror, else npmjs.
# Manual override: export NPM_REGISTRY=... in shell before running make.
# Reads symlink target of /etc/localtime (works on macOS and Linux).
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

# Extract VITE_* as shell exports for docker-compose build args.
# docker-compose.yml references ${VITE_*} in apis.build.args;
# these exports make them available during `docker compose build`.
#
# Sources apis/.env directly (already decrypted by ensure-env-apis) instead of
# re-running npx dotenvx — npx hits the npm registry on every call and has
# hung the build before. All ensure-env-* rules guarantee apis/.env exists.
define export_vite
set -a && . ./apis/.env && set +a
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

build: ensure-env-apis ## Build all images (APIs + OpenClaw)
	$(export_vite) && $(COMPOSE) build apis openclaw-image

build-apis: ensure-env-apis ## Build only the APIs image
	$(export_vite) && $(COMPOSE) build apis

build-openclaw: ## Build only the local OpenClaw image
	$(COMPOSE) build openclaw-image

ensure-local-compose: ## Generate a local compose file with a non-conflicting Docker subnet
	@python3 -c "from pathlib import Path; src = Path('docker-compose.yml').read_text(); src = src.replace('172.18.0.0/16', '$(LOCAL_IPV4_SUBNET)').replace('fd00:18::/64', '$(LOCAL_IPV6_SUBNET)'); Path('$(LOCAL_COMPOSE_FILE)').write_text(src)"

build-apis-local: ensure-env-apis ## Build the APIs image locally without BuildKit remote metadata fetch
	$(export_vite) && DOCKER_BUILDKIT=0 docker build --pull=false \
		-t pin-ai-assistant-apis:latest \
		-f apis/Dockerfile \
		--build-arg VITE_SUPABASE_URL="$$VITE_SUPABASE_URL" \
		--build-arg VITE_SUPABASE_PUBLISHABLE_KEY="$$VITE_SUPABASE_PUBLISHABLE_KEY" \
		--build-arg VITE_API_BASE_URL="$$VITE_API_BASE_URL" \
		.

build-openclaw-local: ## Build the OpenClaw image locally without BuildKit remote metadata fetch
	DOCKER_BUILDKIT=0 docker build --pull=false \
		-t pinai-openclaw:latest \
		-f pinai-openclaw/image/Dockerfile \
		.

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

up-local: ensure-env ensure-local-compose build-apis-local build-openclaw-local ## Build and start the local stack using stable local Docker settings
	$(COMPOSE_LOCAL) up -d postgres db-migrate litellm apis

down-local: ensure-local-compose ## Stop the local stack created by up-local
	$(COMPOSE_LOCAL) down

status-local: ensure-local-compose ## Show local stack container status
	$(COMPOSE_LOCAL) ps

logs-local: ensure-local-compose ## Tail all local stack logs
	$(COMPOSE_LOCAL) logs -f

restart-apis-local: ensure-local-compose build-apis-local ## Rebuild and recreate only the APIs container in the local stack
	$(COMPOSE_LOCAL) up -d --force-recreate --no-deps apis

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
	@ids=$$(docker ps -aq --filter name=proactive-); \
	if [ -n "$$ids" ]; then \
		echo "Removing dynamically-created OpenClaw containers"; \
		echo "$$ids" | xargs docker rm -f; \
	fi
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
# NOTE: The Xcode project (project.pbxproj) uses Team "DH9AJ6A38D" for signing.
# If your Apple ID is not a member of that team, Cmd+R in Xcode will fail with
# "No Account for Team". Workaround: build via CLI with your own team override:
#
#   cd proactive-ai-frontend/ios/App && \
#     xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
#       -destination 'generic/platform=iOS' -allowProvisioningUpdates \
#       DEVELOPMENT_TEAM=<YOUR_TEAM_ID> \
#       PRODUCT_BUNDLE_IDENTIFIER=ai.pin.proactive.dev \
#       build
#
# Then install: xcrun devicectl device install app --device <DEVICE_ID> \
#   ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app
#
# Long-term fix: ask the team admin to invite your Apple ID to Team DH9AJ6A38D.

ios: ensure-env ## Build frontend, sync iOS, and open Xcode. Defaults to local docker APIs over LAN; DEV=1 connects to fly dev.
	@set -a && . ./apis/.env && set +a && \
	if [ "$(DEV)" = "1" ]; then \
		echo "Using fly dev APIs at $$VITE_API_BASE_URL"; \
	else \
		LAN_IP=$$(ipconfig getifaddr en0); \
		if [ -z "$$LAN_IP" ]; then LAN_IP=$$(ipconfig getifaddr en1); fi; \
		if [ -z "$$LAN_IP" ]; then echo "Could not detect LAN IP from en0/en1"; exit 1; fi; \
		echo "Using local APIs at http://$$LAN_IP:3000"; \
		VITE_API_BASE_URL="http://$$LAN_IP:3000"; \
	fi; \
	cd proactive-ai-frontend && \
		VITE_CAPACITOR=1 npx vite build && \
		npx cap sync ios && \
		npx cap open ios
	@echo ""
	@echo "Xcode is open. Select your device at the top, then press Cmd+R to build and run."
