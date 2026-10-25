# Subscription and relay quotas

Open **Settings → Usage → 额度**. The shared Claude subscription and the current
user's relay Key are separate. Only administrators receive the upstream account pool.

## Configure a relay

Use a sub2api-compatible service with `/v1/usage` and the `/api/v1/admin` management
APIs. A generic model-generation gateway may not provide these endpoints.

Set `NEXAGENT_RELAY_BASE_URL=https://relay.example.com`, or save the URL in the
administrator's quota settings. The environment variable takes precedence and
makes the field read-only. The persisted setting is outside Git at
`$CLOUDCLI_HOME/relay.json`, defaulting to `~/.cloudcli/relay.json`:

```json
{ "baseUrl": "https://relay.example.com" }
```

Use HTTPS. Plain HTTP is accepted only for localhost testing. Credentials, query
parameters, and fragments are not accepted in the URL. An empty setting displays
**未配置中转**, does not query the relay, and does not report a relay error.

Store administrator credentials at `$CLOUDCLI_HOME/secrets/sub2api-admin.json`:

```json
{
  "baseUrl": "https://relay.example.com",
  "apiKey": "<relay administrator API key>"
}
```

The matching `baseUrl` is required: editing the endpoint never forwards an old
administrator key to a different relay. An API key takes precedence. For relays
using JWT login, supply `email` and `password` instead, or put the password in
`NEXAGENT_RELAY_ADMIN_PASSWORD`. Restrict access to this file to the service account.
JWTs stay in memory. No cloud-provider credentials or password lookup is built in.

Personal usage reads only the authenticated user's Codex `auth.json`. ChatGPT
login without an API key displays **未走中转**. Members cannot override identity
through query parameters, change the relay URL, or receive upstream account data.

## Claude subscription

The dashboard reads the administrator's `CLAUDE_CONFIG_DIR/.credentials.json`.
It never refreshes OAuth credentials. A 401 asks you to wait for Claude CLI's
refresh. `HTTPS_PROXY` applies to this metadata request through a dedicated native
agent, requiring Node 22.21+ or 24.5+. Credentials are never sent to the browser.

## Refresh, history, and warnings

Successes cache for 120 seconds; concurrent refreshes coalesce. Failures back off
from 30 seconds to ten minutes. Relay requests time out after 30 seconds and retry
transient failures at most twice. The configured pool is sampled every ten minutes.

Snapshots and alerts are partitioned by relay URL and account ID. When upgrading
a known installation, explicitly add `legacyBaseUrl` to `relay.json` with its
former relay URL before the first startup. Existing unattributed history and
alerts are then assigned to that original relay, retaining the balance chain.
Changing the current URL does not change this migration marker. Without an
explicit marker, old history remains preserved without guessing its destination.
Decimal comparisons use scaled integers, retaining very small debits.
Warnings persist after a detected debit. No credit-reset endpoint is called.

The global seven-day pause threshold warns if unknown, nonpositive, or above 0.99.
Seven-day account overrides warn if disabled or outside the same range. Five-hour
zero or disabled values are displayed without a policy warning. Usage at 95% or
more and paused scheduling remain red; upstream warning severity is yellow.

Source timestamps and refresh timestamps are separate. Values older than fifteen
minutes are marked stale. An old balance cannot establish that no credits were
spent. The relay scheduler enforces spending policy; this dashboard observes it.
Personal daily history is Key-filtered; absent upstream data stays unavailable.
