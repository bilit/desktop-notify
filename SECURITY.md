# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead: on this repository, open the **Security** tab, choose **Report a vulnerability**,
and describe what you found. Only the maintainer can see it. Helpful details: what is affected (`notify-server`,
`notify-web`, the overlay), the version, steps to reproduce, and what an attacker gains.

This is a small project run by one person, so reports are handled on a best-effort basis. I will acknowledge a report as
soon as I can, and I would rather fix a real problem properly than quickly.

## Supported versions

Only the latest release on the default branch receives fixes. The project is pre-1.0 (`0.x`) and its API may change.

## What is already known

These are documented design limits, not vulnerabilities, but they matter when you deploy:

- **Identity is yours.** The library never authenticates anyone itself: your `authenticate(req)` decides who a browser
  connection is, and your `authenticateDesktop` decides who an overlay is. A bug in those functions is a bug in your
  application.
- **A claimed username is not a login.** The overlay announces a username on connect. The server ignores it unless you
  opt in through `authenticateDesktop`, and returning it as-is lets anyone who can reach the server read that user's
  notifications and act as them. Use it only on a network you trust.
- **Device tokens cannot be revoked individually.** They expire (7 days by default); rotating `secret` invalidates all
  of them.
- **The standalone hub is for development.** It has one user and one shared token, and it refuses to listen beyond
  loopback unless you set a custom `NOTIFY_TOKEN` of 16+ characters. It has no rate limiting.
- **No rate limiting anywhere yet,** and inbound messages are only size-capped.
- **The overlay's Content-Security-Policy is currently disabled** (`app.security.csp` is `null` in `tauri.conf.json`).

See "Security status" in the README for the current state.

## Scope

In scope: the code in this repository (`packages/server`, `packages/web`, `apps/overlay`, `tools/`). Out of scope:
vulnerabilities in third-party dependencies (report those upstream; I will update once a fix exists), and issues that
need an attacker who already controls the user's machine or your backend.
