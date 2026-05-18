# Expression editor fuzzy search (`expression-editor-fuzzy-main.js`)

This document explains how the main-world half of Tulbelt’s expression-editor fuzzy search works. The implementation lives in `expression-editor-fuzzy-main.js`; the isolated-world toggle bridge is in `expression-editor-fuzzy.js`.

## Purpose

Tulip’s expression autocomplete is React-driven and **context-filtered** (fields vs functions/operators depend on what you’ve typed). This feature replaces the visible suggestion list with a custom overlay that searches the **full** suggestion catalog (~31k items) while still inserting choices through Tulip’s native `onSelection` handler.

## Two-world architecture

Chrome extension content scripts normally run in an **isolated world** where React fiber expandos (`__reactFiber$…`) on DOM nodes are often invisible. This feature is split:

| Piece | World | Role |
|-------|--------|------|
| `expression-editor-fuzzy.js` | Isolated | Reads `chrome.storage`, sets `<html data-tulbelt-fuzzy-enabled="true\|false">` |
| `expression-editor-fuzzy-main.js` | **MAIN** (see `manifest.json`) | Watches that attribute; all DOM/React work happens here |

The main-world script cannot use `chrome.*` APIs. Enable/disable is signaled only via the `data-tulbelt-fuzzy-enabled` attribute on `<html>`.

## High-level flow

```
html[data-tulbelt-fuzzy-enabled="true"]
  → MutationObserver on document
  → Detect popper + ReactVirtualized list + expression editor
  → attachToPopper
  → Read master list from React fiber
  → Hide native list, show custom overlay
  → On editor mutations: render (filter + draw rows)
  → Click / Enter → selectItem → Tulip's onSelection
```

## Activation lifecycle

| Event | Action |
|-------|--------|
| `data-tulbelt-fuzzy-enabled="true"` | Inject styles, install capture-phase key handler, start document observer, scan and attach poppers |
| Popper appears (list + editor) | `attachToPopper` → overlay + editor `MutationObserver` |
| User types | `render` → re-read live arrays, filter, redraw overlay |
| User picks row / Enter | `selectItem` → synthetic backspaces + `onSelection` |
| Feature off | Detach all, remove styles; stop observer unless observe mode is on |

On load, `applyEnabled(readEnabledAttr())` runs immediately; an attribute observer keeps state in sync when the isolated script toggles the feature.

## Finding and attaching to the popup

When enabled:

1. **`ensureStyles`** — CSS for overlay rows and hiding the native React list.
2. **`installGlobalKeyHandler`** — capture-phase `window` keydown (runs before Tulip’s editor handlers).
3. **`startObserver`** — `MutationObserver` on `document.documentElement` for new poppers/lists.
4. **`requestScan` → `scanAll`** — coalesced per animation frame; finds `.ReactVirtualized__List` inside `[data-testid="popper"]` that also contains `[data-testid="expression-editor-input"]`.

### `attachToPopper`

Core hook-up for each expression-editor popper:

- **`fiberOfNearestHost(list)`** — walks up to 6 ancestors to find a React fiber (the list element is not always the fiber host).
- **`findLists(fiber)`** — walks the fiber tree (up + shallow down) and collects every “options-shaped” array from `memoizedProps` and hook state.
- **`master`** — largest options array (full ~31k catalog).
- **`indexed`** — preferred: array whose items have `.indexes`; fallback: smallest non-master array (Tulip’s context-filtered list).
- **`findSelectHandler`** — walks up fibers for `onSelection` (and fallbacks: `onSelect`, `onSelectItem`, etc.).
- **`buildOverlay`** — hides the real list (`data-tulbelt-fuzzy-hide-react-list="true"`) and appends a plain DOM overlay in the same wrapper.

Per-popper state is stored in `popperState` (`WeakMap`). Editor changes trigger `render` via a `MutationObserver` on the editor.

## React introspection

### Fiber access

`fiberOf(node)` uses `Object.getOwnPropertyNames` (not `Object.keys`) to find expandos matching:

- `__reactFiber$`
- `__reactInternalInstance$`
- `__reactContainer$`

### `findLists` / `readArrayFrom`

`findLists` scans props and hook chains for arrays whose items look like suggestions (strings or objects with `label`, `displayName`, `path`, etc.). It returns stable `{ fiber, key }` sources.

`readArrayFrom(source)` re-fetches the live array on every render — Tulip replaces array references on each keystroke (immutable updates).

### `pickLiveItem`

When selecting, maps a master-catalog item to the matching entry in the smaller **indexed** list (by `value` or label) so Tulip receives correct metadata when possible.

## Filtering (“fuzzy”)

Despite the name, filtering is **case-insensitive substring** search on labels, capped at **200** results (`MAX_RESULTS`). Master-list order is preserved.

### Rules

