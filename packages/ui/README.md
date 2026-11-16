# `@soldock/ui`

> Status: **planned** — not created yet.

Design system: tokens, Radix-based accessible components, layout primitives shared by every feature of the SPA.

Until this package exists, the design tokens and the shared component styles are in
[`apps/web/src/styles.css`](../../apps/web/src/styles.css), and the icons are in
[`apps/web/src/lib/icons.tsx`](../../apps/web/src/lib/icons.tsx). The
[Design section](../../apps/web/README.md#design) of the web app describes them: the tokens for light
and dark, the Appearance choice, the Iconoir icons, the select and the layout. The select is in
[`apps/web/src/lib/Select.tsx`](../../apps/web/src/lib/Select.tsx). The web app uses plain CSS and no
component library. When this package starts, move the tokens here first.
