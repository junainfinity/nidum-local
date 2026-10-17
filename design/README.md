# Design source

Extracted from `~/Downloads/Nidum Local — Light & Dark.html` (a Claude Design bundle) on 2026-10-15.
These are the raw design templates, not runnable pages: they use the design runtime's
`<sc-if>`, `<sc-for>`, `<sc-raw-table>` tags and `sc-camel-view-box` (= `viewBox`) attributes.

| File | Board |
| --- | --- |
| `dashboard-light.html` | Dashboard · Light (1440×900) |
| `dashboard-dark.html` | Dashboard · Dark (dark tokens **and** 14 markup differences: 15 % pill tint, amber banner icon, `--border-strong` badges/kbd, Add fields on `--surface-2`, theme group on `--bg`, some cards without shadow — build dark from this file) |
| `theme-tokens.html` | Theme tokens · Light vs Dark, logo lockup |
| `popovers-dialogs-notices.html` | Error banner, QR popover, confirm dialog, inline notice, toasts |
