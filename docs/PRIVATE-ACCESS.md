# Private access to the complete Claudex workspace

Remote access includes projects, chat, files and terminals. It has the same
authority as the local owner, so the public entry must be protected before a
tunnel is routed to it. Dot is one feature within this complete workspace.

Claudex desktop enables `CLAUDEX_LOCAL_IDENTITY=1` and
`CLAUDEX_PRIVATE_GATE=1`. The backend remains on loopback. Its local capability
file is restricted to the OS account (0600 on Unix, an explicit owner ACL on
Windows). Electron reads the capability in its main process and exchanges it
for a one-use, 60-second fragment ticket. The browser never receives the long-lived
capability. Fresh owners skip the global Git configuration wizard; Git and
provider configuration remain available in settings.

## Configure the public boundary

Enable Cloudflare's App Launcher with an Allow policy restricted to the owner's
exact email before requiring independent MFA. Users enroll authenticators at
`https://<team>.cloudflareaccess.com/AddMfaDevice`. Cloudflare deliberately exempts
the launcher from the global MFA requirement so first-time enrollment is possible;
keep MFA required on the actual workspace application. If the launcher is absent,
the **Setup MFA** button leads to the administrator-enable message instead of
enrollment. Verify the enrollment page before asking the owner to sign in.

Create a Cloudflare Access self-hosted application for one hostname, restrict it
to the owner's exact email, and require MFA. Do not use an Everyone, Bypass or
public service-token policy. Configure the backend with:

```text
CLAUDEX_PRIVATE_GATE=1
CLAUDEX_PUBLIC_HOST=agent.example.com
CLAUDEX_ACCESS_TEAM=https://your-team.cloudflareaccess.com
CLAUDEX_ACCESS_AUD=<application audience>
CLAUDEX_ACCESS_EMAILS=<exact owner email>
```

The boundary verifies the Access signature, issuer, audience, lifetime and email
for all HTTP and WebSocket paths. Unknown hosts and cross-origin browser requests
are rejected. Local tickets and legacy local tokens cannot authenticate remote
requests. Keep `HOST=127.0.0.1`; preserve the public Host header through the tunnel.
Missing or invalid Access configuration fails closed. Do not expose the origin
port directly or replace the boundary with a trusted-header-only check.

## Independent remote account

From an authenticated local connection, `POST /api/auth/remote-account` accepts
a username and a password of at least 16 characters, up to 72 UTF-8 bytes. It creates an independent remote
credential mapped to the existing owner's data. The response contains the TOTP
enrollment secret and an `otpauth://` URI once; store them privately and enroll an
authenticator. Never put credentials in Git, logs or a public guide. The endpoint
refuses to overwrite an existing remote account.

At the public entry, login requires this password and a six-digit TOTP code after
Cloudflare Access succeeds. OTP steps cannot be replayed. Authentication attempts
are rate limited. Existing local password credentials are not the remote password.

Device sessions expire after seven days. Refresh retains the original device and
expiry, so it cannot revive a revoked session. The account panel lists active
devices and revokes them; open sockets disconnect immediately on revocation and
at login expiry. Legacy local JWTs remain compatible only on the local entry and
are not listed as revocable devices. Closing a browser does not stop agent work.

## Verify before publishing

Verify unauthenticated, wrong-origin, wrong-host and local-ticket-over-remote
requests are rejected. Verify authenticated project reads, an actual model turn,
WebSocket connection and device revocation through the HTTPS hostname. Check the
phone layout as well. DNS, a tunnel health indicator or the login page alone does
not establish full remote-workspace acceptance.

Cloudflare references: [Validate Access tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Independent MFA enrollment](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/), [Enable the App Launcher](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/app-launcher/).
