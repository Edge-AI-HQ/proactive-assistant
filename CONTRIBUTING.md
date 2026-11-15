# Contributing to PIN AI

Thanks for your interest in PIN AI. This guide covers the essentials; [AGENTS.md](AGENTS.md) is the single source of truth for architecture rules, hard constraints and the full command reference.

## How this repository works

This repository is a read-only public mirror. Development happens in the maintainers' private repository, and `main` plus release tags are synced here automatically. Pull requests are turned off here, and nothing is merged directly into this repository.

The best way to contribute is an issue: report a bug with steps to reproduce, or describe a feature or change you would like. If you have a patch in mind, describe it in the issue (a diff in the issue body is fine); a maintainer will apply accepted changes in the development repository and they will show up here with the next sync.

The rest of this guide describes how the maintainers work in the development repository, which is useful context if you want to run, read or patch the code.

## Before you start

- For bugs, open an issue with steps to reproduce. For larger changes, open an issue first so we can agree on the approach.
- Security issues go through [SECURITY.md](SECURITY.md), never a public issue.
- Be kind and constructive. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Follow [Quick start](README.md#quick-start) in the README; it starts from the `.env.example` files, since the maintainers' encrypted env files are not published. [AGENTS.md › Local Development](AGENTS.md#local-development) explains the full Docker stack, running services without Docker, parallel worktrees, and the desktop and iOS builds.

## Making a change

1. Branch from `main`. `main` is protected: every change lands through a pull request with green CI.
2. Keep the change focused. Read the existing code before changing it, fix root causes instead of working around them, and avoid unrelated refactors. The full list of coding principles is at the top of [AGENTS.md](AGENTS.md#coding-principles).
3. If you change a core flow, update the matching module doc in `docs/modules/`.
4. Database changes are new files in `backend/db/migrations/` named `NNN_<topic>.sql`. Migrations are additive only, and a migration that has been merged is never edited. New tables that hold user data need a row-level security policy.
5. Never let master credentials reach the `agent-engine` process. Read the docstring of `backend/services/agent-engine/src/agent_engine/trust_boundary.py` before touching how secrets are injected.

## Checks

Run the checks that match what you changed:

| Changed | Run |
|---|---|
| Python (`backend/`) | `cd backend && uv run ruff format --check && uv run ruff check && uv run lint-imports && uv run mypy services libs` plus the relevant `uv run pytest tests/<path>` |
| Shared packages (`packages/`) | `npm run check:packages`, plus the type-check of each app that consumes the package |
| Web app (`apps/web/`) | `cd apps/web && npm run type-check && npm test` |
| Desktop (`apps/desktop/`) | `cd apps/desktop && npm run type-check` |
| iOS app (`apps/mobile/`) | `cd apps/mobile && npm run type-check` |
| Internal review tool (`internal-reward-dashboard/`) | `cd internal-reward-dashboard && npm run type-check && npm test` |

CI runs the same gates (`pinai-agents-checks` and `frontend-check`) on every pull request.

## Commits and pull requests

- Write commit messages, PR titles and PR descriptions in English.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `chore: ...`.
- One logical change per commit.
- In the PR description, explain what changed and why, and list how you verified it.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
