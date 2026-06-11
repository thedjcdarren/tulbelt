# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rule 1 — Think Before Coding
State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

## Rule 3 — Surgical Changes
Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

## Project

Tulbelt is a Manifest V3 browser extension that ships quality-of-life toggles
for tulip.co. **Vanilla JavaScript, no dependencies, no build step, no
transpile.** Don't add a toolchain.

## Architecture

The codebase is registry-driven — three files talk to each other through one
source of truth, and the rest is per-toggle leaves.

- **`features.js`** — the single registry. Every toggle is one entry in
  `FEATURES` (`id`, `name`, `description`, `defaultEnabled`, optional `major`,
  optional network `rule`). `popup.js` and `background.js` both read from it.
  `getToggles()` merges defaults with `chrome.storage.local` and handles legacy
  ID migration (see `LEGACY_COMPACT_APP_EDITOR_HEADER_IDS`).
- **`background.js`** — MV3 service worker. Two jobs:
  1. Reflect any feature with a `rule` into `chrome.declarativeNetRequest`
     dynamic rules (re-syncs on install, startup, and storage change). Rule
     IDs are positional (`ruleIdFor(index)`), so **reordering `FEATURES`
     changes rule IDs** — avoid it.
  2. Bridge SPA navigations that DNR misses (`webNavigation.onHistoryStateUpdated`)
     for the table-sort feature.
- **`popup.html` / `popup.js`** — auto-renders a switch per feature from the
  registry. No per-feature popup code; you never edit the popup to ship a
  toggle. Grouping is `major: true` → "Major" section, else "More".
- **`toggles/<feature>.js`** — one content script per DOM/behavior tweak.
  Plain IIFEs (`(() => { ... })()`), **not ES modules** — content scripts
  can't `import`. Each one:
  - reads `chrome.storage.local`'s `toggles` object,
  - has a `syncFromStorage()` that no-ops if unchanged, applies on enable,
    **reverts on disable**,
  - listens on `chrome.storage.onChanged` and re-syncs,
  - calls `syncFromStorage()` once at the end.
- **`manifest.json`** — every content script must be registered here. Three
  separate `content_scripts` blocks exist for different execution contexts:
  default (isolated world, top frame), `all_frames: true` (subframes, e.g.
  context menu), and `world: "MAIN"` (page's own JS context, for the
  expression-editor fuzzy patch). Pick the right block.

## Hard invariants

- **Every toggle must cleanly revert when switched off, without a page
  reload.** This is non-negotiable. The off path is as important as the on
  path. `toggles/strip-tab-title-prefix.js` is the canonical short example.
- **Don't reorder `FEATURES`** unless you accept that DNR rule IDs shift.
- **Don't reuse a toggle `id`** — IDs are persisted in user storage.
- **Never commit tenant-specific Tulip hostnames.** Customer instance URLs
  (e.g. a real `your-instance.tulip.co` URL copied from the browser) must not
  appear in commits, PRs, docs, comments, or
  test notes. Use only wildcards and placeholders already in the repo:
  `*.tulip.co`, `*://*.tulip.co/*`, regex like `\\1.tulip.co`, or doc
  placeholders `example.tulip.co` / `your-instance.tulip.co`. Do not paste
  URLs from your browser bar, DevTools, screenshots, or local scratch files
  into tracked files. Put instance-specific repro steps in gitignored local
  notes (see `.gitignore`).

## Adding a toggle

1. Add a `FEATURES` entry in `features.js`.
2. For DOM tweaks: create `toggles/<id>.js` (copy a small existing one for
   shape) and register it in `manifest.json` under the right `content_scripts`
   block.
3. For pure network rules (redirect/block): just add the `rule` key to the
   `features.js` entry. No content script, no manifest change.
4. Non-trivial features get a short design note in `docs/`.

Full recipe and rationale in `CONTRIBUTING.md`.

## Debugging without a browser

Claude has no browser access. To inspect live Tulip pages, write temporary
capture code in `toggles/dev-probe.js` using the `window.__tulbelt` helpers
and ask the user for a `__tulbelt.copy()` report. Full workflow, helper API,
and the restore-stub-before-commit rule: `docs/devtools.md`.

## Commands

No build, no test runner. **Never write automated tests or test cases** —
this extension is always tested manually by human users against a real Tulip
instance, and a test suite would just rot. Sanity checks are syntax-only:

```sh
node --check features.js
node --check background.js
node --check popup.js
node --check toggles/<file>.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

Manual test loop:

1. `chrome://extensions` → enable Developer mode → **Load unpacked** on the
   repo root (or click **reload** on the extension card after edits).
2. For content-script changes, also reload the `*.tulip.co` tab.
3. In the popup, toggle the feature **on, then off**, and confirm the page
   fully returns to its original state. Testing requires access to a Tulip
   instance.
