// Feasibility test for the Paste Trigger Anywhere toggle
// (docs/paste-trigger-anywhere.md). Paste into the DevTools console of an app
// editor tab, page ("top") context.
//
// THE QUESTION: Tulip's paste dispatcher routes a trigger by its own class —
// app triggers to the app level, step triggers to the current step, widget
// triggers to the selected widget — and the paste itself is a server API call.
// So does rewriting `trigger.event` in the clipboard payload actually get a
// trigger onto a different surface, or does the API refuse it?
//
// WARNING: a successful attempt CREATES A REAL TRIGGER on the server, in the
// app version you have open. Use a scratch app version.
//
// How it works:
//   * hooks Clipboard.write to capture the payload of your next copy click —
//     no clipboard read, so no focus or permission trouble
//   * rewrites `trigger.event` to the class you name and dispatches a paste
//     event carrying it, entering Tulip's dispatcher at the same door a real
//     paste does
//   * watches Tulip's own [Copy/Paste] log lines and the paste API call to see
//     what happened
//
// Usage:
//   __pasteTest.arm()                       // then click a trigger row's copy icon
//   __pasteTest.show()                      // what was captured
//   __pasteTest.tryAs('button-press')       // select a widget first
//   __pasteTest.tryAs('step-open')          // lands in the current step's list
//   __pasteTest.tryAs('app-start')
//   __pasteTest.tryAs('interval', { args: { interval: 30 } })
//   __pasteTest.tryAs('custom-widget-event', { eventName: '…', customWidgetId: '…' })
//   copy(__pasteTest.report())
//   __pasteTest.stop()                      // remove every hook

