# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's
**Security** tab and use **"Report a vulnerability"** (private advisory). Do not
open a public issue for security problems.

This is a hobby project — response is best-effort, with no guaranteed timeline.

## Scope

In scope:

- the password login and session-cookie handling (`/auth/*`)
- the proxied Devin API endpoints (`/api/*`) — anything that lets a caller reach
  endpoints or data beyond the fixed whitelist
- the optional Local tab (`/api/local/*`, `ENABLE_LOCAL=1`) — local file reads,
  the Devin CLI token, and the spawned `devin acp` process

Out of scope: vulnerabilities in Devin itself or the Devin API (report those to
Cognition), and issues that require the attacker to already know the panel
password — anyone with it can already spend the owner's Devin quota.
