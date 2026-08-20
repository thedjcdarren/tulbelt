# Paste Trigger Anywhere — research notes and design

Working notes for a planned toggle that lets a copied trigger be pasted onto an
owner Tulip currently refuses.

Status: **research.** A probe run on a live instance settled how the copy/paste
path works, where the guard sits, and what the clipboard payload contains — see
[Confirmed by probe](#confirmed-by-probe). What is missing is the event-type
vocabulary the rewrite has to write into; the remaining
[open questions](#open-questions) are all about that.

## The actual gap

**Component-to-component already works.** A trigger copied from a button pastes
onto an input field or an interactive table today, even though those are
different widget types. So widget triggers are _not_ what needs fixing, and the
guard is not per-widget-type.

What is refused is crossing between the trigger **surfaces**:

| Surface           | Events                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| App level         | App started · App completed · App cancelled                                    |
| Step level        | On step enter · On step exit · Timers · Machines & devices                     |
| Component (widget) | button press, input change, table row select, … — interchangeable already      |
| Custom widget     | events **declared by that widget's own code** — not interchangeable, even between two custom widgets |

The wanted moves are: any app-level event ↔ any other app-level event, app ↔
step, step ↔ step, either of those ↔ a component, and one custom widget type →
a different custom widget type.

**Paste needs somewhere to land.** Today paste is Ctrl/Cmd+V against the
_selected widget_ — which is why component-to-component works at all. App-level
and step-level trigger lists have no canvas selection to aim at, so there is
nothing to press Ctrl+V "on". The feature therefore needs an explicit **Paste
trigger** affordance in each of those trigger lists (App started, App completed,
App cancelled, On step enter, On step exit, Timers, Machines & devices, and each
custom widget event section) so the destination is picked by pointing at it. The
button is not decoration — it is how the target is named.

## What the surface split is protecting

A trigger is `When` / `If` / `Then`. The `If` (conditions) and `Then` (actions
and transitions) are owner-agnostic — that is exactly why builders want to move
them. The `When` is bound to its surface: a step's `on step enter` means nothing
to an app-level list, and a custom widget's declared event means nothing to a
different custom widget. Tulip's guard exists so a trigger can never end up with
a `When` its owner cannot produce.

That is a real constraint, and the toggle should not pretend otherwise: the
goal is to let the paste **happen** and land the user in the trigger editor
with the logic intact, leaving any `When` that could not be carried over — and
any action that referenced the old owner — visible and unset for them to fix
before saving. A trigger that pastes cleanly and one that pastes with a hole in
it should both be better than retyping fifteen actions.

## Confirmed by probe

One session on a live instance, copying a button trigger and pasting it onto
several targets — some accepted, one refused:

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
[Copy/Paste]: Pasting trigger in app editor
    { sourceAppId, sourceStepId, targetAppId, targetStepId }
[Copy/Paste]: Pasting trigger, opening trigger editor
    { oldAppVersionId, oldTriggerId, newAppVersionId, newTriggerId }
```

Both context objects are worth reading closely:

- **The destination comes from editor state, not the payload.** Tulip has a
  `targetStepId` before it has decided anything, and there is no widget id in
  that context at all — source or target. So the handler locates where the user
  is (app + step) and takes the widget from canvas selection separately. That is
  precisely what the injected paste buttons have to supply for surfaces where
  there is no selection to read.
- **The trigger is re-IDed on paste** — `newTriggerId` differs from
  `oldTriggerId`. So the payload's `id`, and presumably `versionSetId` /
  `importFamilyId` / `created` / `lastModified`, are Tulip's to regenerate. The
  rewrite should leave all of them alone and touch only the binding.

Every paste in the run logged the first line — **including the refused one**,
which proves the payload is read and parsed before the compatibility check.
Only the refused paste never logged the second. (Its Ctrl+V also differed in
one visible way: the editor had a different set of context-pane testids on
screen, consistent with a different surface being open rather than a canvas
widget being selected.) Nothing was written to `localStorage` (the only writes
were `tulip-last-activity` and feature-flag chatter), no `readText`/`read` call
was made, and no warning or error was logged on refusal — it fails silently.

### The payload

It rides on the **`text/html`** flavor of the clipboard, not `text/plain`: a
single empty `<span>` whose `data-tulip-clipboard` attribute holds base64 of a
JSON envelope. (So a trigger copied to a text editor looks like nothing at all —
there is no visible text.)

```
<meta charset='utf-8'><html><head></head><body>
  <span data-tulip-clipboard="<base64 of the JSON below>"></span>
</body></html>
```

Decoded, with values replaced by their kind:

```jsonc
{
  "isTulipAppClipboardContent": true,   // positive identification — match on this
  "clipboardType": "Trigger",           // widgets and steps presumably use other values
  "sourceStepId": "<stepId>",
  "sourceAppVersionId": "<appVersionId>",
  "sourceAppId": "<appId>",
  "sourceCustomer": "<instance hostname>",
  "sourceWorkspaceId": "<workspaceId>",
  "trigger": {
    "id": "<triggerId>",
    "name": "Example Trig",
    "versionSetId": "<id>",
    "importFamilyId": "<id>",
    "appVersionId": "<appVersionId>",
    "stepId": "<stepId>",              // owning step
    "widgetId": "<widgetId>",          // owning widget — absent for step/app triggers?
    "disabled": false,
    "workspaces": { "scope": "specific", "workspaceIds": ["<workspaceId>"] },
    "created": { "at": "<iso>", "by": { "type": "user", "id": "<userId>" } },
    "lastModified": { "at": "<iso>", "by": { "type": "user", "id": "<userId>" } },
    "clauses": [                       // the If / Then — owner-agnostic
      {
        "id": "<id>",
        "type": "and",
        "conditions": [],
        "actions": [
          {
            "id": "<id>",
            "type": "show-message",
            "inputs": [ { "datasourceType": "static", "schema": { "type": "string" },
                          "permissions": { "isReadable": true, "isWritable": false },
                          "params": { "value": "Hi" } } ],
            "isTransition": false
          }
        ]
      }
    ],
    "event": { "id": "<id>", "type": "button-press" }   // ← the owner binding
  },
  "queryIds": [],                      // dependencies carried along with the trigger
  "variables": [],
  "recordPlaceholders": []
}
```

Three things follow immediately.

**The owner binding is `trigger.event`, plus `stepId` / `widgetId`.** The
payload carries no widget _type_ field at all — only ids, and ids cannot be
resolved when pasting into a different app (a documented, working case). So the
paste handler has nothing to route on but `event.type` and which of
`stepId`/`widgetId` are set.

**Tulip already rewrites the binding on a widget paste.** A `button-press`
trigger lands happily on an interactive table, which does not fire
`button-press` — so the existing paste path re-homes both the ids and the event
to whatever the selected widget is. That is encouraging: the machinery to
re-bind a trigger exists in Tulip's own code and works. The refusal is about
which surfaces the paste path is willing to route _between_, not about the
trigger record being unportable.

**`clauses` is the part worth moving, and it is already owner-agnostic** —
conditions and actions, with no back-reference to the widget. Which is why a
rewrite is plausible at all: change the binding, keep the clauses.

### Which hypothesis was right

Of the three shapes this could have taken, the first is what Tulip does:

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

Assuming H1, two shapes of fix, to be chosen once the event vocabulary is known:

**A — discriminator patch.** Parse the payload, replace only `trigger.event`
and the owner ids (`stepId`, `widgetId` — set for a widget target, cleared for a
step or app target), leave `clauses` untouched. Minimal, and it keeps whatever
else Tulip's version of the payload contains that we don't understand. This is
the expected shape of the fix.

**B — envelope swap.** Keep only `name`, conditions and actions from the copied
trigger and rebuild the envelope in the shape the target surface's own copy
payload uses. Needed if step/app/widget triggers turn out to be structurally
different records rather than the same record with different owner fields —
which is exactly what collecting one payload per surface will show.

**The mapping is the target's, not the source's.** Because the destination is
picked by clicking a specific **Paste trigger** button (see below), the target
event is never in doubt: the button in the "On step exit" list means
`event.type` = whatever step-exit is called, the one in a custom widget's
"On scan" section means that widget's declared event id. There is no guessing
and no "leave the When unset" fallback — the affordance carries the answer.
That is the second reason the buttons are load-bearing rather than cosmetic.

## Toggle sketch

```js
{
  id: 'paste-trigger-anywhere',
  name: 'Paste Trigger Anywhere',
  description:
    'In the app editor, add a "Paste trigger" button to every trigger list — App started/completed/cancelled, On step enter/exit, Timers, Machines & devices, and each custom widget event — so a copied trigger can be pasted across those surfaces instead of only onto a selected component. The trigger editor opens pre-filled as usual with the event set to the list you pasted into, and nothing is saved until you press Save.',
  defaultEnabled: false,
  major: true,
}
```

Three parts, following `filters-builder` / `app-list-date-columns`:

- `toggles/paste-trigger-anywhere.js` (isolated, default array) — the toggle
  lifecycle via `registerToggle`, the app-version-editor path check (the
  `EDITOR_PATH` regex from `snap-to-grid.js`), and it sets/clears
  `<html data-tulbelt-pta-enabled>`.
- **The paste buttons** (same isolated script) — one injected per trigger list
  section, in the `option-sets-trigger` / `collapse-tables-tile` style: find the
  section, clone Tulip's own button so it looks native, mark it with a
  `data-tulbelt-pta-*` attribute, and remove every one of them on disable.
  Each button knows the `event` its section represents. On click it reads the
  clipboard, rewrites the payload for that event, and hands it to Tulip's paste
  path — the click is a user gesture, so `navigator.clipboard.read()` is
  allowed.
- `toggles/paste-trigger-anywhere-main.js` (MAIN world, `document_start`) —
  gets the rewritten payload into Tulip's paste path. Two routes, and the bundle
  grep decides which:

  1. **Synthesize the paste.** Because our button owns the gesture, it can build
     a `DataTransfer` holding the rewritten `text/html` and dispatch a
     `ClipboardEvent('paste')` at whatever element Tulip listens on. No patching
     at all, and nothing to revert. Risk: the event is untrusted, and Tulip may
     still take its destination from editor selection state rather than from the
     payload — in which case the button alone can't aim it.
  2. **Wrap `DataTransfer.prototype.getData`.** Rewrite the string as Tulip's
     handler reads it, keeping Tulip's own trusted event. Rewrite only when
     **all** of: the `<html>` flag is set, the string carries a
     `data-tulip-clipboard` attribute, the base64 decodes to JSON with
     `isTulipAppClipboardContent === true` and `clipboardType === "Trigger"`, and
     a Tulbelt paste is in flight. Every other read — every ordinary text paste
     in the editor — returns the original string byte-identical.

  Route 1 is cleaner if Tulip's handler is payload-driven; route 2 is the
  fallback, and the two compose (synthesize the event, serve the payload through
  the wrapper) if the handler insists on a trusted event's own `clipboardData`.

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

Answered so far: the clipboard is the channel (`navigator.clipboard.write`), the
read is a trusted `paste` event on the `text/html` flavor, the payload _is_ read
on a refused paste, refusal is silent, and the owner binding in the payload is
`trigger.event.type`.

Still open:

1. **The event vocabulary per surface.** `button-press` is the only value seen.
   What is in `event` for App started / completed / cancelled, On step enter,
   On step exit, Timers, Machines & devices, and a custom widget's declared
   event? Without these the buttons have nothing to write. (One decode per
   surface, or the bundle grep.)
2. **How the surfaces differ structurally.** Does a step trigger serialize as
   the same record with `widgetId` absent, an app trigger with neither
   `stepId` nor `widgetId`? Or are they different records? (Strategy A vs B.)
3. **What routes the paste.** Does Tulip's handler decide the destination from
   the payload, or from editor selection state? This decides whether the
   injected buttons can drive Tulip's own paste path (route 1) or need the
   `getData` wrapper (route 2).
4. **What the guard actually refuses.** With component→component working, the
   predicate is about surfaces, not widget types — the grep should show it
   literally.
5. Do two different custom widget types differ only by the widget-declared
   `event.id`, or does the payload name the widget type somewhere?
6. **Where the buttons go.** The DOM of each trigger list section: App
   started/completed/cancelled, the four step lists, and a custom widget's event
   sections — enough of a selector to inject one button per section and to read
   which section it is.
7. Does **Save** accept a cross-surface trigger once the editor opens, or is
   there a second gate server-side? (The one question that can end this feature.)

## Running the probe

1. Open an app in the app editor with at least one trigger to copy.
2. Open DevTools → **Console**, leaving the context dropdown on **top** (the
   page's own context — _not_ the Tulbelt context this time; the probe has to
   see Tulip's `navigator.clipboard`).
3. Paste the whole of
   [`probes/trigger-clipboard-probe.js`](./probes/trigger-clipboard-probe.js)
   and press Enter. It prints `[tpa] armed`.
4. Reproduce, calling `__tpaNote('...')` between steps to label them:
   - copy a button trigger, paste it onto an **interactive table or input**
     (the cross-component case that already works — the baseline);
   - copy an **On step enter** trigger and try to paste it onto a button
     (refused);
   - copy a button trigger and try to paste it onto a step or app-level list
     (refused — and worth capturing precisely because there is nothing to aim
     Ctrl+V at, which is the gap the paste buttons fill);
   - if custom widgets are in play, copy a trigger from one custom widget type
     and try to paste it onto a different one (refused).
5. Also copy one trigger from **each surface** — App started, App completed,
   App cancelled, On step enter, On step exit, Timers, Machines & devices, a
   component, a custom widget — so the report carries a reference payload for
   each. These are what fill in the event vocabulary.
6. Run `copy(__tpaDump())` and paste the JSON into the chat — that is the
   copy/paste-relevant subset (payloads, `getData` reads, Tulip's own
   `[Copy/Paste]` lines). `copy(__tpaReport())` gives everything including
   clicks and storage writes, if the dump turns out to be missing something.
   `__tpaStop()` removes the probe; reloading the tab also clears it.

The report replaces the instance hostname with `your-instance.tulip.co`, but a
tenant name appearing as plain text inside a captured payload is **not**
detected — and a trigger payload always carries one, in `sourceCustomer`, plus
app, workspace and user ids. The [devtools.md](./devtools.md) rule applies:
chat or gitignored local notes only, never a tracked file.

### Collecting one payload per surface

With the probe loaded, copy a trigger and then label it:

```js
await __tpaDecode("App started");
```

Repeat for App completed, App cancelled, On step enter, On step exit, Timers,
Machines & devices, a component, and each custom widget. Every decode is filed
into the same report, and together they are the event vocabulary the paste
buttons write into.

Without the probe, the same thing by hand:

```js
const html = await (await navigator.clipboard.read())
  .flatMap((i) => (i.types.includes("text/html") ? [i] : []))[0]
  .getType("text/html")
  .then((b) => b.text());
JSON.parse(atob(html.match(/data-tulip-clipboard="([^"]+)"/)[1]));
```

### Finding where the paste buttons go

With a trigger list open in the context pane, `__tpaPane('step triggers')`
prints its structure (tags, testids, first class, own text) and files it in the
report. One per surface — app-level list, step-level list, a custom widget's
event sections — is enough to work out the injection point and how a section
identifies itself.

### Grepping Tulip's bundles

[`probes/bundle-grep.js`](./probes/bundle-grep.js) re-fetches the editor
bundles the tab already has and prints the code around the clipboard strings
(`isTulipAppClipboardContent`, `data-tulip-clipboard`, the `[Copy/Paste]` log
line, `button-press`). Paste it, run `await __grep()`, then `copy(__grepJson)`.
That should show the paste handler itself: the event-type enum, whether the
target's step/widget id is taken from the selection, and the predicate that
refuses the paste.

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
