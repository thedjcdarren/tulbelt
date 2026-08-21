# Follow-up browser tasks — two paste bugs

For an agent driving real Chrome against a real Tulip instance. Two bugs found
using the shipped toggle. They share a setup, so do them in one session.

Background: [paste-trigger-anywhere.md](./paste-trigger-anywhere.md).
Repo: `thedjcdarren/tulbelt`, branch `claude/magical-mayer-ub5m6z`.

## Ground rules

- **Scratch app version only.** A paste creates a real trigger on the server the
  moment it happens — there is no save to confirm it. Every attempt below leaves
  a record behind; delete them or expect to.
- **No instance data in the repo.** Hostnames and Tulip ids (app, step, widget,
  trigger, custom widget, user) go in chat, never in a tracked file.
- **Report refusals, don't route around them.** If something is rejected, say
  what it said. A refusal we understand beats a pass we don't.
- Say which build you tested — `git rev-parse --short HEAD` of the loaded
  extension folder. Bug 1's fix is recent and testing a stale build wastes the
  round.

## Setup

1. Load the extension unpacked from the branch (`chrome://extensions` →
   Developer mode → Load unpacked → repo folder). **Reload the extension AND the
   Tulip tab** after any pull.
2. Tulbelt popup → click the **Tulbelt** title five times (subtitle gains
   "· developer") → enable **Paste Trigger Anywhere**.
3. Open a scratch app version. A paste icon should appear beside every trigger
   list heading, and beside the "Triggers" heading in a single-event widget's
   panel.
4. In the page console (context **top**, not Tulbelt): `window.__ptaDebug = true`.
   That makes the toggle print what each click resolved and sent.

You will need a widget with **two or more trigger sections** — a text input has
"On enter press" and "On input exit" — and, for bug 2, a custom widget too.

---

## Bug 1 — a multi-section widget pastes into the wrong section

**Reported:** clicking the paste icon beside "On input exit" put the trigger in
"On enter press".

**Suspected cause:** the section's own event type is what separates two sections
on one widget. It is confirmed present in React props for a *custom* widget
(`props.group.types[0]`) but was never confirmed for a *built-in* one. Where it
is missing, the code fell back to a generic widget event and Tulip re-derived
that into the component's default event — the first section. A fallback that
reads Tulip's own label for the section has been added; this is to confirm it
fires and that the type survives.

**There is a second possible cause** that the fix would not touch: Tulip's paste
path re-derives `event.type` itself when the source event doesn't suit the
destination. If it overrides ours regardless, the label fix changes nothing and
the real lever is elsewhere. The debug output tells these apart.

Steps:

1. Copy any trigger (a button trigger is fine).
2. Select a text input so its panel shows both sections.
3. Click the paste icon beside **On input exit**.
4. Capture the `[tulbelt:pta]` console lines — they show the section props read,
   the destination resolved, and the exact `event` sent.
5. Note which section the new trigger actually landed in, and what the editor's
   **When** shows.
6. Repeat with the icon beside **On enter press** — that one is expected to work
   either way, and is the control.

Report per attempt: the debug lines, the section it landed in, the When shown.

- Sent `input-exit` and landed in On input exit → **fixed**.
- Sent `input-exit` but landed in On enter press → **Tulip overrides the type**;
  the `group prop` line in the debug output is the next lead, so include it in
  full.
- Sent `button-press` → the label fallback didn't fire; include the `section
  props` line.

---

## Bug 2 — the When dropdown offers events from other surfaces

**Reported:** after a paste, the trigger editor's **When** dropdown is populated
with entries belonging to other trigger locations that don't apply where the
trigger landed.

**Suspected cause:** `event.id` names an event *slot*, and a rewritten payload
carries the **source's** slot id — the toggle deliberately leaves it alone,
because the server accepts it and re-IDs the trigger itself. The editor may
populate its When list from that id, in which case it is listing the source
surface's events.

### 2a. Is it ours at all? (do this first)

The control matters more than the experiments: **does a native Tulip paste show
the same thing?**

1. Copy a widget trigger, select a *different* widget of the same kind, press
   Ctrl/Cmd+V — Tulip's own path, no Tulbelt involvement.
2. When the editor opens, screenshot the When dropdown **open**.
3. Do the same for a native step-trigger paste (copy an On step enter trigger,
   Ctrl+V with the step open).

If the native paste shows the same extra entries, this is Tulip's own behaviour
and the toggle is not causing it — say so and stop; the rest is unnecessary.

### 2b. Which id drives the list?

Only if 2a shows native pastes are clean. Use
[`probes/paste-rewrite-test.js`](./probes/paste-rewrite-test.js) (paste it in
the page console) — its `tryAs` now takes an `eventId`:

```js
__pasteTest.arm()                       // click copy on a step trigger
// then, with the target widget selected:
await __pasteTest.tryAs('button-press', { widgetId: '<target>' })                        // A: source's slot id (current behaviour)
await __pasteTest.tryAs('button-press', { widgetId: '<target>', eventId: 'random' })     // B: a fresh id
await __pasteTest.tryAs('button-press', { widgetId: '<target>', eventId: '<dest slot>' })// C: the destination's own slot id
```

For **C**, get `<dest slot>` by copying a trigger that already lives in the
destination section and reading `event.id` from `__pasteTest.show()`.

After each, open the created trigger and screenshot the **When** dropdown open.
Report which of A / B / C produce a clean list, and whether each trigger still
saves and works.

`event.id` cannot simply be omitted — Tulip's codec requires the key — so those
three are the whole space.

### 2c. Does it matter?

Whichever id is used, check once whether the pollution is cosmetic or real:

1. Leave the pasted trigger's When as the editor set it, save, and run the app.
   **Does it fire on the right event?** (Bad entries in a dropdown you don't
   touch may be harmless.)
2. Pick one of the foreign entries, save, and see whether Tulip accepts it or
   errors. Don't keep that trigger.

---

## Reporting back

For each bug: what you did, what happened, the exact console lines and the error
text of anything refused. Screenshots of the open When dropdown are the evidence
for bug 2 — the description "artifacts from other trigger locations" needs to
become a list of specific entries.

Then say plainly for each: fixed, still broken, or not ours.
