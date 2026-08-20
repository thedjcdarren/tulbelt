// Throwaway capture probe for the trigger copy/paste investigation
// (docs/paste-trigger-anywhere.md). Paste the whole file into the DevTools
// console of an app editor tab, in the **page** context ("top"), NOT the
// Tulbelt isolated-world context — it has to see Tulip's own
// `navigator.clipboard` calls, and the isolated world has a different one.
//
// It records, and never changes, every layer a trigger copy/paste could
// travel through:
//   * Clipboard API   — writeText / readText / write / read (+ caller stack)
//   * clipboard events — copy / cut / paste, captured before AND after Tulip's
//     own handlers (capture phase sees the payload Tulip is about to read;
//     bubble phase sees what Tulip wrote during a copy)
//   * document.execCommand('copy'|'cut'|'paste')
//   * localStorage / sessionStorage writes
//   * Ctrl/Cmd+C/X/V keydowns, with the DOM target
//   * clicks on any button (so the trigger row's copy/cut icons identify
//     themselves by testid/aria-label)
//   * console.warn / console.error (a refused paste often complains there)
//
// Then: __tpaReport() returns the redacted JSON (hostname replaced), or
// `copy(__tpaReport())` to put it on the clipboard. __tpaStop() restores every
// patched function.

(() => {
  if (window.__tpa) {
    console.log("[tpa] already installed — run __tpaStop() first to reinstall");
    return;
  }

  const MAX_STRING = 20000;
  const MAX_ENTRIES = 600;
  const entries = [];
  const t0 = performance.now();
  /** Undo functions for every patch, run by __tpaStop(). */
  const restores = [];

  function clipStr(value) {
    if (typeof value !== "string") return value;
    return value.length > MAX_STRING
      ? value.slice(0, MAX_STRING) + "…(+" + (value.length - MAX_STRING) + " chars)"
      : value;
  }

  function rec(tag, data) {
    entries.push({ t: Math.round(performance.now() - t0), tag, data });
    if (entries.length > MAX_ENTRIES) entries.shift();
    try {
      console.log("[tpa]", tag, data);
    } catch (_) {}
  }

  function stack() {
    try {
      return new Error().stack.split("\n").slice(2, 7).join(" | ");
    } catch (_) {
      return null;
    }
  }

  function describe(node) {
    if (!node || typeof node !== "object" || node.nodeType !== 1) {
      return node === document ? "#document" : node === window ? "#window" : String(node);
    }
    const out = {
      tag: node.tagName,
      testid: node.getAttribute?.("data-testid") || undefined,
      aria: node.getAttribute?.("aria-label") || undefined,
      cls: (node.getAttribute?.("class") || "").slice(0, 140) || undefined,
      text: (node.textContent || "").trim().slice(0, 60) || undefined,
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  // ── Clipboard API ───────────────────────────────────────────────────────────
  // Patch the prototype (catches references Tulip grabbed early) and the live
  // navigator.clipboard instance (catches a shadowed own property).
  function patchClipboard(target, label) {
    if (!target) return;
    for (const method of ["writeText", "readText", "write", "read"]) {
      const original = target[method];
      if (typeof original !== "function") continue;
      const isRead = method === "readText" || method === "read";
      const patched = function (...args) {
        const where = stack();
        if (!isRead) {
          rec("clipboard." + method, {
            via: label,
            arg:
              method === "writeText"
                ? clipStr(args[0])
                : (args[0] || []).map((item) => item && item.types),
            stack: where,
          });
        }
        let result;
        try {
          result = original.apply(this, args);
        } catch (err) {
          rec("clipboard." + method + ":threw", { via: label, error: String(err), stack: where });
          throw err;
        }
        if (isRead && result && typeof result.then === "function") {
          return result.then(
            (value) => {
              rec("clipboard." + method + ":resolved", {
                via: label,
                value:
                  method === "readText"
                    ? clipStr(value)
                    : (value || []).map((item) => item && item.types),
                stack: where,
              });
              return value;
            },
            (err) => {
              rec("clipboard." + method + ":rejected", {
                via: label,
                error: String(err),
                stack: where,
              });
              throw err;
            },
          );
        }
        return result;
      };
      try {
        target[method] = patched;
        restores.push(() => {
          if (target[method] === patched) target[method] = original;
        });
      } catch (_) {}
    }
  }
  patchClipboard(window.Clipboard && window.Clipboard.prototype, "Clipboard.prototype");
  try {
    if (Object.prototype.hasOwnProperty.call(navigator, "clipboard")) {
      patchClipboard(navigator.clipboard, "navigator.clipboard");
    }
  } catch (_) {}

  // ── execCommand ─────────────────────────────────────────────────────────────
  const origExec = document.execCommand;
  if (typeof origExec === "function") {
    document.execCommand = function (cmd, ...rest) {
      const result = origExec.call(this, cmd, ...rest);
      if (/^(copy|cut|paste)$/i.test(String(cmd))) {
        rec("execCommand", { cmd, result, stack: stack() });
      }
      return result;
    };
    restores.push(() => {
      document.execCommand = origExec;
    });
  }

  // ── clipboard events ────────────────────────────────────────────────────────
  function readDataTransfer(dt) {
    const out = {};
    try {
      for (const type of dt ? dt.types || [] : []) out[type] = clipStr(dt.getData(type));
    } catch (err) {
      out.__error = String(err);
    }
    return out;
  }

  function onClipboardEvent(phase) {
    return (e) => {
      rec("event:" + e.type + ":" + phase, {
        isTrusted: e.isTrusted,
        defaultPrevented: e.defaultPrevented,
        target: describe(e.target),
        data: readDataTransfer(e.clipboardData),
      });
    };
  }
  for (const type of ["copy", "cut", "paste"]) {
    const capture = onClipboardEvent("capture");
    const bubble = onClipboardEvent("bubble");
    window.addEventListener(type, capture, true);
    window.addEventListener(type, bubble, false);
    restores.push(() => {
      window.removeEventListener(type, capture, true);
      window.removeEventListener(type, bubble, false);
    });
  }

  // ── storage writes ──────────────────────────────────────────────────────────
  const origSet = Storage.prototype.setItem;
  const origRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) {
    rec("storage.setItem", { key, value: clipStr(String(value)), stack: stack() });
    return origSet.call(this, key, value);
  };
  Storage.prototype.removeItem = function (key) {
    rec("storage.removeItem", { key, stack: stack() });
    return origRemove.call(this, key);
  };
  restores.push(() => {
    Storage.prototype.setItem = origSet;
    Storage.prototype.removeItem = origRemove;
  });

  // ── keyboard + clicks ───────────────────────────────────────────────────────
  const onKeydown = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!/^[cvx]$/i.test(e.key)) return;
    rec("keydown", {
      key: e.key,
      target: describe(e.target),
      activeElement: describe(document.activeElement),
      // What the editor thinks is selected right now — the paste target.
      selected: [...document.querySelectorAll('[data-testid="widget"].selected, .widget.selected')]
        .slice(0, 3)
        .map(describe),
      contextPane: [...document.querySelectorAll("[data-testid^='context-pane']")]
        .slice(0, 6)
        .map((el) => el.getAttribute("data-testid")),
    });
  };
  window.addEventListener("keydown", onKeydown, true);
  restores.push(() => window.removeEventListener("keydown", onKeydown, true));

  const onClick = (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button, [role="button"], a');
    if (!btn) return;
    const row = btn.closest('[class*="triggerRow"], [class*="triggerItem"], [data-testid]');
    rec("click", { button: describe(btn), row: row === btn ? undefined : describe(row) });
  };
  window.addEventListener("click", onClick, true);
  restores.push(() => window.removeEventListener("click", onClick, true));

  // ── console noise (refusals often land here) ────────────────────────────────
  for (const level of ["warn", "error"]) {
    const original = console[level];
    const patched = function (...args) {
      try {
        rec("console." + level, {
          args: args.map((a) => clipStr(typeof a === "string" ? a : String(a))).slice(0, 4),
        });
      } catch (_) {}
      return original.apply(this, args);
    };
    console[level] = patched;
    restores.push(() => {
      if (console[level] === patched) console[level] = original;
    });
  }

  // ── report ──────────────────────────────────────────────────────────────────
  window.__tpa = { entries, rec };

  window.__tpaNote = (label) => {
    rec("note", { label });
    return "noted";
  };

  window.__tpaReport = () => {
    const report = {
      meta: {
        at: new Date().toISOString(),
        url: location.pathname + location.search,
        entryCount: entries.length,
        // Which storage keys exist now — a trigger clipboard may live in one.
        localStorageKeys: Object.keys(localStorage).slice(0, 200),
        sessionStorageKeys: Object.keys(sessionStorage).slice(0, 200),
      },
      entries,
    };
    const host = location.hostname;
    const json = JSON.stringify(report, null, 2).split(host).join("your-instance.tulip.co");
    window.__tpaJson = json;
    return json;
  };

  window.__tpaStop = () => {
    while (restores.length) {
      try {
        restores.pop()();
      } catch (_) {}
    }
    delete window.__tpa;
    return "probe removed (report helpers still available)";
  };

  console.log(
    "[tpa] armed. Reproduce: copy a trigger, paste it on a same-type target, " +
      "then paste it on a different-type target. Then run copy(__tpaReport()).",
  );
})();
