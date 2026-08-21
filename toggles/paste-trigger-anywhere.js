// Adds a "Paste trigger" button to each app-level and step-level trigger list
// section in the app editor, so a copied trigger can land on a surface Tulip's
// own Ctrl+V cannot reach.
//
// Why a button rather than a shortcut: Tulip's paste dispatcher picks its
// destination from the copied trigger's OWN binding — a trigger carrying
// neither stepId nor widgetId goes to the app level, one carrying stepId goes
// to the current step, one carrying widgetId goes to the selected widget. So
// there is no way to aim Ctrl+V at "the Timers list of this step": the button
// is what names the destination. Clicking it rewrites the payload's binding to
// that section's event class and hands it to Tulip's own paste path (see
// paste-trigger-anywhere-main.js), which creates the trigger server-side and
// opens the trigger editor exactly as a native paste does.
//
// This half only owns the buttons and the toggle lifecycle; it mirrors the
// toggle to <html data-tulbelt-pta-enabled> for the main-world half, which is
// where the clipboard payload can actually be seen.
//
// Sections deliberately NOT offered yet: widget and custom-widget lists. Those
// need the destination widget's id — and, for a custom widget, the section's
// eventName and customWidgetId — and there is no verified way to read them from
// the DOM yet. The mechanism is proven for both; the ids are the gap. See
// docs/paste-trigger-anywhere.md.
//
// "Machines & devices" IS offered, but is the one destination never tested
// end to end. A device-output event carries `args: { driver, event }` naming a
// specific device output; a trigger arriving from another surface has no such
// pairing, so it is sent with empty args (which Tulip's codec permits — its
// second branch makes every arg optional) for the user to fill in in the
// editor that opens.

