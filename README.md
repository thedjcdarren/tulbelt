# Tulbelt

Quality-of-life toggles for [tulip.co](https://tulip.co). Tulbelt is a small,
dependency-free Manifest V3 browser extension: a popup with on/off switches,
each one a self-contained tweak to the Tulip web UI.

> **Unofficial.** Tulbelt is a community project and is not affiliated with,
> endorsed by, or supported by Tulip Interfaces. "Tulip" is used only to
> describe what the extension works with.

## What it does

Open the toolbar popup to see every available toggle with a description. A few
examples of what's in there:

- **Sort tables by newest** — opens table views sorted by `_createdAt` desc.
- **Dark mode** — a filter-inversion dark theme for tulip.co.
- **Copy/Cut in widget menu** — adds Copy/Cut to the app editor canvas menu.
- **Visual filters editor** — a row-per-filter builder for connector `filters`.
- **Fuzzy expression autocomplete** — substring matching in the formula editor.

The full, authoritative list lives in [`features.js`](./features.js) and is
rendered automatically in the popup — no list here to drift out of date.

## Install (from source)

There is no build step. Load the repository directly:

1. Clone or download this repo.
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.
5. Pin the **Tulbelt** icon and open the popup on any `*.tulip.co` page.

Toggles take effect immediately — no page reload needed for most of them, and
every toggle is designed to cleanly revert when switched back off.

## How it works

- `manifest.json` — MV3 manifest; declares content scripts and permissions.
- `features.js` — the feature **registry**. One entry per toggle. The popup
  and the background worker both read from this.
- `popup.html` / `popup.js` — auto-renders a switch for every registered
  feature; no per-feature popup code.
- `background.js` — service worker. Syncs `declarativeNetRequest` rules for
  features that declare a network `rule` (e.g. URL redirects).
- `toggles/<feature>.js` — one content script per DOM/behavior tweak. Each reads
  its on/off state from `chrome.storage.local` and applies or reverts itself.
- `docs/` — design notes for the more involved features.

## Contributing

Contributions are welcome — adding a toggle is intentionally a small, local
change. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the architecture and the
step-by-step recipe, and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © 2026 Daniel Pomeranz
