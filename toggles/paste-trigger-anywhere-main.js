// Main-world half of paste-trigger-anywhere. Lives in `world: "MAIN"` at
// document_start because everything it needs is the page's own: the clipboard
// payload Tulip writes, and the paste event Tulip listens for.
//
// How a trigger copy travels: Tulip serializes the trigger to JSON, base64s it
// into `<span data-tulip-clipboard="…"></span>` and writes that as the
// clipboard's text/html flavor. On paste it parses that span back out and
// branches on the trigger's own binding:
//
//     no stepId, no widgetId  -> app level      (target: Process)
//     stepId, no widgetId     -> current step   (target: Step)
//     widgetId                -> selected widget (target: Widget)
//
// …then POSTs it to the paste API, which CREATES THE TRIGGER SERVER-SIDE and
// returns its new id; the editor opens on that. There is no Save to confirm.
//
// So moving a trigger between surfaces means rewriting that binding before
// Tulip reads it. Three fields move together, and the exact shape matters —
// Tulip validates the payload against its own codec before any request:
//
//   * `event`        — type (and eventName/customWidgetId/args where the type
//                      carries them)
//   * `stepId` / `widgetId` — ABSENT, not null. A null fails the codec.
//   * `haltOnError`  — app- and step-class records carry `true`; widget-class
//                      records do not carry the key at all.
//
// Everything else — every id, the clauses, and the whole envelope
// (sourceCustomer, workspace, queryIds, variables, recordPlaceholders) — is
// passed through exactly as copied. The stale `event.id` is fine: it names the
// source's event slot and the server does not mind.
//
// Verified against a live instance: all nine cross-surface combinations
// returned 201, appeared in their destination lists, kept their actions, and
// survived a hard reload. See docs/paste-trigger-anywhere.md.

