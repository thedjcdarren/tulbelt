# Option Sets Builder — Design

**Date:** 2026-07-26
**Toggle id:** `option-sets-builder`

## Summary

A new toggle that adds an "Option Sets" item to the Account Settings sidebar on
`*.tulip.co/account/*` pages. Clicking it shows a Tulbelt-owned page at the fake
URL `/account/option-sets`: Tulip's real header and settings sidebar stay
intact, but the main content pane is replaced with our own container. This
first version ships a placeholder shell (page title + empty content container);
the actual Option Sets builder UI is a follow-up.

Popup placement: visible to everyone, `defaultEnabled: true`, `major: true`.

## How the fake route works

The Tulip account area is a React SPA. React Router only reacts to navigations
it initiates (or `popstate`). So:

- **Inject a nav item** by cloning an existing (unselected) sidebar `<li>`,
  relabeled "Option Sets" with `data-testid="option-sets"`, inserted in
  alphabetical position (after "Network access", before "Player").
- **Intercept the click**: `preventDefault()`, then
  `history.pushState(null, "", "/account/option-sets")`. The URL bar changes;
  React never hears about it and keeps rendering the previous settings page.
- **Swap the body**: hide the content pane (all element siblings of the sidebar
  column), append our container in its place, and move the "selected" nav
  styling to our item.
- **Selected styling**: styled-components class hashes are build-specific, so
  they are never hardcoded. The selected `<li>` is detected as the minority
  className among sidebar items; that className is copied to our item and the
  demoted item gets the majority (unselected) className. Restored on
  deactivate.

## Lifecycle

- **Deactivate** (click on any real link while active): restore siblings,
  remove our container, restore nav classes, and `history.replaceState` back to
  the last real settings path so the router's belief and the URL agree again —
  then let the click proceed normally.
- **Back/forward**: `popstate` to a real URL deactivates (without touching the
  URL); `popstate` back to `/account/option-sets` re-activates.
- **Hard reload / direct link**: on load at `/account/option-sets`, wait for
  the sidebar to appear, then activate over whatever Tulip rendered (404 body
  or redirect target — if the SPA redirected away, push the fake URL back). If
  Tulip never renders the settings sidebar at all, the toggle no-ops.
- **Re-renders**: a MutationObserver re-injects the nav item and re-asserts the
  active state whenever React rebuilds the sidebar.
- **Toggle off while active**: deactivate, restore the underlying real page URL
  via `replaceState`, remove the nav item.

## Files

- `toggles/option-sets-builder.js` — new isolated-world content script
  (document_idle, same block as the other isolated toggles). No MAIN-world
  half; only DOM + `history` are touched.
- `manifest.json` — register the script.
- `features.js` — registry entry.

## Testing

Manual, like the rest of tulbelt: inject → click → fake URL → click away →
back/forward → hard reload on the fake URL → toggle off while on the page.
