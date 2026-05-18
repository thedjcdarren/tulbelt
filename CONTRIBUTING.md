# Contributing to Tulbelt

Thanks for helping out. Tulbelt is deliberately simple: **vanilla JavaScript,
no dependencies, no build step, no transpile.** Please keep it that way —
changes that add a toolchain or framework will be asked to justify themselves.

## Ground rules

- **One feature (or fix) per pull request.** Small, reviewable diffs.
- **Surgical changes.** Touch only what your feature needs. Don't reformat or
  "improve" adjacent code.
- **Every toggle must cleanly revert.** When a user switches a toggle off, the
  page must return to its original state without a reload. Look at any existing
  content script (`strip-tab-title-prefix.js` is a short example) — they all
  have an explicit restore path. This is a hard requirement, not a nicety.
- **Match the existing style.** 2-space indent, single quotes, semicolons, and
  a top-of-file comment explaining *why* the approach works (not just what it
  does). Read a couple of existing files first.

## Architecture in one minute

- **`features.js`** is the registry. Every toggle is one entry in the
  `FEATURES` array (`id`, `name`, `description`, `defaultEnabled`, and an
  optional network `rule`). `popup.js` renders the switch list from this
  automatically — you never edit the popup.
- **Content scripts** (`<feature>.js`) are plain IIFEs (not ES modules — they
  can't `import`). They read `chrome.storage.local`'s `toggles` object, apply
  on enable, revert on disable, and re-sync on `chrome.storage.onChanged`.
- **`background.js`** turns any feature with a `rule` into a dynamic
  `declarativeNetRequest` rule. Pure network features (redirects/blocks) need
  *no* content script at all.

## Adding a toggle

### Case A — a DOM or behavior tweak (most features)

1. Add an entry to `FEATURES` in `features.js`:
   ```js
   {
     id: 'my-feature',          // stable, kebab-case, never reused
     name: 'Human readable name',
     description: 'One sentence the popup shows.',
     defaultEnabled: false,     // be conservative; most start off
   },
   ```
2. Create `my-feature.js` following the existing pattern. Copy a small one
   (e.g. `strip-tab-title-prefix.js`) and keep its shape:
   - wrap everything in `(() => { ... })()`
   - `const FEATURE_ID = 'my-feature';` and `const STORAGE_KEY = 'toggles';`
   - a `syncFromStorage()` that reads the toggle, no-ops if unchanged, and
     applies **or** reverts
   - a `chrome.storage.onChanged` listener that re-runs `syncFromStorage()`
   - call `syncFromStorage()` once at the end
3. Register the file in `manifest.json` under `content_scripts`. Add it to the
   default array, unless it needs the page's own JS context
   (`world: "MAIN"` array) or must run in subframes (`all_frames` array).

### Case B — a pure network rule (redirect/block, no DOM)

Only add the `rule` key to the `features.js` entry (see `table-default-sort`
for the shape). `background.js` syncs it automatically. No content script, no
manifest change.

### For non-trivial features

Add a short design note under `docs/` explaining the approach and any tricky
Tulip-DOM assumptions (see `docs/expression-editor-fuzzy-main.md`).

## Testing your change

You need access to a Tulip instance to test against real pages.

1. Load the extension unpacked (see README).
2. After editing: click **reload** on the extension card in
   `chrome://extensions`. For content-script changes also reload the
   `*.tulip.co` tab.
3. In the popup, toggle your feature **on and then off**, and confirm the page
   fully returns to its original state.

Quick local sanity checks (no dependencies needed):

```sh
node --check my-feature.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
node --check features.js
```

## Opening the pull request

Describe **what** the toggle does and **why**. For UI changes, include
before/after screenshots or a short clip. Confirm in the description that the
toggle reverts cleanly when disabled. If the change is user-facing, the popup
updates itself from `features.js`, so no doc edit is required — but feel free
to bump the `version` in `manifest.json` if you think a release is warranted
(maintainer will decide).

By contributing, you agree your contributions are licensed under the project's
[MIT License](./LICENSE).
