.PHONY: help up down build build-apis build-openclaw logs logs-apis logs-litellm migrate reset status clean
.PHONY: deploy-dev deploy-prod deploy-litellm-dev deploy-litellm-prod build-openclaw-image

COMPOSE := docker compose

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ── Setup & Environment ──

init: ## First-time setup: copy .env files, show next steps
	@test -f apis/.env || (cp apis/.env.example apis/.env && echo "Created apis/.env from .env.example")
	@test -f ops/litellm/.env || (cp ops/litellm/.env.example ops/litellm/.env && echo "Created ops/litellm/.env from .env.example")
	@echo ""
	@echo "Next steps:"
	@echo "  1. Fill in secrets in apis/.env and ops/litellm/.env"
	@echo "  2. Get dotenvx private keys from 1Password (search 'PIN-AI .env.keys')"
	@echo "  3. Place apis/.env.keys and ops/litellm/.env.keys"
	@echo "  4. Run: make up"

# ── Build ──

build: ## Build all images (APIs + OpenClaw)
	$(COMPOSE) build apis openclaw-image

build-apis: ## Build only the APIs image
	$(COMPOSE) build apis

build-openclaw: ## Build only the local OpenClaw image
	$(COMPOSE) build openclaw-image

# ── Run ──

up: ## Build and start all services
	$(COMPOSE) build apis openclaw-image
	$(COMPOSE) up -d

down: ## Stop all services
	$(COMPOSE) down

restart: ## Restart all services (rebuild APIs to pick up changes)
	$(COMPOSE) build apis
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

reset: ## Stop everything, delete volumes, rebuild and start fresh
	$(COMPOSE) down -v
	$(COMPOSE) build apis openclaw-image
	$(COMPOSE) up -d

clean: ## Stop everything and delete all volumes (data loss!)
	$(COMPOSE) down -v
	@echo "All containers and volumes removed."

# ── Deploy (Fly.io) ──

deploy-dev: ## Deploy APIs to dev environment
	env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.api-dev.toml --remote-only

deploy-prod: ## Deploy APIs to prod environment (requires review)
	@echo "Deploying to PRODUCTION. Ctrl+C to cancel."
	@sleep 3
	env -u all_proxy -u http_proxy -u https_proxy \
		flyctl deploy --config fly.api-prod.toml --remote-only

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
