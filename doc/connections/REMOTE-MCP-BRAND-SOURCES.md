# MCP connector brand assets

Retrieved 2026-09-21 from the providers’ own sites for the independent connector
design review. Brand-library membership does not publish a catalog connector.
The four connectors are available for setup by default. No experimental flag is required.
Zapier and Composio reuse the existing reviewed local marks.

| File | Source | SHA-256 |
| --- | --- | --- |
| `ui/public/brands/apps/arcade.png` | [Arcade site touch icon](https://www.arcade.dev/_astro/webclip.BYnZsC5R.png), linked from [arcade.dev](https://www.arcade.dev/) | `5b3704e210b6dc70fffab260d5416624f37db19108399a6d2c18c848d33465ad` |
| `ui/public/brands/apps/executor.png` | [Executor site icon](https://executor.sh/favicon-192.png), linked from [executor.sh](https://executor.sh/) | `e5fd761a0cd80d51d451cc06e9e6d0236dcc39317248a13ac5db5fcf4d52d0ca` |

Both files preserve provider artwork without recoloring. The shared AppLogo
provides the standard gray frame and contained padding. Arcade’s SVG favicon
wrapped embedded raster content; the 180px touch icon linked by the same official
page was used to satisfy the repository’s artwork safety checks.

## TryPost (added 2026-10-16)

| File | Source | SHA-256 |
| --- | --- | --- |
| `ui/public/brands/apps/trypost.png` | [Upstream app icon](https://raw.githubusercontent.com/trypostit/trypost/main/public/images/trypost/icon.png) in the provider’s own repository (`trypostit/trypost@main`, git blob `4c6ed3541489a7eb406c6c707f843bf5126c3dd7`) | `041f024c565e5cf80de9a3df2736f8d3251e9cbd75b7555a5454d07bd132847f` |

512x512 RGBA, stored byte-for-byte with no recoloring or re-export, so the
artwork safety checks pass without an SVG sanitize step. Upstream publishes no
separate brand-use policy; the code is AGPL-3.0 and the mark is kept unmodified
and shown only to identify the provider’s own service. There is no dark variant:
the mark carries its own transparent-background artwork, like `arcade.png`.
