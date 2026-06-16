# Toggle reference

Every toggle Tulbelt ships, what it changes, and its out-of-the-box state.

The **authoritative** list and exact behavior live in [`features.js`](../features.js)
and are rendered live in the popup. This page is a human-readable companion —
if the two ever disagree, `features.js` wins.

"Default" is the state a fresh install starts in; you can flip any toggle from
the popup at any time, and every toggle cleanly reverts when switched off.

Toggles are split into **major** and **minor** by relative implementation
complexity — not by how useful they are. _Major_ toggles are large, stateful,
or reach deep into Tulip's React internals (hundreds to ~1500 lines, sometimes
across two script worlds). _Minor_ toggles are small, self-contained DOM/CSS
tweaks or a declarative redirect.

## Major toggles

These carry the most logic and the most surface area for Tulip UI changes to
break them. Listed most-complex first.

### Fuzzy expression autocomplete — `expression-editor-fuzzy` · **default: off** · **developer-only**

Hidden from the popup unless developer mode is on (five quick clicks on the
popup title). In the formula/expression editor popup, replaces the "starts with" filtering of
suggestions with a case-insensitive substring (contains) match. Typing `User.`
surfaces `@Table record.Current User.ID` etc. Arrow keys / Enter / click work
as before. The heaviest feature in the extension: a two-world (isolated + MAIN)
script pair that reads Tulip's full suggestion catalog from React fibers. Deep
dive: [expression-editor-fuzzy-main.md](./expression-editor-fuzzy-main.md).

### Visual filters editor — `filters-builder` · **default: on**

On connector function pages, replaces the JSON text box for the `filters` query
parameter with a row-per-filter builder (field, function, arg), built on a
model of Tulip's pill field. The field's value is an ordered token list (one
`<input>` per text run, one `.param-pill` per variable) and pills always sit
inside JSON string literals — the enclosing quotes live in the neighboring text
tokens. So the canonical text form is the in-order concatenation with each pill
spliced in as `$Label$`, with no JSON-string-state scanning. A whole-arg
`$Name$` renders as a chip in the builder (× clears it back to a text input);
typing `$Name$` in an arg field creates one. The token list is only how the
field renders: its React state (probed via the component fiber) is the
canonical string itself, owned by the nearest ancestor with
`{ value: string, onChange }` props. Writes therefore skip token surgery
entirely — the isolated half dispatches the new string to
`toggles/filters-builder-main.js` (MAIN world), which calls that onChange
directly; Tulip re-renders inputs and pills from the string. Nothing is written
until the user edits a builder field.

### Full variable path on selection — `variable-full-path` · **default: on**

In the trigger editor variable picker, when you select a nested Object field,
rewrites the trigger button label from the leaf name only to the full ancestor
path (`Parent → Child → Leaf`). Uses indent depth in the virtualised dropdown
(and optional disabled group-header rows) to reconstruct the hierarchy.

When the trigger editor opens (detected via the "Copy link to trigger" button),
it also runs a one-time pass that briefly opens each already-selected variable
trigger to read its hierarchy and patch the label, so variables chosen before
the toggle ran are expanded too. Skips top-level variables and already-patched
buttons.

### Copy/Cut in widget menu — `context-menu-copy-cut` · **default: on**

In the app editor canvas widget context menu (Delete / Move To Front / Back),
adds Copy (Ctrl+C) and Cut (Ctrl+X) rows that synthesize those keyboard
shortcuts when clicked.

### Auto-snapshot every 15 active min — `auto-snapshot` · **default: off**

In the app editor, tracks active editing time per app and automatically creates
a snapshot after each 15 minutes of activity. Stateful — it persists per-app
activity time across navigation.

## Minor toggles

Small, self-contained tweaks. Listed in `features.js` order.

### Sort tables by newest — `table-default-sort` · **default: on**

On tulip.co table views, redirects to a URL that sorts by `_createdAt`
descending so the most recently created rows are on top. Implemented as a
`declarativeNetRequest` redirect rule plus a `background.js` bridge that catches
SPA navigations DNR misses. The bridge ignores Back/Forward navigations
(`forward_back` transition qualifier) and instead steps back past the un-sorted
duplicate entry the redirect leaves behind — otherwise re-sorting on Back made
the browser Back button "go to itself".

### Row actions next to name — `reorder-row-buttons` · **default: on**

On app and folder lists, moves each row's edit and actions buttons next to the
row's name instead of leaving them at the far right.

### Hide legacy editor tiles — `hide-legacy-tiles` · **default: on**

In the app editor context pane, hides deprecated tiles: Step cycle time, Step
comments, Process cycle time, and App comments.

### Disable hover tooltips — `disable-tooltips` · **default: off**

Suppresses the tooltip pop-ups on hover-only action buttons (cut, copy, etc.)
while leaving toolbar button tooltips intact.

### Hide base layout triggers — `hide-view-only-triggers` · **default: off**

In the trigger editor, hides inherited base-layout triggers (lock icon, no
copy/view row actions). Other view-only triggers with copy/view buttons stay
visible.

### Move variables to toolbar — `move-variables-to-toolbar` · **default: off**

Hides the Variables tile in the app editor context pane and mirrors its Edit
button into the top toolbar.

### Hide editor header & palette — `hide-app-editor-chrome` · **default: off**

On app version editor pages only (`/w/…/apps/…/versions/…`), hides the site
header, subheader row (breadcrumbs, Run/Publish), and Add/Icons palette.