(() => {
  const { addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "paste-trigger-anywhere";
  const STORAGE_KEY = "toggles";
  const DEVELOPER_MODE_KEY = "developerMode";

  const ENABLED_ATTR = "data-tulbelt-pta-enabled";
  const BUTTON_ATTR = "data-tulbelt-pta-paste";
  const STEP_ATTR = "data-tulbelt-pta-step";
  const CLAIMED_ATTR = "data-tulbelt-pta-claimed";
  const STYLE_ID = "tulbelt-paste-trigger-anywhere-styles";
  const RESULT_EVENT = "tulbelt:pta-result";

  // App version editor pages only (same shape as snap-to-grid).
  const EDITOR_PATH = /(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\//;

  // Tulip's own CSS-module class names; readable, not hashed.
  const GROUP_SEL = '[class*="triggerGroupStyles"]';
  const HEADING_SEL = '[class*="triggerHeaderLabel"]';

  // Section heading -> the event type a trigger must carry to land there.
  // Only destinations with an observed payload are listed.
  const DESTINATIONS = {
    "app started": "app-start",
    "app completed": "app-complete",
    "app cancelled": "app-cancel",
    "app canceled": "app-cancel",
    "on step enter": "step-open",
    "on step exit": "step-closed",
    timers: "interval",
    "machines & devices": "device-output",
    "machines and devices": "device-output",
  };

  // Which destinations need the current step's id in the payload to classify
  // as step-level. App-class destinations carry no ids at all.
  const STEP_CLASS = new Set(["step-open", "step-closed", "interval"]);

  const CSS = `
    button[${BUTTON_ATTR}] {
      margin-left: 8px;
      padding: 2px 8px;
      font: inherit;
      font-size: 11px;
      line-height: 18px;
      color: inherit;
      background: transparent;
      border: 1px solid currentColor;
      border-radius: 3px;
      opacity: 0.55;
      cursor: pointer;
      vertical-align: middle;
    }
    button[${BUTTON_ATTR}]:hover { opacity: 1; }
    button[${BUTTON_ATTR}][disabled] { cursor: default; opacity: 0.4; }
  `;

  let active = false;
  let observer = null;

  function normalizeHeading(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\(\d+\)\s*$/, "")
      .trim()
      .toLowerCase();
  }

  // The step whose lists are on screen. Tulip puts it in the editor URL; if it
  // isn't there we simply don't offer step-level destinations, rather than
  // guess an id and paste into the wrong place.
  function currentStepId() {
    try {
      return new URL(location.href).searchParams.get("step");
    } catch (_) {
      return null;
    }
  }

  function destinationFor(group) {
    const heading = group.querySelector(HEADING_SEL);
    if (!heading) return null;
    const type = DESTINATIONS[normalizeHeading(heading.textContent)];
    if (!type) return null;
    if (STEP_CLASS.has(type)) {
      const stepId = currentStepId();
      return stepId ? { type, stepId, heading } : null;
    }
    return { type, stepId: null, heading };
  }

  function addButton(group) {
    if (group.getAttribute(CLAIMED_ATTR) === "1") return;
    const destination = destinationFor(group);
    if (!destination) return;
    group.setAttribute(CLAIMED_ATTR, "1");

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Paste trigger";
    button.setAttribute(BUTTON_ATTR, destination.type);
    if (destination.stepId) button.setAttribute(STEP_ATTR, destination.stepId);
    // The main-world half listens for clicks on this element directly — the
    // DOM is shared between worlds even though the JS environments are not.
    destination.heading.appendChild(button);
  }

  function scan() {
    if (!active) return;
    for (const group of document.querySelectorAll(GROUP_SEL)) addButton(group);
  }

  function removeButtons() {
    for (const el of document.querySelectorAll("[" + BUTTON_ATTR + "]")) el.remove();
    for (const el of document.querySelectorAll("[" + CLAIMED_ATTR + "]")) {
      el.removeAttribute(CLAIMED_ATTR);
    }
  }

  // The main-world half reports back here so the button can say what happened
  // without us needing a toast of our own.
  function onResult(e) {
    let detail = null;
    try {
      detail = typeof e.detail === "string" ? JSON.parse(e.detail) : null;
    } catch (_) {}
    const button = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!detail || !button || !button.hasAttribute(BUTTON_ATTR)) return;
    const original = "Paste trigger";
    button.textContent = detail.ok ? "Pasted" : detail.error || "Paste failed";
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 2200);
  }

  function enable() {
    if (active) return;
    active = true;
    ensureStyles(STYLE_ID, CSS);
    document.addEventListener(RESULT_EVENT, onResult, true);
    observer = addedNodesObserver(GROUP_SEL, scan);
    observer.start();
    scan();
  }

  function disable() {
    if (!active) return;
    active = false;
    observer?.stop();
    observer = null;
    document.removeEventListener(RESULT_EVENT, onResult, true);
    removeButtons();
    removeStyles(STYLE_ID);
  }

  function setFlag(on) {
    try {
      document.documentElement.setAttribute(ENABLED_ATTR, on ? "true" : "false");
    } catch (_) {}
  }

  // Developer-only for now: a paste creates a real trigger on the server the
  // moment it happens (there is no Save to confirm it), and a moved trigger
  // has not yet been observed FIRING in the Player. Read raw storage rather
  // than registerToggle so developer mode gates it here too.
  async function syncFromStorage() {
    let stored = {};
    let developerMode = false;
    try {
      const raw = await chrome.storage.local.get([STORAGE_KEY, DEVELOPER_MODE_KEY]);
      if (raw && typeof raw[STORAGE_KEY] === "object") stored = raw[STORAGE_KEY];
      developerMode = raw[DEVELOPER_MODE_KEY] === true;
    } catch (_) {
      return;
    }
    const next = stored[FEATURE_ID] === true && developerMode && EDITOR_PATH.test(location.pathname);
    setFlag(next);
    if (next) enable();
    else disable();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY] || changes[DEVELOPER_MODE_KEY]) syncFromStorage();
  });

  // The editor is a single-page app: the step (and therefore the step id the
  // buttons carry) changes without a reload.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (active) removeButtons();
    syncFromStorage();
  }, 700);

  syncFromStorage();
})();
