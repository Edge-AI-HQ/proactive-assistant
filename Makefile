.PHONY: help up down build build-apis build-openclaw logs logs-apis logs-litellm migrate reset status

COMPOSE := docker compose

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── Setup & Environment ──

init: ## First-time setup: copy .env files from .env.example if missing
	@test -f apis/.env || (cp apis/.env.example apis/.env && echo "Created apis/.env from .env.example — fill in your secrets")
	@test -f ops/litellm/.env || (cp ops/litellm/.env.example ops/litellm/.env && echo "Created ops/litellm/.env from .env.example — fill in your secrets")
	@echo "Done. Review .env files, then run: make up"

# ── Build ──

build: ## Build all images (APIs + OpenClaw)
	$(COMPOSE) build apis openclaw-image

build-apis: ## Build only the APIs image
	$(COMPOSE) build apis

build-openclaw: ## Build only the OpenClaw image
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