### Compact app editor header — `compact-app-editor-header` · **default: off**

In the app editor: hides the workspace name beside breadcrumbs, hides leading
icons on palette buttons (Add, Icons, …, Forward/Back), and tightens vertical
padding on the subheader and palette rows. (Supersedes the older
`hide-app-editor-palette-icons` and `hide-subheader-workspace-label` toggles,
which migrate automatically.)

### Dark mode — `dark-mode` · **default: off**

Applies a dark color scheme to tulip.co via filter-inversion (invert, contrast,
brightness on the document; restored regions use the exact inverse so previews,
canvas, images, and video stay hue-faithful). Targeted tweaks for specific
surfaces are layered on top.

### Strip "Tulip | " from tab titles — `strip-tab-title-prefix` · **default: off**

Removes the leading "Tulip | " prefix from browser tab/window titles so the
page-specific name shows first.

### Frequent actions on top — `action-editor-frequent` · **default: on**

Collapses the trigger action-type dropdown (`select[data-testid$="action-editor"]`)
to Data Manipulation, Table Records, Run Function, and Run Connector Function,
plus a "Show all actions…" option. Picking it rebuilds the list with every
action (frequent still pinned on top) and reopens the dropdown via
`showPicker()`. If the current selection isn't one of the four, it stays
visible in the collapsed list. The select is React-controlled, so a sibling
proxy `<select>` is rendered in its place (the real one is hidden) and
selections are forwarded back to React via a native value setter + bubbling
change event.

### Collapse table rows — `collapse-tables-tile` · **default: off**

On app version editor pages only (`/w/…/apps/…/versions/…` or
`/apps/…/versions/…`), turns each row of
the Tables tile in the right context pane into a tree-view item. A caret pinned
to the right edge of each row toggles its collapsed state; when collapsed, the
row's Query / Record Placeholder buttons, aggregations, and linked record
placeholders are hidden, leaving just the icon, table name, and a two-line
"· N placeholders" / "· M aggregations" summary visible (lines with a zero
count are omitted). A "Collapse all" / "Expand all" toggle below the Add
Table row collapses or expands every table at once. The summary is hidden when
expanded, and the table-name button keeps its original menu-open click. Each
table starts collapsed; state lives in DOM attributes only, so a fresh
navigation collapses everything again.

### Snap widgets to 10px grid — `snap-to-grid` · **default: off**

On app version editor pages only (`/w/…/apps/…/versions/…` or
`/apps/…/versions/…`), snaps a widget's position and size to the nearest
multiple of 10 when a drag or resize ends. Tulip owns the drag; a press that
doesn't move past a small threshold counts as a click and snaps nothing. After
a real drag, the moved values (Tulip commits them to the pane a few frames
late, so they're polled for) are rounded and written back through the
context-pane number inputs (`context-pane-tool-position-x/-y`, `-size-w/-h`):
the value is set via a native setter, then `input`/`change` + Enter + blur fire
so Tulip's commit-on-blur handler persists it. A move snaps only X/Y, a resize
snaps size (and X/Y if the handle moved them); fields the interaction didn't
change — and values typed directly into the inputs — are left untouched.

### Searchable query picker — `query-list-search` · **default: on**

In the Query picker popper (the column of saved-query buttons opened from a
Query field), caps the popper column to 75% of the viewport height — the list
scrolls inside instead of running off the bottom — restores a readable 14px
font (Tulip shrinks it to cram every query in), adds 6px of spacing between the
query buttons, fixes the column to a 280px width so long query names truncate
with an ellipsis (hovering a truncated button shows its full name via a `title`
tooltip), and inserts a sticky search box as the first child. Typing
filters the query buttons by case-insensitive substring; the "Create New Query"
action is never hidden. The popper is
portal-mounted with hashed class names, so it's found by content (the
"Create New Query" button) and its parent column is the element we cap and
filter. Tulip's React buttons are never reparented — only hidden inline — so
the transient popper reverts cleanly on disable.

### App list Created/Completed columns — `app-list-date-columns` · **default: on**

On app/folder list pages, adds **Created** and **Last Completed** columns after
**Last Modified**. Those dates aren't in the DOM — they live in the JSON the page
fetches from `/api/apps/v1/.../apps` — so a `world: "MAIN"` half (`run_at:
document_start`) transparently patches `fetch`/XHR to capture `{ id ->
created.at, lastCompleted.at }`, while an isolated half bridges the toggle state
via `<html data-tulbelt-app-dates-enabled>`. Two cells are cloned from the Last
Modified cell and inserted before the trailing button columns, and the row's
`grid-template-columns` is widened to match (replaying `reorder-row-buttons`'s
permutation when that toggle is also on, so both stay aligned). Folder rows and
never-completed apps show an em dash. Reverts to the original grid on disable; the
invisible capture wrapper stays. See `docs/app-list-date-columns.md`.

### Dev Tools (agent debugging) — `dev-tools` · **default: off** · **developer-only**

Hidden from the popup unless developer mode is on. Defines `window.__tulbelt`
in the extension's isolated world with logging and DOM-inspection helpers
(`log`, `snapshot`, `tree`, `watch`) used by coding agents debugging toggles
without browser access. Run `__tulbelt.copy()` in the DevTools console (with
the context dropdown set to **Tulbelt**) to copy a JSON report with the tenant
hostname redacted. Never touches the page; disabling stops all watchers and
clears the buffer. Workflow and API: [devtools.md](./devtools.md).