- **Bypasses Tulip’s context gating** — e.g. type `floor` to reach `Floor()` from anywhere; type `user.id` without `@` to reach field paths.
- Leading `@` on the **query** restricts results to labels starting with `@`.
- Leading `@` on field labels is stripped from the haystack so `user.id` matches `@Table … User.ID`.
- **`HIDDEN_LABEL_PREFIXES`** drops noisy categories (`@Users`, `@User Groups`, `@Machine Activity Field`, `@Last Machine Output`).

The **query** string comes from `getCurrentRange` (see below).

## Caret and token range

Tulip’s editor is not a normal contenteditable. It mirrors text in:

- `.content` — spans with `data-index`
- `.cursorContainer` — `.cursor` spans for caret position

### `getCurrentRange`

1. **`caretOffsetIn`** — finds visible `.cursor`, maps to `data-index` span for offset; falls back to `TreeWalker` over text nodes.
2. Walk **backward** from caret to previous **hard separator**: `[+\-*/(),;"'=!<>%&|^~]` — whitespace and `.` are **not** separators (field names contain spaces and dots).
3. Skip leading whitespace inside the token.
4. Clamp start to the active span (field chip) via `spanAtCaret`.
5. Walk **forward** to token end (same separator rules), clamped to span.

Returns `{ text, query, start, end }` used for filtering and splice range on select.

## Rendering the overlay

`render(state)`:

1. Re-reads live master/indexed arrays via `readArrayFrom`.
2. Computes `currentRange` and `filtered = fuzzyFilter(masterList, query)`.
3. Rebuilds overlay rows; maintains `selectedIndex` for keyboard highlight.
4. Shows empty state when no matches.

## Selecting an item (`selectItem`)

Tulip’s `onSelection` recomputes splice range from the caret using **whitespace** tokenization. This extension uses **operator** tokenization. The bridge:

1. **`resolveSelectionRange`** — prefers `pendingSelectionRange` (from mousedown), else last render’s `currentRange`, else fresh read.
2. **`moveCaretToOffset`** — synthetic `ArrowRight` keydowns to reach `range.end` (never ArrowLeft — would jump into prior chips).
3. Compute **`extra`** — chars between our token start and Tulip’s whitespace-based start; issue that many synthetic **Backspace** keydowns via `sendBackspaces`.
4. Re-resolve fresh **`onSelection`** from current fiber (handler closures go stale after deletes).
5. **`pickLiveItem`** — prefer live indexed item when resolvable.
6. Call **`onSelect(payload)`** with `indexes: { start, end - extra }` merged onto the item.

## Keyboard navigation

Single **capture-phase** listener on `window` for `ArrowUp`, `ArrowDown`, and `Enter` when the event target is inside the attached editor. Uses `preventDefault` + `stopImmediatePropagation` so Tulip does not navigate its hidden native list.

Registration order matters: per-editor listeners would run after Tulip’s; capture on `window` fires first regardless of order.

## Observe mode (debugging)

Independent of the feature toggle. Enable from the page console:

```js
__tulbeltFuzzy.observe(true)   // start session-only logging
__tulbeltFuzzy.observe(false)  // stop
__tulbeltFuzzy.observe()       // toggle
```

Does **not** change the UI (no overlay, no list hide). Logs editor text, query range, master/indexed arrays, and visible DOM rows on each edit; logs before/after editor text on native row clicks. Useful for reverse-engineering Tulip with the override off.

## Debug API (`window.__tulbeltFuzzy`)

| Method | Purpose |
|--------|---------|
| `setEnabled(bool)` | Session-only toggle (storage/popup can override on next sync) |
| `observe(bool?)` | Toggle passive shadow logger |
| `traceSelect(bool?)` | Verbose selection logging |
| `snapshot()` | One-shot state dump to console |
| `scan()` | Force `scanAll` |
| `findLists(node?)` | Dump master/indexed/all arrays from fiber |
| `dumpArrays(node?)` | Summarized array hunt |
| `range()` | Current token range for active editor |
| `state()` | Live attached popper state |
| `visible()` | Items read from currently rendered virtualized rows |
| `dump(node?)` | Fiber chain summary |
| `findSelect(node?)` | Locate selection handler |

## Key constants and selectors

| Symbol | Value / meaning |
|--------|----------------|
| `POPPER_SEL` | `[data-testid="popper"]` |
| `EDITOR_SEL` | `[data-testid="expression-editor-input"]` |
| `LIST_SEL` | `.ReactVirtualized__List` |
| `ATTR` | `data-tulbelt-fuzzy-enabled` |
| `MAX_RESULTS` | 200 |

## Related files

- `expression-editor-fuzzy-main.js` — main-world implementation
- `expression-editor-fuzzy.js` — isolated-world storage → attribute bridge
- `manifest.json` — `world: "MAIN"` content script entry
- `features.js` — feature id `expression-editor-fuzzy` for popup toggles

## One-line summary

Reads Tulip’s full suggestion list from React fibers in the main world, filters it client-side by the token under the caret, replaces the native virtualized list with a DOM overlay, and inserts selections through Tulip’s `onSelection` — with synthetic backspaces to align Tulip’s whitespace-based tokenizer with the extension’s operator-based tokenizer.