(() => {
  const ENABLED_ATTR = "data-tulbelt-pta-enabled";
  const BUTTON_ATTR = "data-tulbelt-pta-paste";
  const STEP_ATTR = "data-tulbelt-pta-step";
  const RESULT_EVENT = "tulbelt:pta-result";
  const CLIP_ATTR = "data-tulip-clipboard";

  const EVENT_CLASS = {
    "app-start": "app",
    "app-complete": "app",
    "app-cancel": "app",
    "step-open": "step",
    "step-closed": "step",
    interval: "step",
    "device-output": "step",
    "machine-output": "step",
    "button-press": "widget",
    "custom-widget-event": "widget",
    "input-change": "widget",
    "input-exit": "widget",
    "enter-press": "widget",
    "row-select": "widget",
    "signature-complete": "widget",
  };
  const NEEDS_ARGS = { interval: true, "device-output": true };

  function enabled() {
    return document.documentElement.getAttribute(ENABLED_ATTR) === "true";
  }

  // ── the clipboard flavor, encoded exactly as Tulip encodes it ─────────────
  function encode(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return "<span " + CLIP_ATTR + '="' + btoa(binary) + '"></span>';
  }

  function decode(html) {
    const el = new DOMParser()
      .parseFromString(String(html), "text/html")
      .querySelector("[" + CLIP_ATTR + "]");
    if (!el) return null;
    const b64 = el.getAttribute(CLIP_ATTR);
    if (!b64) return null;
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ── remember what Tulip last copied ───────────────────────────────────────
  // Reading the clipboard needs a permission prompt; watching what Tulip hands
  // the clipboard API needs nothing, and it is the same bytes. The async read
  // stays as the fallback for a trigger copied in another tab.
  let lastCopied = null;

  const clipProto = window.Clipboard && window.Clipboard.prototype;
  const originalWrite = clipProto && clipProto.write;
  if (originalWrite) {
    clipProto.write = function (items, ...rest) {
      try {
        if (enabled()) {
          const item = (items || []).find((i) => i && i.types && i.types.includes("text/html"));
          if (item) {
            item
              .getType("text/html")
              .then((blob) => blob.text())
              .then((html) => {
                const payload = decode(html);
                if (payload && payload.trigger) lastCopied = payload;
              })
              .catch(() => {});
          }
        }
      } catch (_) {}
      return originalWrite.call(this, items, ...rest);
    };
    // Left installed for the life of the page: Tulip may hold a reference to
    // the wrapper, and unwrapping under it is riskier than a no-op. When the
    // toggle is off it captures nothing and changes nothing.
  }

  async function readClipboardPayload() {
    if (lastCopied) return lastCopied;
    if (!navigator.clipboard || !navigator.clipboard.read) return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (!item.types.includes("text/html")) continue;
      const html = await (await item.getType("text/html")).text();
      const payload = decode(html);
      if (payload) return payload;
    }
    return null;
  }

  // ── the rewrite ───────────────────────────────────────────────────────────
  function rewrite(payload, type, opts) {
    const klass = EVENT_CLASS[type];
    if (!klass) throw new Error("unknown event type");

    const next = JSON.parse(JSON.stringify(payload));
    const trigger = next.trigger;
    const sourceEvent = trigger.event || {};

    const event = { id: sourceEvent.id, type };
    if (type === "custom-widget-event") {
      if (!opts.eventName || !opts.customWidgetId) throw new Error("missing widget event ids");
      event.eventName = opts.eventName;
      event.customWidgetId = opts.customWidgetId;
    }
    if (NEEDS_ARGS[type]) {
      // A trigger already of this type brings its own configuration; anything
      // else gets a starting value the user adjusts in the editor that opens.
      event.args =
        opts.args ||
        (sourceEvent.type === type && sourceEvent.args) ||
        (type === "interval" ? { interval: 30 } : {});
    }
    trigger.event = event;

    // The binding. `delete`, never null — a null key fails Tulip's codec and
    // the paste is rejected before any request is made.
    if (klass === "app") {
      delete trigger.stepId;
      delete trigger.widgetId;
      trigger.haltOnError = true;
    } else if (klass === "step") {
      trigger.stepId = opts.stepId || trigger.stepId || next.sourceStepId;
      delete trigger.widgetId;
      trigger.haltOnError = true;
    } else {
      trigger.stepId = opts.stepId || trigger.stepId || next.sourceStepId;
      trigger.widgetId = opts.widgetId || trigger.widgetId;
      delete trigger.haltOnError;
    }
    return next;
  }

  // Fail closed: anything we don't positively recognize as a Tulip trigger
  // payload is left alone, and the paste simply doesn't happen. The format is
  // Tulip's private business and a release can change it.
  function usable(payload) {
    return !!(
      payload &&
      payload.isTulipAppClipboardContent === true &&
      payload.clipboardType === "Trigger" &&
      payload.trigger &&
      Array.isArray(payload.trigger.clauses) &&
      payload.trigger.event
    );
  }

  // ── handing it to Tulip ───────────────────────────────────────────────────
  // Tulip's paste handler reads text/html off the event's clipboardData, and
  // does not require a trusted event — so a ClipboardEvent built here enters
  // the dispatcher by the same door a real Ctrl+V does. (The event's own
  // clipboardData is read-only during a real paste, which is why this is a
  // fresh event rather than an edit of one.)
  function dispatchPaste(html) {
    const data = new DataTransfer();
    data.setData("text/html", html);
    const target = document.querySelector("#cssCanvas") || document.body;
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function report(button, ok, error) {
    button.dispatchEvent(
      new CustomEvent(RESULT_EVENT, {
        bubbles: true,
        detail: JSON.stringify({ ok, error: error || null }),
      }),
    );
  }

  async function onClick(e) {
    if (!enabled()) return;
    const button = e.target && e.target.closest && e.target.closest("[" + BUTTON_ATTR + "]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();

    const type = button.getAttribute(BUTTON_ATTR);
    const stepId = button.getAttribute(STEP_ATTR) || null;

    let payload;
    try {
      payload = await readClipboardPayload();
    } catch (_) {
      report(button, false, "Allow clipboard");
      return;
    }
    if (!usable(payload)) {
      report(button, false, "Copy a trigger first");
      return;
    }

    let rewritten;
    try {
      rewritten = rewrite(payload, type, { stepId });
    } catch (_) {
      report(button, false, "Paste failed");
      return;
    }

    const handled = dispatchPaste(encode(rewritten));
    // Tulip owns everything past this point: it creates the trigger through
    // its own API and opens the editor. A refusal surfaces as Tulip's own
    // error toast — we never retry with a different shape.
    report(button, handled, handled ? null : "Tulip ignored the paste");
  }

  document.addEventListener("click", onClick, true);
})();
