# Security policy

Seti runs Claude Code agents with shell access on your machine, so a flaw in it can hand that
access to someone else. Reports are welcome and handled privately.

## Reporting a vulnerability

Report it privately through GitHub: open this repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue or pull request for it.

Include what an attacker can reach, the steps to reproduce, the Seti commit you tested, and how
Seti was exposed (loopback only, a reverse proxy, or Cloudflare Tunnel and Access).

You get an acknowledgement within 3 days and an assessment within 7. A confirmed issue is fixed on
`main` and credited in the advisory unless you ask otherwise. Please keep it private until the fix
is released.

## Supported versions

Seti is released from `main`; fixes land there and are not backported. Run a recent `main`.

## Scope

In scope: anything that lets someone without the owner's sign-in drive Seti's API, read a secret or
a connection value, escape an agent's sandbox or egress allowlist, act beyond an agent's Seti
control level, change security settings from the EA or an agent, or break the audit chain. Public
surfaces (share links, webhooks, the demo) are in scope too.

Out of scope: attacks that need the owner's own sign-in or shell on the host, an agent the owner
gave Bypass or an unsandboxed setup, and denial of service from a client the owner admitted.

[docs/security.md](docs/security.md) describes the security model these rest on.