(() => {
  if (window.__pasteTest) {
    console.log("[test] already loaded — run __pasteTest.stop() first");
    return;
  }

  const CLIP_ATTR = "data-tulip-clipboard";
  const log = [];
  const attempts = [];
  const restores = [];
  let captured = null; // { html, payload }

  const now = () => new Date().toISOString().slice(11, 23);
  const rec = (tag, data) => {
    log.push({ t: now(), tag, data });
  };

  // ── Tulip's own encoding, mirrored exactly ────────────────────────────────
  function encodePayload(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return "<span " + CLIP_ATTR + '="' + btoa(binary) + '"></span>';
  }

  function decodePayload(html) {
    const el = new DOMParser().parseFromString(html, "text/html").querySelector("[" + CLIP_ATTR + "]");
    if (!el) return null;
    const b64 = el.getAttribute(CLIP_ATTR);
    if (!b64) return null;
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ── capture the next copy ─────────────────────────────────────────────────
  const clipProto = window.Clipboard && window.Clipboard.prototype;
  const originalWrite = clipProto && clipProto.write;
  if (originalWrite) {
    clipProto.write = function (items, ...rest) {
      try {
        const item = (items || []).find((i) => i && i.types && i.types.includes("text/html"));
        if (item) {
          item
            .getType("text/html")
            .then((b) => b.text())
            .then((html) => {
              const payload = decodePayload(html);
              if (payload && payload.trigger) {
                captured = { html, payload };
                const ev = payload.trigger.event || {};
                console.log(
                  "[test] captured " +
                    JSON.stringify({
                      name: payload.trigger.name,
                      event: ev,
                      stepId: payload.trigger.stepId ?? null,
                      widgetId: payload.trigger.widgetId ?? null,
                    }),
                );
                rec("captured", { event: ev, name: payload.trigger.name });
              }
            })
            .catch(() => {});
        }
      } catch (_) {}
      return originalWrite.call(this, items, ...rest);
    };
    restores.push(() => {
      if (clipProto.write !== originalWrite) clipProto.write = originalWrite;
    });
  }

  // ── watch Tulip's own copy/paste logging ──────────────────────────────────
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    const patched = function (...args) {
      try {
        const first = typeof args[0] === "string" ? args[0] : "";
        if (/\[Copy\/[Pp]aste\]|paste/i.test(first) && !first.startsWith("[test]")) {
          let context = null;
          try {
            context = args[1] && typeof args[1] === "object" ? JSON.parse(JSON.stringify(args[1])) : null;
          } catch (_) {}
          rec("tulip." + level, { message: first.slice(0, 300), context });
        }
      } catch (_) {}
      return original.apply(this, args);
    };
    console[level] = patched;
    restores.push(() => {
      if (console[level] === patched) console[level] = original;
    });
  }

  // ── watch the paste API call ──────────────────────────────────────────────
  const RELEVANT = /paste|trigger/i;

  const originalFetch = window.fetch;
  window.fetch = async function (input, init, ...rest) {
    const url = typeof input === "string" ? input : input && input.url;
    const body = init && typeof init.body === "string" ? init.body : null;
    const interesting = RELEVANT.test(String(url)) || (body && RELEVANT.test(body));
    const response = await originalFetch.call(this, input, init, ...rest);
    if (interesting) {
      let text = null;
      try {
        text = await response.clone().text();
      } catch (_) {}
      rec("fetch", {
        url: String(url).slice(0, 300),
        status: response.status,
        ok: response.ok,
        requestBody: body ? body.slice(0, 2000) : null,
        responseBody: text ? text.slice(0, 2000) : null,
      });
      console.log("[test] paste-ish fetch", response.status, String(url).slice(0, 120));
    }
    return response;
  };
  restores.push(() => {
    window.fetch = originalFetch;
  });

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__testUrl = url;
    this.__testMethod = method;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = String(this.__testUrl || "");
    const bodyText = typeof body === "string" ? body : null;
    if (RELEVANT.test(url) || (bodyText && RELEVANT.test(bodyText))) {
      this.addEventListener("loadend", () => {
        rec("xhr", {
          url: url.slice(0, 300),
          method: this.__testMethod,
          status: this.status,
          requestBody: bodyText ? bodyText.slice(0, 2000) : null,
          responseBody: String(this.responseText || "").slice(0, 2000),
        });
        console.log("[test] paste-ish xhr", this.status, url.slice(0, 120));
      });
    }
    return originalSend.call(this, body);
  };
  restores.push(() => {
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
  });

  // ── the rewrite ───────────────────────────────────────────────────────────
  // Keep every field Tulip's entry guards read (sourceCustomer, workspace,
  // queryIds, recordPlaceholders) exactly as copied. Touch only trigger.event.
  const NEEDS_ARGS = { interval: true, "device-output": true };
  const CUSTOM = "custom-widget-event";

  function rewrite(payload, type, { eventName, customWidgetId, args } = {}) {
    const next = JSON.parse(JSON.stringify(payload));
    const event = { id: next.trigger.event && next.trigger.event.id, type };

    if (type === CUSTOM) {
      if (!eventName || !customWidgetId) {
        throw new Error(
          "custom-widget-event needs { eventName, customWidgetId } from the TARGET widget",
        );
      }
      event.eventName = eventName;
      event.customWidgetId = customWidgetId;
    }
    if (NEEDS_ARGS[type]) {
      event.args = args || (type === "interval" ? { interval: 30 } : {});
    }
    next.trigger.event = event;
    return next;
  }

  // ── dispatching a paste Tulip will pick up ────────────────────────────────
  function dispatchPaste(html) {
    const data = new DataTransfer();
    data.setData("text/html", html);
    const target =
      document.querySelector("#cssCanvas") ||
      document.querySelector('[data-testid="widget"]') ||
      document.body;
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(event);
    return { target: target.id || target.tagName, defaultPrevented: event.defaultPrevented };
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__pasteTest = {
    arm() {
      captured = null;
      console.log("[test] armed — now click the copy icon on the trigger you want to move");
      return "armed";
    },

    show() {
      if (!captured) return "nothing captured yet — run __pasteTest.arm() and click a copy icon";
      const t = captured.payload.trigger;
      return JSON.stringify(
        { name: t.name, event: t.event, stepId: t.stepId ?? null, widgetId: t.widgetId ?? null },
        null,
        2,
      );
    },

    async tryAs(type, options = {}) {
      if (!captured) return "nothing captured — run __pasteTest.arm() and click a copy icon first";
      const before = log.length;
      let payload;
      try {
        payload = rewrite(captured.payload, type, options);
      } catch (err) {
        return String(err.message || err);
      }

      const html = encodePayload(payload);
      rec("attempt", { type, options, from: captured.payload.trigger.event });
      const dispatch = dispatchPaste(html);
      console.log("[test] dispatched paste as", type, dispatch);

      await wait(3000);

      const since = log.slice(before);
      const opened = since.some((e) => /opening trigger editor/i.test(e.data.message || ""));
      const failed = since.some(
        (e) => e.tag === "tulip.error" || /error|failed|not recognized/i.test(e.data.message || ""),
      );
      const api = since.filter((e) => e.tag === "fetch" || e.tag === "xhr");

      const verdict = opened
        ? "ACCEPTED — trigger created and editor opened"
        : failed
          ? "REFUSED — see the log below"
          : dispatch.defaultPrevented
            ? "UNCLEAR — Tulip consumed the event but logged nothing"
            : "IGNORED — Tulip never handled the synthetic paste (see notes in the header)";

      attempts.push({ type, options, verdict, entries: since });
      console.log("[test] " + verdict);
      for (const e of since) console.log("   ", e.tag, JSON.stringify(e.data).slice(0, 400));
      if (api.length) console.log("[test] api calls:", api.length);
      return verdict;
    },

    // Fallback if the synthetic paste is ignored: writes the rewritten payload
    // to the real clipboard from a real click, then you press Ctrl+V yourself.
    button(type, options = {}) {
      if (!captured) return "nothing captured yet";
      const existing = document.getElementById("tulbelt-paste-test-button");
      if (existing) existing.remove();
      const btn = document.createElement("button");
      btn.id = "tulbelt-paste-test-button";
      btn.textContent = "Copy rewritten payload (" + type + ")";
      btn.style.cssText =
        "position:fixed;z-index:2147483647;bottom:16px;right:16px;padding:10px 14px;" +
        "background:#0065ff;color:#fff;border:0;border-radius:6px;font:600 13px system-ui;cursor:pointer";
      btn.addEventListener("click", async () => {
        try {
          const html = encodePayload(rewrite(captured.payload, type, options));
          await navigator.clipboard.write([
            new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) }),
          ]);
          btn.textContent = "Copied — now press Ctrl/Cmd+V";
          rec("button-write", { type, options });
        } catch (err) {
          btn.textContent = "Failed: " + String(err.message || err);
        }
      });
      document.body.appendChild(btn);
      return "button added bottom-right — click it, then press Ctrl/Cmd+V on the target";
    },

    report() {
      const json = JSON.stringify({ attempts, log }, null, 2)
        .split(location.hostname)
        .join("your-instance.tulip.co");
      window.__pasteTestJson = json;
      return json;
    },

    stop() {
      document.getElementById("tulbelt-paste-test-button")?.remove();
      while (restores.length) {
        try {
          restores.pop()();
        } catch (_) {}
      }
      delete window.__pasteTest;
      return "hooks removed";
    },
  };

  console.log(
    "[test] loaded. WARNING: a successful paste creates a real trigger — use a scratch app version.\n" +
      "  1. __pasteTest.arm()   then click a trigger's copy icon\n" +
      "  2. select a target (widget for button-press, any step for step-open)\n" +
      "  3. await __pasteTest.tryAs('button-press')",
  );
})();
