// Trigger-editor Value Picker inputs (`input[aria-label="Value Picker"]`) are
// one fixed-width line, so long static values get clipped. When a value
// overflows its box, this hides the real input and renders a sibling
// soft-wrapping, auto-growing <textarea> proxy that shows the full text and
// stays editable — the action-editor-frequent.js hidden-real + proxy pattern.
// Keystrokes forward into the real input via the native value setter +
// bubbling input/change events (the snap-to-grid.js pattern) so React state
// stays the source of truth.
//
// Swaps in either direction happen only on mount/reconcile and on blur, never
// while the field is focused, so the caret is never yanked mid-typing. Enter
// commits (forwarded to the real input) instead of inserting a newline —
// input[type=text] values can't contain line breaks; the multiline look is
// soft wrap only.

(() => {
  const FEATURE_ID = "trigger-value-full-text";
  const STORAGE_KEY = "toggles";

  const INPUT_SEL = 'input[type="text"][aria-label="Value Picker"]';
  // Tulip's trigger-editor CSS-module class prefix; keeps look-alike inputs
  // elsewhere untouched.
  const EDITOR_SCOPE_SEL = '[class*="triggers-editor-client"]';
  const PROXY_ATTR = "data-tulbelt-fulltext-proxy";
  const HIDDEN_ATTR = "data-tulbelt-fulltext-hidden";
  const STYLE_ID = "tulbelt-trigger-value-full-text-styles";

  let enabled = false;
  let observer = null;
  // real input -> proxy textarea. WeakMap so React-replaced inputs are
  // auto-collected; reset wholesale on disable.
  let tracked = new WeakMap();

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${HIDDEN_ATTR}="true"] { display: none !important; }
      textarea[${PROXY_ATTR}] {
        field-sizing: content;
        resize: none;
        overflow: hidden;
        box-sizing: border-box;
        display: block;
        white-space: pre-wrap;
        overflow-wrap: break-word;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyles() {
    document.getElementById(STYLE_ID)?.remove();
  }

  function isValuePickerInput(el) {
    return (
      el instanceof HTMLInputElement && el.matches(INPUT_SEL) && !!el.closest(EDITOR_SCOPE_SEL)
    );
  }

  // Drive React's onChange by going around the React-overridden value setter.
  function setNativeInputValue(input, value) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // scrollWidth/clientWidth are 0 while the input is display:none, so a
  // proxied input is measured by synchronously unhiding it — no paint happens
  // between the attribute flips, so nothing flickers.
  function overflows(input) {
    const hidden = input.getAttribute(HIDDEN_ATTR) === "true";
    if (hidden) input.removeAttribute(HIDDEN_ATTR);
    const result = input.scrollWidth > input.clientWidth + 1;
    if (hidden) input.setAttribute(HIDDEN_ATTR, "true");
    return result;
  }

  // The input carries no class (its look lives in computed styles), so the
  // proxy copies the visual properties directly. Width is pinned in px — the
  // wrapper shrink-wraps its content, so percentage widths would be circular
  // once the input is hidden.
  const COPIED_STYLES = [
    "font",
    "letterSpacing",
    "color",
    "backgroundColor",
    "border",
    "borderRadius",
    "padding",
    "margin",
    "boxShadow",
    "lineHeight",
    "textAlign",
  ];

  function mountProxy(input) {
    if (tracked.has(input) || !input.parentElement) return;

    const proxy = document.createElement("textarea");
    proxy.setAttribute(PROXY_ATTR, "1");
    proxy.rows = 1;
    proxy.wrap = "soft";
    const aria = input.getAttribute("aria-label");
    if (aria) proxy.setAttribute("aria-label", aria);
    proxy.placeholder = input.placeholder || "";

    // Capture while the real input is still visible.
    const cs = getComputedStyle(input);
    for (const prop of COPIED_STYLES) proxy.style[prop] = cs[prop];
    proxy.style.width = cs.width;
    proxy.style.minHeight = cs.height;
    proxy.value = input.value;

    proxy.addEventListener("input", () => {
      // Pasted newlines are flattened — the real input's value can't hold them.
      const flat = proxy.value.replace(/[\r\n]+/g, " ");
      if (flat !== proxy.value) proxy.value = flat;
      setNativeInputValue(input, flat);
    });

    proxy.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
      input.dispatchEvent(new KeyboardEvent("keydown", enter));
      input.dispatchEvent(new KeyboardEvent("keyup", enter));
      proxy.blur();
    });

    // field-sizing: content handles auto-grow on Chrome 123+; fall back to a
    // scrollHeight resize for older builds.
    if (!CSS.supports("field-sizing", "content")) {
      const grow = () => {
        proxy.style.height = "auto";
        proxy.style.height = `${proxy.scrollHeight}px`;
      };
      proxy.addEventListener("input", grow);
      queueMicrotask(grow);
    }

    input.parentElement.insertBefore(proxy, input.nextSibling);
    input.setAttribute(HIDDEN_ATTR, "true");
    tracked.set(input, proxy);
  }

  function unmountProxy(input) {
    tracked.get(input)?.remove();
    tracked.delete(input);
    input.removeAttribute(HIDDEN_ATTR);
  }

  function isFocused(el) {
    return document.activeElement === el;
  }

  // Decide native-vs-proxy for one input. Never flips state while the input
  // or its proxy is focused.
  function evaluate(input) {
    if (!input.isConnected) return;
    const proxy = tracked.get(input);
    if (proxy) {
      if (isFocused(proxy)) return;
      // React may have changed the value or replaced siblings underneath us.
      if (proxy.value !== input.value) proxy.value = input.value;
      if (!proxy.isConnected || input.nextElementSibling !== proxy) {
        input.parentElement?.insertBefore(proxy, input.nextSibling);
      }
      if (input.getAttribute(HIDDEN_ATTR) !== "true") {
        input.setAttribute(HIDDEN_ATTR, "true");
      }
      if (!overflows(input)) unmountProxy(input);
    } else {
      if (isFocused(input)) return;
      if (overflows(input)) mountProxy(input);
    }
  }

  function reconcile() {
    for (const input of document.querySelectorAll(INPUT_SEL)) {
      if (isValuePickerInput(input)) evaluate(input);
    }
  }

  function restoreAll() {
    document.querySelectorAll(`[${PROXY_ATTR}]`).forEach((el) => el.remove());
    document
      .querySelectorAll(`[${HIDDEN_ATTR}="true"]`)
      .forEach((el) => el.removeAttribute(HIDDEN_ATTR));
    tracked = new WeakMap();
  }

  // Re-evaluate on blur — the only moment state is allowed to flip for a
  // field the user was just editing. focusout is delegated so per-input
  // listeners aren't needed.
  function onFocusOut(e) {
    const t = e.target;
    let input = null;
    if (t instanceof Element && t.hasAttribute?.(PROXY_ATTR)) {
      input = t.previousElementSibling;
    } else if (isValuePickerInput(t)) {
      input = t;
    }
    if (!(input instanceof HTMLInputElement)) return;
    // Wait a tick so document.activeElement reflects where focus landed.
    setTimeout(() => {
      if (enabled) evaluate(input);
    }, 0);
  }

  function mutationTouchesTarget(node) {
    if (!(node instanceof Element)) return false;
    if (node.hasAttribute?.(PROXY_ATTR)) return false;
    return node.matches?.(INPUT_SEL) || !!node.querySelector?.(INPUT_SEL);
  }

  function onMutation(mutations) {
    let needsReconcile = false;
    for (const m of mutations) {
      if (m.target instanceof Element && m.target.closest?.(`[${PROXY_ATTR}]`)) continue;
      for (const node of m.addedNodes) {
        if (mutationTouchesTarget(node)) needsReconcile = true;
      }
      for (const node of m.removedNodes) {
        if (node instanceof Element && tracked.has(node)) {
          tracked.get(node)?.remove();
          tracked.delete(node);
        }
      }
    }
    if (needsReconcile) reconcile();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("focusout", onFocusOut, true);
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("focusout", onFocusOut, true);
  }

  async function syncFromStorage() {
    const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
    const next = stored[FEATURE_ID] === true;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      ensureStyles();
      reconcile();
      startObserver();
    } else {
      stopObserver();
      restoreAll();
      removeStyles();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
