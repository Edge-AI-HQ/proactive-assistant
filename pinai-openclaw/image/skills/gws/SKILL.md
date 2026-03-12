---
name: gws
version: 1.0.0
description: "Google Workspace CLI entry skill. For Gmail/Drive/Calendar/People operations via gws."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
    cliHelp: "gws --help"
---

# gws (entry)

Use this skill as the entrypoint for Google Workspace CLI.

## Prerequisite

Read `../gws-shared/SKILL.md` first for auth and global rules.

## When to Use

- User asks for Gmail/Drive/Calendar/People tasks
- You need schema-driven Google API calls
- You need JSON-first output for agent parsing

## Priority Rule (Gmail)

If user asks to read/list/search Gmail and credentials are present, run `gws` directly first.
Do not default to browser setup flow unless `gws` returns an auth/API error.

## Command Shape

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

## References

- `../gws-gmail/SKILL.md` for Gmail operations
- `../gws-shared/SKILL.md` for auth, flags, and safety
- Official repo: `https://github.com/googleworkspace/cli`

## Notes

- Prefer JSON output and schema discovery (`gws schema ...`) before unfamiliar methods.
