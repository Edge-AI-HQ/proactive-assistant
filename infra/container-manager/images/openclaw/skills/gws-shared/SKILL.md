---
name: gws-shared
version: 1.0.0
description: "gws CLI shared rules: auth, command patterns, and safety."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
---

# gws shared

## Auth Precedence

`gws` follows this auth precedence:

1. `GOOGLE_WORKSPACE_CLI_TOKEN`
2. `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`
3. encrypted account credentials in `~/.config/gws/`
4. plaintext `~/.config/gws/credentials.json`

In our container, prefer:

- `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/app/google/gws-credentials.json`
- fallback `~/.config/gws/credentials.json`

If either credential file exists, do not ask user to re-authorize first. Execute `gws`.

## Core Commands

```bash
gws <service> <resource> [sub-resource] <method> [flags]
gws schema <service.resource.method>
```

Useful flags:

- `--params '<json>'`
- `--json '<json>'`
- `--page-all`
- `--page-limit <N>`
- `--dry-run`

## Safety

- Read-only requests (list/get/search): run directly.
- Write/delete/send requests: ask user confirmation first.
- Do not expose tokens/secrets in replies.
