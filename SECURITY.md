# Security Policy

PIN AI handles personal data and connects to third-party accounts, so we take security reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.

Include as much of the following as you can:

- what the issue is and what an attacker could do with it,
- the affected component (for example `api`, `agent-engine`, the web app or the iOS app) and version or commit,
- steps to reproduce or a proof of concept.

We will acknowledge your report, keep you updated while we investigate, and credit you in the fix if you would like.

## Scope

We are especially interested in issues that break these guarantees:

- master credentials never reach the `agent-engine` process,
- one user can never read or change another user's data,
- side-effecting connector actions and destructive browser actions always require the user's approval.

## Supported versions

Security fixes are made on the `main` branch and included in the next release.
