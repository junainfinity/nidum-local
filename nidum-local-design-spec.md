# Nidum Local: Design Specification

**Status:** Draft v1 · **Date:** 2026-10-15 · **Companion to:** [Nidum Local — Spec](https://claude.ai/code/artifact/59751d9b-a90f-44ce-8c2a-482fb37631b9)

Nidum Local turns a service running on your computer into a named address that other devices on your network can open, in under a minute and without a terminal. It is a double-click launcher plus a one-page dashboard built on [Portless](https://github.com/vercel-labs/portless). This document covers every design aspect of the product: naming, launcher experience, page structure, visual language, components, states, interactions, copy, accessibility and responsive behavior.

---

## Contents

1. [Design principles](#1-design-principles)
2. [Naming and vocabulary](#2-naming-and-vocabulary)
3. [Launcher experience](#3-launcher-experience)
4. [Information architecture](#4-information-architecture)
5. [Layout and grid](#5-layout-and-grid)
6. [Visual language](#6-visual-language)
7. [Component library](#7-component-library)
8. [Section designs](#8-section-designs)
9. [Interaction and motion](#9-interaction-and-motion)
10. [Content and voice](#10-content-and-voice)
11. [Feedback, errors and empty states](#11-feedback-errors-and-empty-states)
12. [Safety made visible](#12-safety-made-visible)
13. [Accessibility](#13-accessibility)
14. [Responsive behavior](#14-responsive-behavior)
15. [Theming and dark mode](#15-theming-and-dark-mode)
16. [Front-end constraints](#16-front-end-constraints)
17. [Open design questions](#17-open-design-questions)

---

## 1. Design principles

| Principle | What it means in practice |
| --- | --- |
| **The address is the product** | The most prominent thing on any row is the address (`recipes.local`), always with Copy, Open and QR right beside it. Ports and process names are secondary. |
| **No terminal, no jargon** | Users never see "route", "alias", "proxy daemon" or a stack trace in the main UI. Portless terms appear only in tooltips and the Tools output panel. |
| **Safe by default, explicit to expose** | Nothing becomes reachable without a click on a clearly labeled button. Internet exposure is off and needs a second confirmation. |
| **One page, top to bottom** | Find → name → share → manage, in reading order. No tabs, no routing, no modals except for destructive confirmations and device setup. |
| **Show the truth, live** | The page reflects the real state of ports and addresses within 5 seconds. Never show an optimistic success the CLI hasn't confirmed. |
| **Re-running is harmless** | Every action is idempotent from the user's point of view. Clicking the launcher twice, or Create twice, never breaks anything. |

---

## 2. Naming and vocabulary

### Product name

- Full name: **Nidum Local**. Always two words, both capitalized. Never "NidumLocal", "nidum local" or "Nidum-Local" in UI copy.
- Lowercase slug for files, folders and identifiers: `nidum-local`.
- Page `<title>`: `Nidum Local`. When something needs attention, it's prefixed with a status, e.g. `(!) Nidum Local`.
- "Powered by Portless" appears once, in the footer, linking to the Portless repository.

### Files and identifiers

| Item | Name |
| --- | --- |
| macOS launcher | `Nidum Local.command` |
| Windows launcher | `Nidum Local.cmd` → `nidum-local.ps1` |
| Linux launcher | `nidum-local.sh` + `nidum-local.desktop` |
| State and logs folder | `~/.nidum-local/` (`state.json`, `launcher.log`, `server.log`) |
| Dashboard URL | `http://127.0.0.1:47800/` (next free port if taken) |
| API auth header | `X-Nidum-Token` |
| Device setup page (temporary) | `http://<LAN IP>:<random port>` (D21; `setup` stays a reserved name) |

### UI vocabulary

The UI uses everyday words. The Portless term goes in tooltips and in the Tools output only.

| UI word | Meaning | Portless term |
| --- | --- | --- |
| **Service** | Something listening on a port on this computer | listening process |
| **Address** | The name other devices open, e.g. `recipes.local` | route / alias |
| **Give it an address** | Create an address for a service | `portless alias <name> <port>` |
| **Network sharing** | The proxy running in LAN mode | `portless proxy start --lan` |
| **Pause sharing** | Stop the proxy; addresses kept | `portless proxy stop` |
| **Waiting** | Address exists, nothing listening on its port | route to a closed port |
| **This computer** | The machine running Nidum Local | host / loopback |
| **Set up another device** | Install the certificate on a phone or laptop | CA trust |

Words to avoid in UI copy: route, alias, proxy, daemon, bind, loopback, mDNS, TLD, CA, localhost (except inside literal addresses), "simply", "just".

---

## 3. Launcher experience

The launcher is the first thing users see, so it is designed as carefully as the dashboard, even though it runs in a terminal window.

### File presentation

- Distributed in a zip containing only the launcher file(s) and a `README.txt` of 10 lines or fewer.
- macOS: custom icon set on `Nidum Local.command` (the Nidum mark on a rounded square).
- Windows: `.cmd` file; the PowerShell script sits beside it, prefixed so it sorts second.
- Linux: `.desktop` entry with `Name=Nidum Local`, `Icon=nidum-local`, `Terminal=true`.

### Terminal output design

Each step is one line: a status glyph, then a plain sentence. Colors are ANSI, with glyphs carrying the meaning so it still reads with color off (`NO_COLOR` respected).

```
  Nidum Local
  Share what's running on this computer with your network.

  ✓ Node.js 22.22.3 found
  ✓ Portless 0.15.6 found
  … Starting network sharing (you may be asked for your password)
  ✓ Network sharing is on — this computer is 192.168.1.42
  ✓ Dashboard started
  → Opening http://127.0.0.1:47800 in your browser

  You can close this window. Nidum Local keeps running.
```

| Glyph | Color | Meaning |
| --- | --- | --- |
| `✓` | green | Step done or already in place |
| `…` | cyan | In progress |
| `?` | yellow | Waiting for the user's answer |
| `!` | yellow | Warning, continuing anyway |
| `✗` | red | Failed, launcher stops |
| `→` | default | Action handed to another app |

### Consent prompts

Every install or privileged action asks first. The default is shown in capitals, and pressing Enter accepts the safe default.

```
  ? Nidum Local needs Node.js 18 or newer. You have none installed.
    Install it now with Homebrew? [Y/n]
```

```
  ? Network sharing is already on, but only for this computer.
    Restart it so other devices can connect? Open addresses will drop for a second. [Y/n]
```

- Before the first admin password prompt, the launcher prints why it's needed: "Your computer will ask for your password so Nidum Local can use the standard web port (443) and trust its local certificate. You may be asked twice."
- Before the first LAN bind on macOS and Windows: "Your computer may ask whether to allow incoming connections. Choose Allow, or other devices won't be able to connect."

### Failure screen

On failure the window stays open and shows the error in four parts:

```
  ✗ Couldn't start network sharing.

    What happened: Port 443 is already used by another program (httpd, PID 812).
    What to try:   Quit that program, then open Nidum Local again.
    Details:       ~/.nidum-local/launcher.log

  Press any key to close.
```

### Timing targets

| Scenario | Target from double-click to dashboard open |
| --- | --- |
| Everything already running | ≤ 3 s |
| Portless installed, proxy stopped | ≤ 10 s plus password entry |
| Fresh machine with Node, no Portless | ≤ 60 s on a 20 Mbps connection |

---

## 4. Information architecture

One scrolling page. Sections appear in the order of the user's task. A sticky header shows status and gives quick jumps to the sections.

```
┌──────────────────────────────────────────────────────────────┐
│ HEADER (sticky)   logo · Nidum Local · status pill · counter │
├──────────────────────────────────────────────────────────────┤
│ Banners (only when needed): first-run, public network, error │
├──────────────────────────────────────────────────────────────┤
│ 1  DISCOVER          services running on this computer       │
├──────────────────────────────────────────────────────────────┤
│ 2  ADD MANUALLY      port + name form                        │
├──────────────────────────────────────────────────────────────┤
│ 3  YOUR ADDRESSES    every active address                    │
├──────────────────────────────────────────────────────────────┤
│ 4  NETWORK SHARING   status, settings, keep running          │
├──────────────────────────────────────────────────────────────┤
│ 5  TOOLS             diagnostics, device setup, fixes        │
├──────────────────────────────────────────────────────────────┤
│ 6  ADVANCED          internet sharing, reset (collapsed)     │
├──────────────────────────────────────────────────────────────┤
│ FOOTER   version · Powered by Portless · Quit Nidum Local    │
└──────────────────────────────────────────────────────────────┘
```

### Section anchors

Each section has an anchor (`#discover`, `#add`, `#addresses`, `#sharing`, `#tools`, `#advanced`). The header's counter ("3 addresses live") jumps to `#addresses`. The URL hash updates as the user scrolls, so a refresh returns to the same place.

### Hierarchy of attention

1. Header status pill: is sharing on?
2. Addresses on any row: what can people open?
3. Primary buttons: Give it an address / Create address.
4. Everything else.

---

## 5. Layout and grid

| Token | Value |
| --- | --- |
| Content max width | 1120 px, centered |
| Page side padding | 32 px desktop, 24 px tablet, 16 px phone |
| Grid | 12 columns, 24 px gutter |
| Section spacing | 48 px between sections |
| Card padding | 24 px desktop, 16 px phone |
| Spacing scale | 4, 8, 12, 16, 24, 32, 48, 64 |
| Header height | 64 px (56 px on phone) |
| Row height (lists) | min 64 px; 56 px in compact density |

### Section anatomy

```
  ┌ Section ─────────────────────────────────────────────────┐
  │  Title (H2)                                [section action] │
  │  One-sentence description in secondary text                │
  │                                                            │
  │  ┌ Card ─────────────────────────────────────────────────┐ │
  │  │  content                                              │ │
  │  └───────────────────────────────────────────────────────┘ │
  └────────────────────────────────────────────────────────────┘
```

- Sections are not boxed; their content sits in one card each.
- Section actions (Refresh, Show system services) align right on the title row.

---

## 6. Visual language

### Brand

- Wordmark "Nidum Local" in the header, 18 px, semibold. The Nidum mark sits to its left at 28 × 28 px.
- Brand accent is a placeholder until the Nidum palette is supplied: `--accent` is defined once and everything derives from it.
- Tone: calm, utility-grade, closer to a system settings pane than a marketing page. No gradients, no illustrations in the main flow, no shadows heavier than `--shadow-1`.

### Color tokens

All colors are CSS custom properties on `:root`, redefined for dark mode (section 15).

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#F7F7F8` | `#0F1012` | Page background |
| `--surface` | `#FFFFFF` | `#17181B` | Cards, header |
| `--surface-2` | `#F1F2F4` | `#1F2024` | Row hover, inputs, code chips |
| `--border` | `#E3E4E8` | `#2B2D32` | Card and row borders |
| `--text` | `#16171A` | `#ECEDEF` | Primary text |
| `--text-2` | `#5B5E66` | `#A2A5AD` | Secondary text, descriptions |
| `--text-3` | `#8A8D95` | `#73767E` | Hints, disabled |
| `--accent` | `#3B5BDB` *(placeholder)* | `#7C96FF` | Primary buttons, links, focus ring |
| `--accent-weak` | `#EDF1FF` | `#1E2540` | Selected rows, accent backgrounds |
| `--live` | `#1F9D55` | `#3CCB7F` | Live status |
| `--waiting` | `#B7791F` | `#E3B341` | Waiting status, warnings |
| `--error` | `#D64545` | `#FF6B6B` | Errors, danger buttons |
| `--neutral` | `#8A8D95` | `#73767E` | Not a web service, paused |

Every text/background pair meets WCAG AA (4.5:1 for body text, 3:1 for large text and UI borders). Status colors are never the only signal: each has a glyph and a word.

### Typography

System font stack, so no font files load and the page works offline:

```css
--font-ui:   system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
```

| Style | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| H1 (wordmark) | 18 / 24 | 600 | Header only |
| H2 | 20 / 28 | 600 | Section titles |
| H3 | 15 / 22 | 600 | Card sub-heads, row titles |
| Body | 14 / 20 | 400 | Default text |
| Small | 13 / 18 | 400 | Descriptions, metadata |
| Caption | 12 / 16 | 500 | Badges, table headers (uppercase off) |
| Address | 15 / 22 mono | 500 | Addresses on rows |
| Code | 13 / 18 mono | 400 | Ports, PIDs, commands, output |

- Numbers in tables use `font-variant-numeric: tabular-nums`.
- Addresses and ports always use the mono face so `recipes.local` and `:5173` read as things to copy.

### Shape, borders and elevation

| Token | Value |
| --- | --- |
| `--radius-sm` | 6 px (badges, inputs) |
| `--radius` | 10 px (buttons, cards) |
| `--radius-lg` | 14 px (dialogs, popovers) |
| Border width | 1 px; 2 px for focus ring |
| `--shadow-1` | `0 1px 2px rgb(0 0 0 / .06)` (cards, light mode only) |
| `--shadow-2` | `0 8px 24px rgb(0 0 0 / .14)` (popovers, dialogs) |

### Iconography

- One icon set: [Lucide](https://lucide.dev), inlined as SVG (no icon font, no CDN).
- 16 px in rows and buttons, 20 px in the header, stroke 1.75.
- Icons always sit beside a text label, except Copy / Open / QR, which have a tooltip and an `aria-label`.

| Meaning | Lucide icon |
| --- | --- |
| Copy address | `copy` → `check` for 1.5 s after copying |
| Open in browser | `external-link` |
| QR code | `qr-code` |
| Refresh | `refresh-cw` |
| Live | `circle` (filled) |
| Waiting | `circle-dashed` |
| Error | `circle-alert` |
| Not a web service | `circle-slash` |
| Network sharing on | `wifi` |
| Paused | `wifi-off` |
| Device setup | `smartphone` |
| Diagnostics | `stethoscope` |
| Danger | `triangle-alert` |

---

## 7. Component library

Each component lists its anatomy, variants and states. All interactive components have hover, focus-visible, active, disabled and loading states unless noted.

### 7.1 Header

```
[mark] Nidum Local    ● Sharing on · HomeWiFi · 192.168.1.42      3 addresses live   [Pause sharing]
```

- Left: mark + wordmark.
- Center: **Status pill** (7.2) + network name + LAN IP in `--text-2`.
- Right: address counter (link to `#addresses`) + Pause / Resume sharing button (secondary).
- Sticky, `--surface` with a bottom border appearing only once the page has scrolled.

### 7.2 Status pill

| State | Glyph | Label | Color |
| --- | --- | --- | --- |
| Sharing on | `wifi` | Sharing on | `--live` |
| Paused | `wifi-off` | Paused | `--neutral` |
| Starting / restarting | spinner | Starting… | `--accent` |
| Needs attention | `circle-alert` | Needs attention | `--error` (click → scrolls to the banner) |
| Only this computer | `monitor` | Only this computer | `--waiting` (proxy running without LAN mode) |

Pill: 28 px tall, `--radius-sm`, 10 % tint background of its color, label in `--text`.

### 7.3 Buttons

| Variant | Use | Look |
| --- | --- | --- |
| Primary | One per card: Give it an address, Create address | `--accent` fill, white text |
| Secondary | Refresh, Pause sharing, Run diagnostics | `--surface` fill, `--border` outline |
| Ghost | Row actions: Rename, Change port | No border, `--text-2`, `--surface-2` on hover |
| Icon | Copy, Open, QR | 32 × 32 px ghost, tooltip on hover/focus |
| Danger | Remove, Reset Portless | `--error` text; filled `--error` only inside the confirm dialog |

- Heights: 36 px default, 32 px compact (rows), 44 px on touch devices.
- Loading: label stays, a 14 px spinner replaces the icon, button width doesn't change, button is disabled.
- Buttons describe the result in a verb: "Create address", never "Submit" or "OK".

### 7.4 Address chip

The single most repeated component.

```
 recipes.local   [⧉] [↗] [▦]
```

- Address in mono 15/500, `--text`. In the Addresses list it's the row title; in Discover it replaces the button once created.
- Full URL (`https://recipes.local`) is what gets copied and opened; the chip shows it without the scheme.
- Copy → toast "Copied https://recipes.local" + icon swaps to `check` for 1.5 s.
- QR → popover (7.11).
- Address text itself is a link that opens it in a new tab.

### 7.5 Status badge

Small inline badge: glyph + word. 22 px tall, caption type.

| Status | Glyph | Word | Tooltip |
| --- | --- | --- | --- |
| Live | filled circle, `--live` | Live | Responding at :5173 |
| Waiting | dashed circle, `--waiting` | Waiting | Nothing is running on :3000 yet |
| Error | alert circle, `--error` | Error | :8080 answered with error 502 |
| Not web | slashed circle, `--neutral` | Not a web service | Only web services can get an address |

### 7.6 Source tag

Shows who created an address. Outline badge, `--text-2`.

| Tag | Meaning | Editable |
| --- | --- | --- |
| Nidum | Created in Nidum Local | Yes |
| Command line | Created with `portless alias` elsewhere | Yes |
| App | Started with `portless run`; disappears when the app stops | No (actions hidden, tooltip explains) |

### 7.7 Name field

Used in the inline assign form and Add manually.

```
 Name
 ┌──────────────────────────┐
 │ recipes                  │ .local
 └──────────────────────────┘
 https://recipes.local  ← live preview, mono, --text-2
```

- Suffix `.local` is fixed, non-editable text inside the field's right edge.
- Input auto-lowercases and converts spaces and underscores to dashes as the user types; other characters are rejected with a gentle shake-free inline message.
- Validation runs on each keystroke (debounced 150 ms), against local rules first, then the API for "taken".

| Check | Message (inline, below field) |
| --- | --- |
| Empty | "Give it a name." (shown only after blur or submit) |
| Bad characters | "Use lowercase letters, numbers and dashes." |
| Too long | "Keep each part under 64 characters." |
| Reserved | "`list` is reserved by Portless. Try `list-app`." |
| Taken | "`recipes` already points to port 8080. [Use another name] [Replace it]" |
| Valid | Preview line turns `--text` with a `check` icon |

### 7.8 Port field

- Numeric input, 6 ch wide, mono. Leading colon shown as a prefix (`:`).
- Live hint below, from Discover data: "Something is running here: node (recipes)" with a `circle` in `--live`, or "Nothing is running on 3000 yet. You can still save it." in `--text-2`.
- Errors: "Ports go from 1 to 65535.", "Port 443 is used by Nidum Local's network sharing."

### 7.9 Service row (Discover)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● :5173   Vite + React                          ~/code/recipes               │
│           node · PID 4821 · only this computer                [Give it an address] │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Line 1: status glyph, port (mono, 15/500), page `<title>` or process name (H3), folder (right, `--text-2`, truncated from the left: `…/code/recipes`).
- Line 2: process · PID · reach note ("only this computer" or "already open to the network") in Small.
- Right: primary-ghost button "Give it an address", or an Address chip if one exists.
- Hover: `--surface-2` background. Full command line in a tooltip on the process name.
- Not a web service: whole row `--text-3`, button disabled, badge "Not a web service".
- Clicking the button expands the row in place (7.10). Only one row is expanded at a time.

### 7.10 Inline assign form

Expands below the row with a 160 ms height animation.

```
│   Name  [ recipes            ].local     https://recipes.local ✓             │
│                                                   [Cancel]  [Create address] │
```

States: editing → creating (button spinner, inputs disabled) → success (row collapses, chip appears with a 2 s `--accent-weak` highlight) → host check warning if needed (7.13).

### 7.11 QR popover

```
 ┌────────────────────────────┐
 │       ▓▓▓▓▓▓▓▓▓▓▓▓         │
 │       ▓▓  QR    ▓▓         │   240 × 240 px, quiet zone 4 modules
 │       ▓▓▓▓▓▓▓▓▓▓▓▓         │
 │  https://recipes.local     │   mono, selectable
 │  Scan with your phone's    │
 │  camera.                   │
 │  [Copy link]  [Download]   │
 └────────────────────────────┘
```

- QR drawn as inline SVG, always black on white (even in dark mode) for scanner reliability.
- If HTTPS is on and no device has been set up yet, a footnote: "First time on this phone? [Set up this device]".
- Closes on Esc, outside click or scroll.

### 7.12 Addresses table row

| Address | Port | Source | Status | Actions |
| --- | --- | --- | --- | --- |
| `recipes.local` ⧉ ↗ ▦ | `:5173` node | Nidum | ● Live | Change port · Rename · Remove |

- Sorted: Error first, then Live, then Waiting; alphabetical inside each.
- Column widths: Address flexible (min 220 px), Port 120, Source 120, Status 120, Actions 220.
- Change port and Rename open an inline edit in the row (same fields as 7.7 / 7.8). Remove opens a confirm dialog (7.15).

### 7.13 Inline notice

A tinted strip inside a row or card, for things the user should act on but that aren't failures.

```
 ! recipes.local works, but Vite blocked the name.
   Add this to vite.config.js:   server: { allowedHosts: ['.local'] }   [Copy]
   [Check again]
```

Variants: info (`--accent-weak`), warning (`--waiting` 10 % tint), error (`--error` 10 % tint). Always a glyph, a one-line cause, the fix, and a retry action.

### 7.14 Banner

Full-width strip under the header for page-level states. At most one visible; priority: error > public network > first run.

| Banner | Text | Actions |
| --- | --- | --- |
| Proxy stopped unexpectedly | "Network sharing stopped. Your addresses are offline." | Start again · Run diagnostics |
| Public network | "You're on CoffeeShop-Guest. Anyone on this Wi-Fi can open your addresses." | Pause sharing · Dismiss |
| First run (once) | "Addresses you create here can be opened by any device on your network." | Got it |
| Portless older than tested | "Your Portless (0.12.1) is older than the version Nidum Local was tested with (0.15.6)." (Checked locally against the tested version; no update server is contacted.) | Upgrade · Later |

### 7.15 Confirm dialog

- Used only for Remove, Pause sharing when addresses are live, and Reset Portless.
- Title states the consequence: "Remove recipes.local?" Body: "Devices using this address will stop reaching it. The service itself keeps running."
- Buttons: Cancel (secondary, focused by default) and the danger action named by its verb ("Remove address").
- Reset Portless requires typing `reset` to enable the button.

### 7.16 Admin prompt waiting state

When an action needs the OS password dialog (start sharing on 443, keep running after restart):

- Button shows spinner and "Waiting for your password…".
- A small inline note: "Your computer is asking for your password in a separate window."
- If the dialog is cancelled: inline notice "Password not entered. Nothing changed." with Try again.

### 7.17 Output panel

For Run diagnostics and other tool output.

- Mono 13/18 on `--surface-2`, max height 320 px, scrolls.
- Lines starting with `✓`, `!`, `✗` are colored like the launcher.
- Header row: command shown in `--text-3` (`portless doctor`), Copy output button, Close.

### 7.18 Toast

- Bottom-center on phone, bottom-right on desktop; 360 px max width.
- Used only for confirmations of user actions (Copied, Address created, Address removed with Undo for 6 s).
- Never used for errors; errors stay inline where they happened.
- Auto-dismiss after 4 s (6 s with Undo); paused on hover and focus.

### 7.19 Toggle

- 36 × 20 px switch, label to the left, description below in Small.
- Applies immediately, showing a spinner on the switch while the CLI runs; reverts with an inline notice if the command fails.

### 7.20 Skeleton

Used for the first load of Discover and Addresses: three rows with 12 px bars in `--surface-2`, a 1.2 s shimmer (disabled under reduced motion).

---

## 8. Section designs

### 8.1 Discover

```
Discover                                              [⟳ Refresh]  [ ] Show system services
Services running on this computer. Give any web service an address so other devices can open it.

 [ Search services…                          ]

┌────────────────────────────────────────────────────────────────────────────┐
│ ● :5173  Vite + React           node · PID 4821        …/code/recipes       │
│          only this computer                              [Give it an address]│
├────────────────────────────────────────────────────────────────────────────┤
│ ● :8888  Jupyter Server         python3 · PID 913      …/notebooks          │
│          only this computer                  jupyter.local  ⧉ ↗ ▦           │
├────────────────────────────────────────────────────────────────────────────┤
│ ⊘ :5432  postgres               PID 201                                     │
│          Not a web service — only web services can get an address          │
└────────────────────────────────────────────────────────────────────────────┘
 Updated 2 seconds ago
```

| State | Design |
| --- | --- |
| First load | Skeleton, 3 rows |
| Loaded | Rows sorted: web services without an address first, then those with one, then non-web; by port within each group |
| Empty | Icon `radar`, "Nothing is running yet." Body: "Start your app, then come back. This list updates on its own." Link: "Add an address by port instead ↓" |
| All hidden | "Only system services are running." [Show system services] |
| Search no match | "No service matches "foo"." [Clear search] |
| Scan failed | Inline error notice in the card: "Couldn't read open ports. Some services may be missing." [Try again] [Details] |
| Process info hidden (other user) | Process shows "Another user" in `--text-3`; port and web check still shown |

- Search filters by port, title, process and folder; `/` focuses it.
- "Updated N seconds ago" sits under the list in Caption and turns `--waiting` if updates have stalled for 30 s.
- Rows that appear after first load fade in; rows that disappear fade out over 200 ms (no jumpy reflow while a form is open: an expanded row is pinned until closed).

### 8.2 Add manually

```
Add manually
For services Discover can't see, like a Docker container or something you'll start later.

  Port            Name
  [: 3000 ]       [ dashboard           ].local       https://dashboard.local
  Nothing is running on 3000 yet. You can still save it.
                                                          [Create address]
```

- Single card, two fields inline on desktop, stacked on phone.
- Create address is disabled until both fields are valid.
- If the typed port matches a Discover row, the hint reads "This is Vite + React from Discover" and the Name field fills with that row's suggestion if still empty.
- After success: fields clear, focus returns to Port, the new row in Your addresses gets the 2 s highlight and the page does **not** scroll away (a toast offers "View").

### 8.3 Your addresses

```
Your addresses                                                    3 live · 1 waiting
Everything other devices on your network can open right now.

 ADDRESS                    PORT          SOURCE         STATUS      
 recipes.local  ⧉ ↗ ▦       :5173 node    Nidum          ● Live       Change port · Rename · Remove
 jupyter.local  ⧉ ↗ ▦       :8888 python3 Command line   ● Live       Change port · Rename · Remove
 shop.local     ⧉ ↗ ▦       :4312 node    App            ● Live       Managed by portless run ⓘ
 dashboard.local ⧉ ↗ ▦      :3000         Nidum          ◌ Waiting    Change port · Rename · Remove
```

| State | Design |
| --- | --- |
| Empty | "No addresses yet." Body: "Pick a service in Discover, or add one by port." Buttons: Go to Discover · Add manually |
| Paused | Whole table at 60 % opacity, a strip above: "Sharing is paused. These addresses are offline." [Resume sharing] |
| Row error | Status Error; an inline notice under the row with the cause and Retry |
| Waiting for 10 min+ | Waiting tooltip adds "Remove it if you don't need it anymore." |

### 8.4 Network sharing

```
Network sharing
Lets other devices on your network open your addresses.

  ● Sharing on       Wi-Fi: HomeWiFi     This computer: 192.168.1.42     Secure (HTTPS) on
  [Pause sharing]  [Restart]

  Keep sharing after restart       (●○)   Starts automatically when this computer starts. Needs your password.
  Secure connections (HTTPS)       (●○)   Turn off if other devices show certificate warnings and you don't need security features.
  Use a fixed network address      (○●)   [ 192.168.1.42 ▾ ]  For computers with several network connections.
  Allow any sub-name               (○●)   Lets api.recipes.local reach recipes.local when api isn't set up separately.
```

- Changing HTTPS, fixed address or sub-names shows a "Restart to apply" strip with a Restart button; settings never restart silently.
- Turning HTTPS off shows a one-line consequence under the toggle: "Camera, microphone and offline features won't work on other devices."

### 8.5 Tools

A grid of tool cards, 3 across on desktop, 1 on phone. Each: icon, title, one line, one button.

| Card | Line | Button | Result shown in |
| --- | --- | --- | --- |
| Run diagnostics | Checks sharing, addresses and certificates. | Run | Output panel |
| Set up another device | Lets phones and laptops open secure addresses without warnings. | Start setup | Device setup dialog (below) |
| Fix certificate on this computer | Use if this browser warns about your addresses. | Fix | Inline notice |
| Fix Safari | Use if Safari can't find your addresses. | Fix | Inline notice |
| Clean up stray servers | Stops dev servers left behind by closed apps. | Clean up | Toast with count |

**Set up another device dialog** (the one non-destructive dialog, because it's a guided multi-step task):

1. "Nidum Local will open a setup page on your network for 10 minutes." [Start] (served directly at `http://<this computer's IP>:<port>`, decision D21)
2. Large QR for that setup URL + countdown ("9:42 left"), with tabs for iPhone/iPad, Android, Mac, Windows. Each tab shows 3–5 numbered steps with the exact Settings path to trust the certificate.
3. "Done? [Test this device]": shows a QR of a test address that turns the dialog green once the device loads it without a certificate error.
4. Closing the dialog or the timer ending stops the setup page; a toast confirms.

### 8.6 Advanced (collapsed by default)

- A disclosure titled "Advanced" with `--text-2` description "Internet sharing and reset."
- **Share outside your network** sub-section: per-address switches for Tailscale, Tailscale Funnel and ngrok, each disabled with a reason if the tool isn't installed or signed in. Turning one on opens a confirm: "Anyone on the internet with this link can open recipes. Continue?"
- **Danger zone**: bordered in `--error`, contains Reset Portless (typed confirmation) with the list of what it removes.

### 8.7 Footer

`Nidum Local 1.0.0 · Portless 0.15.6 · Powered by Portless · [Quit Nidum Local]`

Quit opens a small confirm: "Quit Nidum Local? Your addresses keep working; only this dashboard closes." After quitting, the page swaps to a static "Nidum Local is closed. Open the launcher to start it again." screen.

---

## 9. Interaction and motion

### Data freshness

| Data | Update method | Cadence |
| --- | --- | --- |
| Addresses, sharing status | Server-sent events | Immediate on change |
| Discover list | SSE when port set changes; server scans every 5 s | 5 s, paused when the tab is hidden |
| Web check per service | On first sight, then every 30 s | 30 s |
| Address status (Live/Waiting) | Server probes | 10 s |

- When the SSE connection drops, the header pill switches to "Reconnecting…" and the page falls back to polling every 5 s.
- If the dashboard server is gone (Quit or crash), a full-page state appears: "Lost contact with Nidum Local. [Reconnect] or open the launcher again."

### No optimistic UI

Every mutation waits for the CLI result. Buttons show a spinner during the call; targets: < 1 s typical, 5 s timeout with an inline error. The single exception is Undo after Remove, which re-creates the address.

### Motion

| Motion | Duration | Easing |
| --- | --- | --- |
| Row expand / collapse | 160 ms | `cubic-bezier(.2,.0,.0,1)` |
| New-row highlight fade | 2000 ms | linear |
| Popover / dialog in | 140 ms fade + 4 px rise | ease-out |
| Toast in / out | 180 ms | ease-out / ease-in |
| Row add / remove fade | 200 ms | ease |
| Copy icon swap | instant, revert after 1.5 s | — |

All motion is disabled under `prefers-reduced-motion: reduce`, except opacity fades kept at 80 ms.

### Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus Discover search |
| `n` | Focus Add manually → Port |
| `g a` | Jump to Your addresses |
| `Enter` in assign form | Create address |
| `Esc` | Close form, popover or dialog |
| `c` on a focused address row | Copy address |
| `?` | Show shortcuts sheet |

Shortcuts never fire while typing in a field.

### Focus management

- After Create address: focus moves to the new address chip's Copy button.
- After Remove: focus moves to the next row, or to the empty state's first button.
- Dialogs trap focus and return it to the opener on close.

---

## 10. Content and voice

### Voice

- Plain, calm, specific. Sentences under 20 words.
- Second person ("your network"), present tense, active voice.
- Say what happened and what to do next. Never blame the user.
- No exclamation marks, no emoji, no "Oops".

### Key strings

| Context | String |
| --- | --- |
| Page subtitle (header tooltip) | Share what's running on this computer with your network. |
| Discover description | Services running on this computer. Give any web service an address so other devices can open it. |
| Reach note, loopback | only this computer |
| Reach note, all interfaces | already open to the network at 192.168.1.42:5173 |
| Create success toast | recipes.local is ready. Open it on any device on HomeWiFi. |
| Remove toast | Removed recipes.local. [Undo] |
| Pause confirm | Pause sharing? 3 addresses will go offline until you resume. |
| Not web tooltip | Only web services can get an address. This one speaks a different protocol. |
| App source tooltip | Started with `portless run`. It goes away when that app stops. |

### Formatting conventions

- Ports written with a leading colon in UI (`:5173`), plain in prose sentences ("port 5173").
- Addresses shown without scheme; copied and opened with `https://` (or `http://` when HTTPS is off).
- Times as relative ("2 seconds ago") up to 1 hour, then local time (`14:05`).
- Folder paths shortened with `~` for the home folder and truncated from the left.

### Error message map

CLI and system errors are translated before display. The raw output is always available behind "Details".

| Raw condition | User message | Action |
| --- | --- | --- |
| Port 443 in use | Another program is using the web port (httpd). | Run diagnostics |
| mDNS tool missing (Linux) | Network names need avahi-utils, which isn't installed. | Copy install command |
| Network unreachable | You're not connected to a network. | Try again |
| Name exists | `recipes` already points to port 8080. | Use another name · Replace it |
| Admin dialog cancelled | Password not entered. Nothing changed. | Try again |
| CLI not found | Portless isn't installed anymore. | Open the launcher again |
| Timeout (5 s) | This is taking longer than expected. | Try again · Details |
| Unknown | Something went wrong. Nothing was changed. | Details · Run diagnostics |

---

## 11. Feedback, errors and empty states

### Which feedback goes where

| Situation | Pattern |
| --- | --- |
| Result of a click that succeeded | Toast |
| Validation of a field | Inline under the field |
| A problem with one row | Inline notice in the row |
| A problem with the whole page (sharing stopped, server lost) | Banner or full-page state |
| Something needing a decision with consequences | Confirm dialog |
| Long-running work | Spinner in the button that started it |

### Empty-state rules

Every empty state has an icon (24 px, `--text-3`), a one-line title saying what's missing, one sentence on why or what next, and at most two buttons. No illustrations.

---

## 12. Safety made visible

These are design elements, not just backend rules. They keep "reachable by the whole network" visible at all times.

- **Network name in the header** at all times while sharing is on.
- **Public network banner** when the OS reports a network as public (Windows) or when the SSID matches common guest patterns (`guest`, `free`, `public`, `airport`, `hotel`, case-insensitive). Dismissal lasts for that network only.
- **First-run banner** explaining exposure, shown once.
- **Pause sharing** always in the header, one click plus a confirm when addresses are live.
- **Risky service warning** before giving an address to Docker's API (ports 2375/2376) or any service whose title contains "admin": a confirm stating "Anyone on this network could control Docker on this computer."
- **Dashboard never shown with a `.local` address.** The browser URL stays `127.0.0.1`, and the header never offers to share the dashboard itself.
- **Danger zone** visually separated with an `--error` border and collapsed under Advanced.
- **Internet sharing** labeled "outside your network" with a globe icon, distinct from the Wi-Fi icon used for LAN sharing.

---

## 13. Accessibility

Target: **WCAG 2.2 AA**.

| Area | Requirement |
| --- | --- |
| Contrast | Body text ≥ 4.5:1, large text and UI borders ≥ 3:1 in both themes |
| Color independence | Every status has a glyph and a word, not just a color |
| Keyboard | Every action reachable by Tab; visible 2 px `--accent` focus ring with 2 px offset |
| Landmarks | `header`, `main`, one `section` per area with `aria-labelledby` its H2, `footer` |
| Live regions | Toasts in `role="status"`; banners for errors in `role="alert"`; Discover changes announced politely ("New service on port 5173") at most once per 10 s |
| Tables | Your addresses is a real `<table>` with `<th scope="col">`; on phone it becomes a list with the same reading order |
| Forms | Every input has a visible `<label>`; errors linked by `aria-describedby`; `aria-invalid` set |
| Icon buttons | `aria-label` naming the address, e.g. "Copy https://recipes.local" |
| QR codes | Always accompanied by the URL as selectable text |
| Targets | ≥ 24 × 24 px on desktop; ≥ 44 × 44 px on touch (`pointer: coarse`) |
| Zoom | Layout works at 200 % zoom and 320 px width without horizontal scroll |
| Motion | Respects `prefers-reduced-motion` |
| Language | `<html lang="en">`; strings kept in one file for later translation |

---

## 14. Responsive behavior

The dashboard is opened on the same computer, but browser windows get narrow (split screen, side panels), so it works down to 320 px.

| Breakpoint | Layout changes |
| --- | --- |
| ≥ 1024 px | As designed above; table layout for Your addresses; tools 3 across |
| 640–1023 px | Header wraps network info under the title; Add manually fields stay inline; tools 2 across; Addresses table hides the Source column (shown in a row tooltip) |
| < 640 px | Header shows only mark, status pill and counter; Pause moves to the Network sharing section; Discover rows stack (port + title, then meta, then full-width button); Add manually fields stack; Addresses become cards; tools 1 across; toasts bottom-center |

---

## 15. Theming and dark mode

- Follows the OS by default (`prefers-color-scheme`).
- A theme switch in the footer: System · Light · Dark, stored in `localStorage` (wrapped in try/catch; falls back to System).
- Tokens redefined under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`.
- In dark mode: no shadows on cards (borders carry separation), accent lightened (table in section 6), QR codes stay black on white.

---

## 16. Front-end constraints

These shape what the design can rely on.

- **Fully offline.** No CDN, web fonts, analytics or remote images. Everything is served by the local server.
- **Small.** Total page weight ≤ 150 KB gzipped, including icons and the QR generator.
- **Single page, no build step required to run.** Plain HTML, CSS custom properties and a small JS module (or Preact + htm vendored locally).
- **No browser storage for real state.** Addresses and settings always come from the server; `localStorage` is only for theme, density and dismissed banners.
- **Token handling is invisible.** The launcher passes the session token in the URL once; the page moves it to memory and strips it from the address bar with `history.replaceState`, so it never appears in a copied URL or a screenshot.
- **Supported browsers:** current Chrome, Edge, Firefox and Safari (last two versions).

---

## 17. Open design questions

1. **Brand palette and mark.** The accent and logo are placeholders until the Nidum brand assets are supplied.
2. **HTTPS default on the network.** Design assumes HTTPS on with the device setup flow. If HTTP becomes the default, the HTTPS toggle copy and the QR footnote change.
3. **Discover row density.** Two-line rows favor clarity; home-lab users with 30+ services may want a compact one-line density toggle.
4. **Native wrapper later.** A signed macOS `.app` / Windows `.exe` could show the dashboard in its own window with a menu-bar/tray icon showing sharing status. That would move Pause sharing to the tray.
5. **Localization.** v1 is English; strings are centralized, but layouts haven't been tested with longer languages (German, French).
6. **Public network detection on macOS and Linux.** There's no OS "public" flag; the SSID heuristic may need user feedback before shipping.
