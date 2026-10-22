# Claudex 0.5.0 — Windows x64

Claudex is an independently maintained Windows desktop project,
based on upstream CloudCLI 1.37.5. It retains the upstream AGPL-3.0-or-later
license and notices.

## Install alongside an existing client

Download `Claudex-0.5.0-win-x64.exe` and `SHA256SUMS.txt` from this
release. The installer is currently **unsigned**. The package includes its own
Node.js 22 runtime and backend dependencies; a global Node.js installation is
not required to start the desktop app.

The application name, installer identity, protocol, browser storage and backend
data are separate from an existing CloudCLI installation:

- Application: **Claudex**
- App ID: `io.github.wgeorgezzzz.cloudcli-workbench`
- Protocol: `cloudcli-workbench://`
- Default profile: `%APPDATA%\CloudCLI Workbench`
- Database and attachments: the profile's `server` directory
- Default Claude configuration: the profile's `providers\claude` directory
- Preferred service port: **3016**, falling back to a free port if occupied

The application only reuses a service with its own persisted installation ID.
An older Workbench backend owning the same profile is never replaced or joined automatically during an upgrade; finish its work and stop that service first.

An inherited `SERVER_PORT=3001`, `DATABASE_PATH`, upstream server URL or runtime
path does not make it attach to another client. Installing does not launch the
app automatically, replace the existing client or migrate its live database.
Old application data is retained when this package is uninstalled.

Create a local account on first use. To use an existing CLI configuration, open
the native launcher’s **Local Settings → Claude profile** and supply absolute
paths to its configuration directory and optional CLI executable or `.js`
wrapper. No credentials or personal wrapper are included in the installer.
Settings changes apply on the next backend start and do not restart running
work. Complete the Workbench jobs before stopping its service to apply changes.
The default **Keep server running** option preserves work when the GUI exits.

Upstream npm updates are disabled in this distribution. Install future Workbench
releases from this repository. Finish Workbench jobs before upgrading or
uninstalling its binaries; this installer does not migrate a running backend.

## Side conversations

Side conversations have server-owned parent/child relationships. Multiple side
conversations can be created, selected, renamed, archived, restored and promoted
to the main conversation list. Their inherited context is folded by default.
Reopening from another browser reads the same relationships. Version 0.1.1 freezes the display boundary after the SDK copy completes, because the SDK can rewrite the copied final reply timestamp. Older side conversations without a reliable boundary keep their full history visible.

Closing or archiving a side conversation does not stop its running work. Parent
and child transcripts are independent, but project files are shared. “Return
answer” inserts text into the parent’s draft; it does not send that draft.
Existing browser-only side links are adopted only after the server verifies
their real fork relationship.

## Message queue

Messages submitted while a conversation is busy are stored as distinct FIFO
entries. Closing the page does not lose them. The queue supports pending edits,
cancellation, explicit retries and execution records.

- A client request ID makes an uncertain transport retry idempotent.
- Revisions reject stale edits or cancellation after execution has started.
- A failed or interrupted entry pauses later work in that conversation.
- Retrying retains earlier execution attempts.
- Restarting marks unconfirmed running entries interrupted; it never silently
  replays them. Pending entries remain stored.
- Queue dispatch waits for foreground work, held background work and detected
  external CLI ownership. It never interrupts an existing run.
- Old single-slot queued drafts are imported transactionally before dispatch.

## Build and verification

Version 0.5 adds daily and weekly calendar monitors with explicit IANA timezones,
alongside existing completion-relative intervals. Configure them from the chat's
monitor panel, the global monitor manager, or the session-scoped Claude monitor tool.
The next execution is shown in the configured timezone. Nonexistent daylight-saving
times are skipped; repeated times run at their first occurrence only. Resuming a
calendar monitor schedules the next future slot. An overdue idle monitor catches up
at most once when the service returns, rather than replaying every missed day.

Tasks sharing one conversation are serialized before provider startup. Existing
interval schedules retain their original timestamps during migration. Permissions
are read from each task's stored settings, never assumed to be bypass mode.

The `Claudex Windows installer` GitHub Actions workflow builds on a separate
Windows runner, installs into a disposable directory, starts the installed
application and checks its authenticated API and frontend assets. Acceptance
also starts a sentinel service on port 3001 and injects stale environment
overrides, verifying that the sentinel and its database remain untouched.

`installer-smoke.json` records this packaging acceptance. Real model behavior
requires a configured model account and is validated separately from installer
startup. Hosted CloudCLI cloud connections and non-Windows installers are not
qualified by this release.

Source builds require Node.js 22, the repository dependencies and the Windows
native build prerequisites:

```powershell
npm ci
npm run build
node scripts/release/prepare-workbench.mjs
node node_modules/electron-builder/cli.js --projectDir .desktop-build/workbench --win nsis --x64 --publish never
```

See [Codex source references](CODEX-SOURCE-REFERENCES.md) for the protocol and
lifecycle designs used in this implementation.

For custom background jobs that call Codex through Windows Task Scheduler, use
the [hidden scheduled-job launcher](../scripts/windows/README.md). The outer
PowerShell or Node task action must also start without a console; hiding only
the inner Codex process does not hide an already-created parent window.
