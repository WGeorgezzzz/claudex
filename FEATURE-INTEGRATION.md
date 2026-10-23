# Feature integration — 2026-10-24

The integration starts from `origin/main` at `a3ded10e`. It retains the GACI product identity already on main; Claudex remains the repository/package lineage.

## Included features

| Area | Source | Behavior retained |
| --- | --- | --- |
| Multi-user access | `c57a33e4`, `4c0aa0bc`, `45755464` | Session ownership, member directories, member defaults and onboarding |
| Provider models and local files | `531d95f1`, `70f8fbe5` | Connected model catalog, file reference resolution and ranged media |
| WorkBuddy | `b9fab006`, `522c92e6`, `55f815da`, `f114c2a7` | Local login, free catalog, approvals, tool rendering and rejection of leaked tool markup |
| Mobile navigation | `7e3a7be4`, `6080858f`, `244f2330` | Menus stay in the visible viewport, history navigation and dialogs survive menu closure |
| Native controls and usage | `78ac9f55`, `dce57d8c` | Provider controls, quota monitoring and native Codex cancellation |
| Product identity | `1f348dfc`, `8bcc6a74` | GACI branding and WorkBuddy logo |
| Contextual replies | `580c22cd` | Conversation-grounded suggestions, stale-result protection and draft-only insertion |
| Shell output | Previously uncommitted shell-collapse changes | PowerShell uses the same collapsible command/output row as Bash, including errors |
| Browser quota bridge | `cc55e5a3` | Receive quota snapshots from an authenticated Chrome page through the optional local bridge |

## Boundaries

Contextual generation currently supports Claude sessions only. Other providers can display suggestions embedded in their replies. Their conversation history is not silently sent to Claude. Selecting a suggestion fills the draft and never sends it. The generator limits concurrency, caches by owner/session/revision and rejects results when the conversation changes.

A successful build or component test does not establish live provider availability, free-model eligibility or remaining quota. These depend on the connected account and provider response.

The Chrome quota bridge requires its separate installation and a logged-in source page. Merging its scripts does not mean a browser is sending fresh quota data.

## Isolated backend tests

`npm test` runs `scripts/test-backend-isolated.mjs`. The launcher removes inherited provider account paths, executable overrides and service authentication settings from the child environment, uses a temporary home/database, and preserves serial test-file execution. It keeps the fixture directory for diagnosis. The parent service environment is unchanged.

Run a targeted suite with `node scripts/test-backend-isolated.mjs server/modules/providers/tests/mcp.test.ts`. Do not invoke the backend test glob directly from a production desktop environment: some legacy fixtures mock the home lookup but do not override provider-specific environment paths.

## Keeping releases coherent

1. Fetch main before starting an integration. Compare branch ancestry before cherry-picking: many feature branches are already merged.
2. Preserve dirty worktrees. Compare their edits against the commit that restored local changes (`531d95f1`) and subsequent fixes; copying the old tree wholesale would discard newer ownership protections and UI fixes.
3. Build client and server from one integration commit. Record the commit, asset hashes, runtime directory and validation results together.
4. Publish assets before switching `index.html`; retain prior hashed assets and a rollback copy. Check the served HTML and JavaScript against the build.
5. Update backend code only through a release that preserves active sessions and workers. Do not restart an active service merely to synchronize a source checkout.

The original working directories and uncommitted changes remain available for provenance. Use the integrated main history for subsequent feature work.

## Follow-up audit: mobile gestures and shell presentation

The initial integration missed the desktop launcher's uncommitted removal of hosted-cloud menus. It also treated browser Back handling as evidence for an application-level right swipe, although no touch gesture handler existed. Both are now corrected:

- Right swipe opens the mobile sidebar and left swipe closes it without changing the session URL or draft. Vertical scroll, editing, code scrolling, text selection and multi-touch keep their own behavior.
- Bash and PowerShell use compact, collapsed command rows in the main transcript, expanded tool groups and subagent history. The legacy terminal renderer also uses this component; it no longer renders black panels with green command text.
- The native launcher and tray keep local controls without the old hosted-cloud account/environment UI. Existing native processes need a later restart to load main-process menu changes; restarting the backend is unnecessary.
- The session pagination fix from `2ec3eee5` is retained.

An older queued backend release activated after the first frontend verification and replaced the served frontend with an earlier build. Therefore release acceptance must resolve the **current** service runtime immediately before and after publishing, rather than reuse an earlier runtime path. Record the frontend commit and entrypoint hash in that runtime's `frontend-release.json`, and check outstanding deployment workers before reporting the live result. Preserve old hashed assets for existing tabs.
