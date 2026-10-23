# Nexcode brand

- Product name: **Nexcode**; Chinese name: **麻薯** (a pun on 码枢, "code nexus").
- Tagline: Your agents, one workspace.
- Canonical mark: `public/nexcode-mark.svg`; a round mochi filling the tile with a `</>` face, on ink `#132B2B`, mochi `#F7F1E6`, blush `#F4A7B9`. Keep it free of small details so it stays legible at 16 px.
- Regenerate SVG/PNG/ICO/ICNS assets with `node scripts/release/generate-brand-icons.mjs`. `NEXCODE_SHARP_MODULE` (or the older `GACI_SHARP_MODULE` / `CLAUDEX_SHARP_MODULE`) can point to an isolated Sharp installation.
- The WorkBuddy icon is the original SVG from the [WorkBuddy website](https://www.workbuddy.cn/), retrieved on 2026-10-24 from `https://assets.workbuddy.cn/web/workbuddy/a5b2fb510f0e7b156f19d072fae0cd12ae1f2f19/assets/logo.svg`. It remains WorkBuddy's provider mark.

Display names, installer filenames, browser/PWA icons, and the desktop launcher use Nexcode. Existing package/repository URLs, app IDs, protocols, storage folders, auth headers (`X-GACI-Quota-Token`), scheduled-task names, userscript namespaces, and environment-variable names remain compatible. `nexcode` is an additional CLI alias; `gaci` and the other existing aliases continue to work. The old `/gaci-mark.svg` and `/claudex-mark.svg` asset URLs serve the new mark for cached clients.

A display-name update does not publish a new installer or rename the GitHub repository. Preserve upstream licensing and notices.
