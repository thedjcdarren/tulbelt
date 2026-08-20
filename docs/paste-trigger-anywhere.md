# Paste Trigger Anywhere — research notes and design

Working notes for a planned toggle that lets a copied trigger be pasted onto an
owner Tulip currently refuses: a button trigger onto an interactive table, an
"On step enter" trigger onto a button, a trigger from one custom widget type
onto another.

Status: **research + design.** The interception point is chosen but not yet
confirmed against a live instance — see [Open questions](#open-questions) and
the probe in [`probes/trigger-clipboard-probe.js`](./probes/trigger-clipboard-probe.js).

## What Tulip does today

Copy/cut lives on the trigger row itself — the small icons beside each trigger
in the side pane and trigger list. (`hide-view-only-triggers` already keys off
that row: `[class*="triggerRowStyles"]`, with `[data-testid^="view-trigger-"]`
marking rows that keep their row actions.) Paste is a keyboard action on the
_target_, not a button: select the widget or step, press Ctrl/Cmd+V, and Tulip
opens the trigger editor pre-filled with the copied trigger. It is bound to the
new owner only when you press **Save**, so nothing is committed until the user
confirms — which is what makes a paste-side tweak safe to attempt.

Documented behavior worth keeping in mind:

- Copy, cut and paste work **within an app and into a different app**. If the
  destination app already has a variable with the same name and type as one the
  trigger references, the pasted trigger binds to the existing variable.
- Copying a **widget** copies its triggers with it; copying a **step** copies
  that step's enter/exit/timer/machine-and-device triggers with it.
- The restriction is on the paste target: a trigger can only be pasted onto the
  **same kind of object** it was copied from — button triggers onto buttons.
  There is no supported way to move a trigger between object types; the closest
  thing to a workaround is rebuilding the trigger by hand.

## What "same kind of object" is protecting

A trigger is `When` / `If` / `Then`. The `If` (conditions) and `Then` (actions
and transitions) are owner-agnostic — that is exactly why builders want to move
them. The `When` is not:

| Owner                    | `When`                                                     |
| ------------------------ | ---------------------------------------------------------- |
| Button                   | button pressed                                              |
| Input widgets            | the input's value changes                                   |
| Interactive table        | a row is selected (and loads the linked record placeholder) |
| Custom widget            | events **declared by that widget's own code**, with payloads |
| Step                     | on step enter / on step exit / timer / machine and device   |
| App                      | app started / app completed / …                             |

So a copied trigger carries an event binding that may name something the new
owner cannot fire (a custom widget's `onScanComplete` means nothing to a
button), and its actions may reference owner-scoped context that only exists
under the old owner. Tulip's guard exists so a trigger can never end up with a
`When` that its owner cannot produce.

That is a real constraint, and the toggle should not pretend otherwise: the
goal is to let the paste **happen** and land the user in the trigger editor
with the logic intact, leaving any `When` that could not be carried over — and
any action that referenced the old owner — visible and unset for them to fix
before saving. A trigger that pastes cleanly and one that pastes with a hole in
it should both be better than retyping fifteen actions.

## Where the guard can live

Three possibilities, and which one is true decides the whole implementation.
The probe distinguishes them in a single copy/paste round.

**H1 — the payload carries an owner discriminator, checked at paste.** Copy
serializes the trigger (probably JSON) with something like an owner kind /
widget type / event name; the Ctrl+V handler reads the clipboard, compares that
against the current selection, and bails when they disagree. _Signature in the
probe:_ a `clipboard.readText:resolved` (or a `paste` event with the payload)
fires on the refused paste too, and nothing happens afterwards.

**H2 — the copy never reaches a shared clipboard.** The trigger is held in an
in-memory or `localStorage` clipboard keyed by owner type, and the paste
handler only looks in the slot matching the current selection. _Signature:_ a
`storage.setItem` on copy, or no clipboard traffic at all on copy, plus no read
of the payload on the refused paste.

**H3 — the guard is downstream of the editor.** The payload is accepted and the
editor opens, but attaching on Save is rejected (client- or server-side).
_Signature:_ the paste reads the payload and the editor opens, and the refusal
only appears on Save.

H1 is the most likely (it matches the observed "nothing at all happens" and the
documented cross-app paste, which requires a serialized payload), and it is the
one Tulbelt can fix most cleanly. H3 would be the worst case: if the server
validates the owner/event pair, a browser extension cannot honestly work around
it, and the toggle should not ship.

## Interception layers available

Ranked by preference, with the precedent already in this repo:

1. **Rewrite the payload as Tulip reads it** (MAIN world). Wrap
   `navigator.clipboard.readText`/`read`, or intercept the `paste` event in the
   capture phase and re-dispatch a synthetic one carrying a patched
   `DataTransfer`. Smallest surface: Tulip's own paste code path runs unchanged,
   it just sees a payload that says the trigger belongs to the target. Nothing
   persists, so disabling reverts by simply passing payloads through untouched.
2. **React fibers** (MAIN world) — `filters-builder-main.js` and
   `expression-editor-fuzzy-main.js` show the pattern: find the owning component
   by climbing from a DOM node and call its props directly. This is the fallback
   for H2, where the clipboard is not the channel and the paste handler's state
   has to be reached in the page.
3. **Driving Tulip's own controls** (isolated world) — the
   `snap-to-grid` / `option-sets-trigger` pattern: write through the real inputs
   with native setters and bubbled events so Tulip's commit handlers run. Useful
   for filling in a `When` the payload could not carry, not for the paste itself.
4. **Patching the save API** (MAIN world fetch/XHR, as in
   `app-list-date-columns-main.js`) — **out of scope.** Forging what the editor
   sends on Save would write app definitions Tulip's UI never produced. If H3
   turns out to be true, the answer is "this can't be done safely", not this.

## Rewrite strategies

Assuming H1, two shapes of fix, to be chosen once the payload is known:

**A — discriminator patch.** Parse the payload, replace only the owner-identity
fields (owner kind, widget id/type, and the event name where an equivalent
exists on the target), leave conditions and actions untouched. Minimal, and it
keeps whatever Tulip's version of the payload contains that we don't understand.

**B — envelope swap.** Keep only `name`, conditions and actions from the copied
trigger and rebuild the envelope in the shape the target's own copy payload
uses. Needed if step/app/widget triggers turn out to be structurally different
records rather than the same record with a different owner field. Requires a
reference envelope per owner kind, which the probe collects by copying one
trigger of each kind.

**Event mapping.** Where the target has an obvious single event (button →
pressed, input → value changed, interactive table → row selected), map to it.
Where it doesn't (custom widgets, which declare their own), leave the `When`
empty rather than guessing, so the editor shows it as a choice the user has to
make. The paste is a draft in an editor, not a commit — an unset `When` is a
prompt, not a corruption.

## Toggle sketch

```js
{
  id: 'paste-trigger-anywhere',
  name: 'Paste Trigger Anywhere',
  description:
    'In the app editor, allow a copied trigger to be pasted onto any widget, step, or app event — not just the same kind of object it was copied from. The trigger editor opens pre-filled as usual; the event ("When") is remapped where the target has an equivalent and left unset where it does not, and nothing is saved until you press Save.',
  defaultEnabled: false,
  major: true,
}
```

Two halves, following `filters-builder` / `app-list-date-columns`:

- `toggles/paste-trigger-anywhere.js` (isolated, default array) — the toggle
  lifecycle via `registerToggle`, the app-version-editor path check (the
  `EDITOR_PATH` regex from `snap-to-grid.js`), and it sets/clears
  `<html data-tulbelt-pta-enabled>`.
- `toggles/paste-trigger-anywhere-main.js` (MAIN world, `document_start` — the
  wrapper must be installed before Tulip captures its own clipboard reference)
  — wraps the clipboard read, and rewrites a payload only when **all** of:
  the `<html>` flag is set, the payload parses, it looks like a Tulip trigger
  (positively identified, not "is JSON"), and its owner differs from the current
  paste target. Any other payload passes through byte-identical, so ordinary
  copy/paste in the editor is untouched.

Revert: clearing the flag makes the wrapper a pass-through on the very next
read. The wrapper itself stays installed for the life of the page — Tulip may
hold a reference to the wrapped function, so unwrapping is the riskier option.
Nothing is written to the DOM or to storage, so there is nothing else to undo.

Debug logging goes through `window.__tulbelt?.log?.('paste-trigger-anywhere', …)`
from the isolated half and the `tulbelt:devlog` CustomEvent bridge from the MAIN
half (see [devtools.md](./devtools.md)).

## Risks and honest limits

- **Actions that referenced the old owner.** Moving a custom widget trigger to a
  button can leave actions pointing at an event payload that no longer exists.
  They will surface in the editor; the toggle must never quietly drop or rewrite
  them.
- **Server-side validation** (H3) can refuse the Save regardless. The toggle
  cannot and should not try to get around that.
- **Snapshot first.** The toggle is off by default and its description should
  say plainly that it produces trigger records Tulip's UI would not otherwise
  create.
- **Version fragility.** The payload shape is Tulip's private format; a Tulip
  release can change it. The rewrite must fail closed — if the payload doesn't
  match what we expect, pass it through untouched and let Tulip refuse the paste
  exactly as it does today.

## Open questions

The probe answers these in one session:

1. Does a trigger copy reach the **system clipboard**? (Copy a trigger, paste it
   into a text editor — if JSON appears, H1 is confirmed on the spot.)
2. Is the payload read via `navigator.clipboard.readText`, a `paste` event, or
   neither?
3. What is the payload's shape — which fields identify the owner, the widget
   type, and the event?
4. Do step, app and widget triggers serialize as the same record with a
   different owner field, or as different records? (Strategy A vs B.)
5. On a **refused** paste, is the payload read at all? (H1 vs H2/H3.)
6. Is there a console warning or an error on refusal?
7. Do two different custom widget types produce payloads that differ only by a
   widget-type id?
8. How does the editor identify the current paste target in the DOM, so the
   rewrite can name it? (Selected-widget testids captured on the Ctrl+V keydown.)

## Running the probe

1. Open an app in the app editor with at least one trigger to copy.
2. Open DevTools → **Console**, leaving the context dropdown on **top** (the
   page's own context — _not_ the Tulbelt context this time; the probe has to
   see Tulip's `navigator.clipboard`).
3. Paste the whole of
   [`probes/trigger-clipboard-probe.js`](./probes/trigger-clipboard-probe.js)
   and press Enter. It prints `[tpa] armed`.
4. Reproduce, calling `__tpaNote('...')` between steps to label them:
   - copy a button trigger, then paste it onto **another button** (the case that
     works today);
   - paste the same trigger onto an **interactive table** (refused today);
   - copy an **On step enter** trigger, paste it onto a **button** (refused);
   - if custom widgets are in play, copy a trigger from one custom widget type
     and paste it onto a different one (refused).
5. Also copy one trigger of each kind you care about (button, step, app, custom
   widget) so the report carries a reference payload for each.
6. Run `copy(__tpaReport())` and paste the JSON into the chat. `__tpaStop()`
   removes the probe; reloading the tab also clears it.

The report replaces the instance hostname with `your-instance.tulip.co`, but a
tenant name appearing as plain text inside a captured payload is **not**
detected — the [devtools.md](./devtools.md) rule applies: chat or gitignored
local notes only, never a tracked file.

## Sources

- [Copy and paste app elements — Tulip Knowledge Base](https://support.tulip.co/docs/copy-and-paste-app-elements)
- [Widget Triggers](https://support.tulip.co/docs/widget-triggers) ·
  [Step level triggers](https://support.tulip.co/docs/step-level-triggers) ·
  [App Level Triggers](https://support.tulip.co/docs/app-level-triggers)
- [Triggers](https://support.tulip.co/docs/triggers) ·
  [Interactive table widgets](https://support.tulip.co/docs/interactive-table-widgets) ·
  [Custom Widgets](https://support.tulip.co/docs/custom-widgets)
- [Keyboard shortcuts in the app editor and player](https://support.tulip.co/docs/how-to-use-keyboard-shortcuts-in-the-app-editor-and-player)
- Community requests for exactly this:
  [Copy triggers from step enter event to widget event](https://community.tulip.co/t/copy-triggers-from-step-enter-event-to-widget-event/3101),
  [Copy button triggers to step trigger…](https://community.tulip.co/t/copy-button-triggers-to-step-trigger-app-started-triggers-device-machine-triggers-etc/5273),
  [Copying triggers between editor tabs](https://community.tulip.co/t/copying-triggers-between-editor-tabs/16331)
