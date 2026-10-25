# Nexagent

One backend for Claude Code, Codex, Cursor, OpenCode, and WorkBuddy, on your
desktop, phone, or remote device.

[简体中文](README.zh-CN.md) · [Releases](https://github.com/WGeorgezzzz/claudex/releases)
· [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

![Nexagent desktop workspace with fictional demo conversations](public/screenshots/desktop-main.png)

<img src="public/screenshots/mobile-chat.png" width="260" alt="Nexagent mobile workspace with demo data" />

## What you can do

- Work with multiple coding agents in one project workspace, including local
  agent discovery, version detection, authentication status, and rescan.
- Continue conversations on a phone; edit files, inspect diffs, use the terminal,
  and keep server-owned work running when the browser closes.
- Create member accounts with separate project access, credentials, and preferences.
  Administrators manage accounts and the shared provider catalog.
- Inspect Claude subscription windows, personal relay usage, and administrator-only
  relay account quotas. Credit balance changes and stale data are explicit.
- Queue prompts, branch side conversations, organize sessions, and schedule monitors.
- Connect remotely without owning a domain: Dev Tunnels, Tailscale, or a temporary
  Cloudflare tunnel. Remote requests always require a Nexagent login.

## Quick start

### Desktop installers

Get **Nexagent 1.0.0** from [Releases](https://github.com/WGeorgezzzz/claudex/releases).
The release is prepared as a **draft** until maintainer review; draft assets are
visible only to repository maintainers. Compare the download with `SHA256SUMS`.

| Platform | Artifact | Notes |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | Includes Node.js and backend; unsigned |
| macOS Apple silicon | `.dmg` | Unsigned and not notarized |
| Linux x64 | `.tar.gz` | Extract and run `nexagent`; desktop session required |

On macOS, drag Nexagent into Applications. For a verified download, use
**System Settings → Privacy & Security → Open Anyway** after the first blocked
launch. Managed devices may require administrator approval. Do not disable
Gatekeeper globally. On Windows, inspect the source and checksum before accepting
an unsigned-app prompt.

The first launch creates an OS-protected local administrator, scans installed
agents, and offers remote administrator and tunnel setup. Remote access is optional.
The desktop has its own data profile and never takes over another running backend.
See [desktop profiles](docs/DESKTOP.md) for paths and upgrade behavior.

### npm

Node.js **22.21+** or **24.5+** and Git are recommended. Native modules may require
platform build tools. The source package is named `nexagent`;
**1.0.0 has not been published to npm yet**. After npm publication:

```bash
npm install -g nexagent@1.0.0
nexagent start --port 3001
```

For a maintainer-provided archive before publication:

```bash
npm install ./nexagent-1.0.0.tgz
npx --no-install nexagent start --port 3001
```

Open `http://localhost:3001` and create the first administrator. Install and sign
in to your chosen agent locally; detection never automatically installs agents.

### From source

```bash
git clone https://github.com/WGeorgezzzz/claudex.git
cd claudex
npm ci
npm run build
node dist-server/server/modules/cli/cli.js start --port 3001
```

Use `npm run dev` for development. `npm test`, `npm run test:client`,
`npm run typecheck`, and `npm run lint` are the regression checks.

## Remote access

Open **Settings → Remote access** as an administrator:

| Method | Identity / reachability | Address |
| --- | --- | --- |
| Microsoft Dev Tunnels | GitHub device login; private by default | Persistent tunnel ID |
| Tailscale Serve | Your tailnet devices | `*.ts.net` |
| Tailscale Funnel | Public, when supported and enabled | `*.ts.net` |
| Cloudflare quick tunnel | No tunnel account; public | Temporary `*.trycloudflare.com` |
| Custom domain | Your tunnel and Cloudflare Access configuration | Your hostname |

The service and host machine must remain running. Providers have their own
accounts, terms, quotas, and availability. A tunnel does not grant application
access: administrators use a remote password and TOTP; members use their own
passwords. QR codes contain the address, never login credentials.

## Quotas and security

Set `NEXAGENT_RELAY_BASE_URL=https://relay.example.com` or save the URL in
**Settings → Usage → 中转地址**. Without it, relay quotas show **未配置中转**.
Use a sub2api-compatible relay; arbitrary OpenAI-compatible generation endpoints
may not implement these management and usage APIs. See [quota configuration](docs/QUOTA.md).

Only administrators can change relay settings or manage tunnels. Relay admin
credentials stay outside the repository and are bound to their destination URL.
Claude OAuth credentials are read locally and never refreshed by the dashboard.
Quota views observe usage; the relay scheduler enforces limits. Nexagent has no
credit-reset action and makes no guarantee that other clients cannot spend credits.

Coding agents and terminals can change host files and execute commands. Share this
service only with trusted users, restrict project access, keep the origin on
loopback, and configure the remote boundary before exposing it. See
[custom-domain access](docs/PRIVATE-ACCESS.md). Report vulnerabilities privately
through GitHub's security reporting when available; never post credentials in issues.

## Upstream and license

Nexagent is an independently maintained fork of
[CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui), based on
upstream 1.37.5. It is not an official product of Anthropic, OpenAI, Cursor,
Microsoft, or the upstream maintainers. Provider trademarks belong to their owners.

Licensed under **AGPL-3.0-or-later**, including the existing additional terms in
[LICENSE](LICENSE). Upstream attribution is retained in [NOTICE](NOTICE).
If you distribute modified versions or offer them over a network, comply with
the license's corresponding-source obligations.
