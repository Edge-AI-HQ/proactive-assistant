# pin-cli

Local-first CLI for proactive AI tooling. This package is currently a standalone tool and does not depend on OpenClaw runtime behavior.

## Current Scope

- `pin sys doctor`
- `pin profile create`
- `pin profile get`
- `pin profile list`
- `pin profile update`
- `pin profile delete`
- `pin profile preferences get|set|unset`
- `pin profile goals list|upsert|close`
- `pin profile constraints get|set|unset`

Storage:

- single SQLite database at `PIN_DATA_ROOT/data/pin.db`
- default data root is `<current-working-directory>/.pin`

## Install

From [pin-cli/package.json](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/package.json):

```bash
cd /Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli
npm install
npm run build
npm link
```

After that, `pin` is available in your shell.

## Verify

```bash
cd /Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli
npm run test
npm run type-check
npm run build
```

## Quick Start

Check runtime and database path:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin sys doctor --json
```

Create a profile:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin profile create \
  --id demo \
  --display-name Alice \
  --locale en-US \
  --timezone Asia/Shanghai \
  --summary "Demo profile" \
  --metadata '{"source":"manual"}' \
  --json
```

Read it back:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin profile get --id demo --json
PIN_DATA_ROOT=/tmp/pin-demo pin profile list --json
```

Update it:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin profile update \
  --id demo \
  --display-name "Alice Updated" \
  --metadata '{"source":"manual","stage":"updated"}' \
  --json
```

Delete it:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin profile delete --id demo --json
```

Set and read preferences:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin profile preferences set \
  --key content_topics \
  --value-json '["ai","startups"]' \
  --json

PIN_DATA_ROOT=/tmp/pin-demo pin profile preferences get --json
```

Manage goals:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin profile goals upsert \
  --key career \
  --title "Find startup opportunities" \
  --priority high \
  --json

PIN_DATA_ROOT=/tmp/pin-demo pin profile goals list --json
PIN_DATA_ROOT=/tmp/pin-demo pin profile goals close --key career --json
```

Manage constraints:

```bash
PIN_DATA_ROOT=/tmp/pin-demo pin profile constraints set \
  --key quiet_hours \
  --value-json '"23:00-08:00"' \
  --json

PIN_DATA_ROOT=/tmp/pin-demo pin profile constraints get --json
PIN_DATA_ROOT=/tmp/pin-demo pin profile constraints unset --key quiet_hours --json
```

## Notes

- `profile create` uses `id` as the primary key.
- Repeating `create` with the same `id` returns a conflict.
- `metadata` must be a JSON object string.
- `preferences` and `constraints` are stored as keyed JSON objects on the default profile row.
- `goals` are stored as a JSON array on the default profile row.
- `npm run dev` uses `node --import tsx` to avoid the `tsx` IPC issue seen in restricted environments.

## Development Layout

- [src/cli.ts](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/src/cli.ts): command registration and runtime wiring
- [src/domains/profile/schema.ts](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/src/domains/profile/schema.ts): Drizzle schema
- [src/domains/profile/repository.ts](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/src/domains/profile/repository.ts): CRUD repository
- [src/domains/profile/register.ts](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/src/domains/profile/register.ts): CLI command registration
- [src/domains/profile/service.ts](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/src/domains/profile/service.ts): profile command execution logic
- [src/db/sqlite_adapter.ts](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/src/db/sqlite_adapter.ts): Drizzle and SQLite client wrapper
- [drizzle.config.ts](/Users/heyuehui/Desktop/PINAI/PIN-AI-ASSISTANT/pin-cli/drizzle.config.ts): Drizzle config
