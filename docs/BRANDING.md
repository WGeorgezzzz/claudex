# AgentHub brand

- Product name: **AgentHub**; No separate Chinese product name.
- Tagline: Your agents, one workspace.
- Canonical mark: `public/nexcode-mark.svg`; a round mochi filling the tile with a `</>` face, on ink `#132B2B`, mochi `#F7F1E6`, blush `#F4A7B9`. Keep it free of small details so it stays legible at 16 px.
- Regenerate SVG/PNG/ICO/ICNS assets with `node scripts/release/generate-brand-icons.mjs`.
  `AGENTHUB_SHARP_MODULE` also accepts the existing `NEXCODE_SHARP_MODULE`,
  `GACI_SHARP_MODULE`, and `CLAUDEX_SHARP_MODULE` fallbacks.
- The WorkBuddy icon is the original SVG from the [WorkBuddy website](https://www.workbuddy.cn/), retrieved on 2026-10-24 from `https://assets.workbuddy.cn/web/workbuddy/a5b2fb510f0e7b156f19d072fae0cd12ae1f2f19/assets/logo.svg`. It remains WorkBuddy's provider mark.

Display names, installer filenames, browser/PWA icons, and the desktop launcher
use AgentHub. The mochi `</>` artwork is unchanged; there is no Chinese product
name. Existing package/repository URLs, app IDs, protocols, storage folders,
auth headers (`X-GACI-Quota-Token`), scheduled-task names, userscript namespaces,
and storage keys remain compatible. Asset URLs including `/nexcode-mark.svg`,
`/gaci-mark.svg`, and `/claudex-mark.svg` remain available.

`agenthub` is a new CLI alias; `nexcode`, `gaci`, `cloudcli`, and `claudex`
continue to work. `AGENTHUB_CONTROL_PLANE_URL` takes precedence over
`NEXCODE_CONTROL_PLANE_URL`, then `CLOUDCLI_CONTROL_PLANE_URL`. The two
`AGENTHUB_*` names above are the only new environment aliases. Existing
`CLOUDCLI_*` names, `~/.cloudcli`, and `cloudcli://` remain unchanged.

A display-name update does not publish a new installer or rename the GitHub repository. Preserve upstream licensing and notices.
