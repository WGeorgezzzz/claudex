# Subscription and relay quota

Open **Settings → Usage → 额度** to inspect the shared Claude subscription,
your own Codex relay Key, and (administrators only) the upstream OAuth pool.
The sidebar indicator opens this section directly. Existing transcript-based
usage charts remain below it.

## Credentials and access

- Claude reads `CLAUDE_CONFIG_DIR/.credentials.json` from the administrator
  configuration, independently of the signed-in member. It never refreshes
  tokens. A 401 asks you to wait for the Claude CLI to refresh credentials.
  If `HTTPS_PROXY` is configured, this metadata request uses a dedicated native
  proxy agent (Node 22.21+ or 24.5+). Other network clients are unaffected.
- Store the relay administrator Key outside the repository at
  `~/.cloudcli/secrets/sub2api-admin.json`:

  ```json
  { "apiKey": "<administrator API Key>" }
  ```

  This Key takes precedence over the JWT fallback. Without it, the server uses
  AWS profile `sub2api-ops` to read SSM parameter `/sub2api/admin-password` in
  `ap-southeast-1`, then signs in as `admin@sub2api.local`. JWTs stay in memory.
- Personal Key usage reads only the authenticated user's Codex `auth.json`.
  An administrator uses `CODEX_HOME`; a member uses the existing user config
  resolver. ChatGPT login without `OPENAI_API_KEY` displays **未走中转**.
- The relay origin is fixed to `https://api.qiaozhiw.com`. An unrelated
  provider Key cannot retrieve another user's statistics.
- Authenticated `GET /api/quota` never accepts a user ID or role override.
  Members neither trigger nor receive upstream pool requests. Responses are
  field projections and do not contain credentials or raw upstream errors.

## Refresh and warnings

Successful results cache for 120 seconds. Concurrent requests share one
refresh. Failures back off from 30 seconds to ten minutes. Relay requests
have a 30-second timeout and at most two retries on transient failures.
The background pool sampler runs at startup and every ten minutes, even if
no administrator has the page open.

`quota_credit_snapshots` retains each successful balance observation by account
and time. Scaled integer comparison preserves decimal precision.
`quota_credit_alerts` retains detected debits across refreshes and restarts;
the latest alerts appear in red in the quota panel and sidebar and are logged
on detection. No reset-credit action or generation endpoint is exposed.

Global thresholds of zero, above 0.95, or unknown produce red warnings.
Unsafe per-account pause overrides and enabled upstream credit resets also
warn. Usage of at least 95% or paused scheduling uses red; upstream warning
severity uses yellow. Disabled scheduling alone cannot prove auto-pause was
the cause, so the page labels this explicitly.

Refresh timestamps and source usage/credit timestamps are separate. Values
older than 15 minutes are marked stale. An old upstream credit snapshot
cannot prove that credits have not been spent. This dashboard observes the
relay; enforcement remains the relay scheduler's responsibility.

Personal today/7-day/30-day totals use Key-filtered daily usage from
`GET /v1/usage?days=30&timezone=Asia%2FShanghai`. Missing upstream history is
shown as unavailable. Reset timestamps use the browser's local timezone.
