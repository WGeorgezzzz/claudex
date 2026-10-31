# Drover brand and compatibility

- Product name: **Drover**; the Chinese display name is **驭手**.
- Tagline: **Drover — drive every agent from one place** / **驭手 Drover — 一处驾驭所有 Agent**.
- Canonical mark: `public/drover-mark.svg`, selected from `logo-options/` and based on a guiding arc with a leading arrow.
- Palette: ink `#132B2B`, pale mark `#F7F1E6`, accent `#F4A7B9`.
- Regenerate icon formats with `node scripts/release/generate-brand-icons.mjs`.
- WorkBuddy's provider mark remains its original, separately owned artwork.

## Compatibility identifiers

The earlier Nexcode and GACI names remain only where existing installations need
compatibility. The CLI aliases `nexcode`, `gaci`, `cloudcli`, and `claudex` invoke
the same entry as `nexagent`. npm metadata now uses `nexagent`.

`NEXAGENT_CONTROL_PLANE_URL` precedes `NEXCODE_CONTROL_PLANE_URL`, then
`CLOUDCLI_CONTROL_PLANE_URL`. Icon tooling accepts `NEXAGENT_SHARP_MODULE`,
`NEXCODE_SHARP_MODULE`, `GACI_SHARP_MODULE`, and `CLAUDEX_SHARP_MODULE` in that order.
`NEXAGENT_RELAY_BASE_URL` is a new setting, without a historical alias.

Retain app IDs `ai.cloudcli.desktop` and
`io.github.wgeorgezzzz.cloudcli-workbench`, the `CloudCLI Workbench` storage folder,
`cloudcli://` and `cloudcli-workbench://` protocols, `~/.cloudcli`, existing
`CLOUDCLI_*` variables, `X-GACI-Quota-Token`, scheduled-task identities, userscript
namespaces, and persisted storage keys. Compatibility artwork URLs
`/nexcode-mark.svg`, `/gaci-mark.svg`, and `/claudex-mark.svg` remain available.

Current pages and installers display Drover. Preserve LICENSE and NOTICE,
including their historical upstream names. The GitHub repository is
`WGeorgezzzz/drover`.
