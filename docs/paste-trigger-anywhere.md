# Paste Trigger Anywhere — research notes and design

Working notes for a planned toggle that lets a copied trigger be pasted onto an
owner Tulip currently refuses: a button trigger onto an interactive table, an
"On step enter" trigger onto a button, a trigger from one custom widget type
onto another.

Status: **research.** A probe run on a live instance (Tulip's app editor, app
version editor page) settled how the copy/paste path works and where the guard
sits — see [Confirmed by probe](#confirmed-by-probe). What is still missing is
the payload's own shape; the remaining [open questions](#open-questions) all
depend on it.

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

## Confirmed by probe

One session on a live instance, copying a trigger and pasting it onto both a
compatible and an incompatible target:

**Copy goes to the real system clipboard**, via
`navigator.clipboard.write()` — a `ClipboardItem`, not `writeText`. It fires
from a click on the trigger row's copy button, inside the user gesture. So the
payload is serialized and shared: this is why paste works across apps, and it
is a payload Tulbelt can see and rewrite.

**Paste is a trusted `paste` event**, not a clipboard read. At capture phase
the event arrives with `defaultPrevented: false`; Tulip's own handler runs; by
the time it bubbles back to `window` it is `defaultPrevented: true`. Tulip
reads the payload out of `event.clipboardData` in between.

**The guard is client-side, between reading the payload and opening the
editor.** Tulip's own clientLogger brackets the paste with two lines:

```
[Copy/Paste]: Pasting trigger in app editor      { sourceAppId, targetAppId, … }
[Copy/Paste]: Pasting trigger, opening trigger editor { oldAppVersionId, oldTriggerId, … }
```

Every paste in the run logged the first line — including the refused one, which
proves the payload is read and parsed before the compatibility check. Only the
refused paste never logged the second. Nothing was written to `localStorage`
(the only writes were `tulip-last-activity` and feature-flag chatter), no
`readText`/`read` call was made, and no warning or error was logged on refusal —
it fails silently.

So of the three shapes this could have taken, the first is what Tulip does:

| Hypothesis                                                | Verdict                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| **H1** payload carries an owner discriminator, checked at paste | **Confirmed** — payload read every time, guard right after |
| **H2** copy never reaches a shared clipboard (in-memory / localStorage slot) | Ruled out — `clipboard.write()`, no storage writes |
| **H3** guard is downstream, at Save                        | Not reached — the editor never opens, so the gate is upstream of it |

H3 is not fully excluded as a _second_ gate: the editor opening does not prove
Save will accept a cross-type trigger. That is the first thing to test once a
rewrite works, and if the server refuses, the toggle should not ship.

## Interception layers available

Ranked by preference, with the precedent already in this repo:

1. **Rewrite the payload as Tulip reads it** (MAIN world) — now that paste is
   known to be a trusted `paste` event, the hook is
   `DataTransfer.prototype.getData`. Wrap it; when Tulip's handler asks the
   pasted `DataTransfer` for its payload during a paste in the app editor,
   return a rewritten string instead. Tulip's own trusted event and its own
   code path run unchanged — it simply reads a payload that says the trigger
   belongs to the target. Nothing persists, so disabling reverts by passing
   payloads straight through.

   This is why the wrapper beats the two obvious alternatives: the event's
   `clipboardData` is read-only, so it cannot be edited in place, and
   re-dispatching a synthetic `ClipboardEvent` would hand Tulip an untrusted
   event and a re-entrancy problem. Rewriting the getter sidesteps both.
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
  wrapper must be installed before Tulip's paste handler can run) — wraps
  `DataTransfer.prototype.getData` and rewrites the returned payload only when
  **all** of: the `<html>` flag is set, a paste is in flight, the payload parses,
  it is positively identified as a Tulip trigger (not merely "is JSON"), and its
  owner differs from the paste target. Every other read passes through
  byte-identical, so pasting text into any field in the editor is untouched.

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

Answered by the first probe run: the clipboard is the channel
(`navigator.clipboard.write`), the read is a trusted `paste` event, the payload
_is_ read on a refused paste, and refusal is silent. Still open, all of them
about the payload itself:

1. Which MIME type does the `ClipboardItem` carry — `text/plain`, or a custom
   type? (Decides what the `getData` wrapper matches on.)
2. What is the payload's shape — which fields identify the owner, the widget
   type, and the event?
3. Do step, app and widget triggers serialize as the same record with a
   different owner field, or as different records? (Strategy A vs B.)
4. Do two different custom widget types produce payloads that differ only by a
   widget-type id?
5. Can the rewrite name the target? The paste target has to be identified from
   the payload's own vocabulary — the probe's Ctrl+V capture found no
   `.selected` widget node, so the DOM selector for "what is selected" still
   needs finding, or the target has to be inferred another way (e.g. Tulip's
   `[Copy/Paste]` log context, which already knows `targetAppId`).
6. Does **Save** accept a cross-type trigger once the editor opens, or is there
   a second gate server-side? (The one question that can end this feature.)

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
6. Run `copy(__tpaDump())` and paste the JSON into the chat — that is the
   copy/paste-relevant subset (payloads, `getData` reads, Tulip's own
   `[Copy/Paste]` lines). `copy(__tpaReport())` gives everything including
   clicks and storage writes, if the dump turns out to be missing something.
   `__tpaStop()` removes the probe; reloading the tab also clears it.

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
