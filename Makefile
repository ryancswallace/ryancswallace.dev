SHELL := /bin/bash

PNPM ?= pnpm
DOCKER_COMPOSE ?= docker compose
PORT ?= 4321
PREVIEW_PORT ?= 4322

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help message.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: install
install: ## Install project dependencies.
	$(PNPM) install

.PHONY: install-frozen
install-frozen: ## Install dependencies exactly as locked.
	$(PNPM) install --frozen-lockfile

.PHONY: dev
dev: ## Start the Astro dev server for local/devcontainer access.
	$(PNPM) run dev

.PHONY: dev-local
dev-local: ## Start Astro on localhost only.
	$(PNPM) exec astro dev --host 127.0.0.1 --port $(PORT)

.PHONY: preview
preview: build ## Build and preview the production site.
	$(PNPM) exec astro preview --host 0.0.0.0 --port $(PREVIEW_PORT) --allowed-hosts

.PHONY: build
build: ## Type-check, build to dist, and generate Pagefind assets.
	$(PNPM) run build

.PHONY: check
check: ## Run Astro content, type, and diagnostics checks.
	$(PNPM) exec astro check

.PHONY: sync
sync: ## Generate Astro content types.
	$(PNPM) run sync

.PHONY: lint
lint: ## Run ESLint.
	$(PNPM) run lint

.PHONY: format
format: ## Format files with Prettier.
	$(PNPM) run format

.PHONY: format-check
format-check: ## Check formatting with Prettier.
	$(PNPM) run format:check

.PHONY: test
test: check lint format-check ## Run the project's verification suite.

.PHONY: ci
ci: install-frozen test build ## Run the local CI sequence.

.PHONY: astro
astro: ## Run an Astro CLI command, e.g. make astro ARGS="info".
	$(PNPM) exec astro $(ARGS)

.PHONY: pagefind
pagefind: build ## Rebuild search indexes and copy them into public/pagefind.

.PHONY: outdated
outdated: ## Show outdated dependencies.
	$(PNPM) outdated

.PHONY: audit
audit: ## Audit dependencies for known vulnerabilities.
	$(PNPM) audit

.PHONY: clean
clean: ## Remove generated build/cache artifacts.
	rm -rf dist .astro public/pagefind

.PHONY: reset
reset: clean ## Remove dependencies and generated artifacts.
	rm -rf node_modules

.PHONY: reinstall
reinstall: reset install ## Reinstall dependencies from scratch.

.PHONY: docker-up
docker-up: ## Start the Docker Compose development service.
	$(DOCKER_COMPOSE) up

.PHONY: docker-up-detached
docker-up-detached: ## Start the Docker Compose development service in the background.
	$(DOCKER_COMPOSE) up --detach

.PHONY: docker-down
docker-down: ## Stop Docker Compose services.
	$(DOCKER_COMPOSE) down

.PHONY: docker-logs
docker-logs: ## Follow Docker Compose logs.
	$(DOCKER_COMPOSE) logs --follow

.PHONY: docker-shell
docker-shell: ## Open a shell in the Docker Compose app service.
	$(DOCKER_COMPOSE) exec app bash

.PHONY: devcontainer-tools
devcontainer-tools: ## Run the devcontainer tool installation script.
	.devcontainer/scripts/install-dev-tools.sh
