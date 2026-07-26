// Adds an "Option Sets" item to the Account Settings sidebar that shows a
// Tulbelt-owned page at the fake URL /account/option-sets. Tulip's header and
// sidebar stay real; only the content pane is swapped. The URL is pushed with
// history.pushState, which React Router never observes — the app keeps
// rendering the previous settings page underneath while we cover it.
//
// Styled-components class hashes are build-specific, so the "selected" nav
// style is never hardcoded: the selected <li> is whichever className is in the
// minority among sidebar items, and we swap that className between the real
// item and ours.

(() => {
  const FEATURE_ID = "option-sets-builder";
  const STORAGE_KEY = "toggles";
  const FAKE_PATH = "/account/option-sets";
  const LI_ATTR = "data-tulbelt-osb-item";
  const HIDDEN_ATTR = "data-tulbelt-osb-hidden";
  const STYLE_ID = "tulbelt-osb-styles";
  const CONTAINER_ID = "tulbelt-osb-page";

  let enabled = false;
  let active = false;
  let observer = null;
  let scheduled = false;
  // Real settings path to fall back to when leaving the fake page.
  let lastRealPath = "/account/account";
  // Set when the page cold-loaded on the fake URL; consumed once the sidebar
  // exists so we can activate over whatever Tulip rendered (404 or redirect).
  let coldLoadWanted = false;
  // The real <li> we demoted while active, and its original className.
  let demotedLi = null;
  let demotedClass = "";

  const isFakePath = (p = location.pathname) => p.replace(/\/+$/, "") === FAKE_PATH;

  // ── DOM discovery ───────────────────────────────────────────────────────────

  function findSettingsUl() {
    return document.querySelector('ul a[data-testid="account"]')?.closest("ul") || null;
  }

  function navItems(ul) {
    return [...ul.children].filter(
      (li) => li.tagName === "LI" && li.querySelector('a[href^="/account/"]') && !li.hasAttribute(LI_ATTR)
    );
  }

  // Selected <li> = the minority className among real sidebar items.
  function findSelected(ul) {
    const items = navItems(ul);
    const counts = new Map();
    for (const li of items) counts.set(li.className, (counts.get(li.className) || 0) + 1);
    if (counts.size < 2) return { selected: null, selectedClass: "", unselectedClass: items[0]?.className || "" };
    let selectedClass = "";
    let unselectedClass = "";
    let min = Infinity;
    let max = -1;
    for (const [cls, n] of counts) {
      if (n < min) { min = n; selectedClass = cls; }
      if (n > max) { max = n; unselectedClass = cls; }
    }
    return {
      selected: items.find((li) => li.className === selectedClass) || null,
      selectedClass,
      unselectedClass,
    };
  }

  // Sidebar column = first ancestor of the ul that also contains the
  // "Account settings" <h1>. Its element siblings are the content pane.
  function findSidebarColumn(ul) {
    for (let node = ul.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.querySelector("h1")) return node;
    }
    return null;
  }

  // ── Styles / container ──────────────────────────────────────────────────────

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${HIDDEN_ATTR}] { display: none !important; }
      #${CONTAINER_ID} { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 24px 40px; }
      #${CONTAINER_ID} h1 { font-size: 1.5em; margin: 0 0 16px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildContainer() {
    const el = document.createElement("div");
    el.id = CONTAINER_ID;
    el.innerHTML = `
      <h1>Option Sets</h1>
      <div data-testid="tulbelt-option-sets-body">
        <p>The Option Sets builder will live here. Nothing to configure yet.</p>
      </div>
    `;
    return el;
  }

  // ── Nav item ────────────────────────────────────────────────────────────────

  function injectLi(ul) {
    if (ul.querySelector(`li[${LI_ATTR}]`)) return;
    const { selected } = findSelected(ul);
    const template = navItems(ul).find((li) => li !== selected);
    if (!template) return;
    const li = template.cloneNode(true);
    li.setAttribute(LI_ATTR, "");
    li.setAttribute("href", FAKE_PATH);
    const a = li.querySelector("a");
    a.setAttribute("href", FAKE_PATH);
    a.setAttribute("data-testid", "option-sets");
    const span = a.querySelector("span") || a;
    span.textContent = "Option Sets";
    a.addEventListener("click", onOwnLinkClick);
    const after = ul.querySelector('a[data-testid="network-access"]')?.closest("li");
    if (after) after.after(li);
    else ul.appendChild(li);
  }

  function removeLi() {
    document.querySelector(`li[${LI_ATTR}]`)?.remove();
  }

  // ── Activate / deactivate ───────────────────────────────────────────────────

  function applyActive() {
    const ul = findSettingsUl();
    if (!ul) return;
    injectLi(ul);
    const ourLi = ul.querySelector(`li[${LI_ATTR}]`);
    if (!ourLi) return;

    // Promote our item to the selected style, demote whichever real item has it.
    const { selected, selectedClass, unselectedClass } = findSelected(ul);
    if (selected && selectedClass) {
      demotedLi = selected;
      demotedClass = selected.className;
      selected.className = unselectedClass;
      ourLi.className = selectedClass;
    }

    // Hide the content pane (all element siblings of the sidebar column) and
    // attach our page.
    const column = findSidebarColumn(ul);
    const parent = column?.parentElement;
    if (parent) {
      for (const sib of [...parent.children]) {
        if (sib !== column && sib.id !== CONTAINER_ID) sib.setAttribute(HIDDEN_ATTR, "");
      }
      if (!document.getElementById(CONTAINER_ID)) parent.appendChild(buildContainer());
    }
  }

  function activate() {
    if (active) return;
    if (!isFakePath()) lastRealPath = location.pathname;
    active = true;
    ensureStyles();
    applyActive();
  }

  function deactivate({ restoreUrl }) {
    if (!active) return;
    active = false;
    document.getElementById(CONTAINER_ID)?.remove();
    for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) el.removeAttribute(HIDDEN_ATTR);
    const ourLi = document.querySelector(`li[${LI_ATTR}]`);
    if (demotedLi?.isConnected && demotedClass) {
      if (ourLi) ourLi.className = demotedLi.className;
      demotedLi.className = demotedClass;
    }
    demotedLi = null;
    demotedClass = "";
    if (restoreUrl && isFakePath()) history.replaceState(null, "", lastRealPath);
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  function onOwnLinkClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (active || !enabled) return;
    lastRealPath = isFakePath() ? lastRealPath : location.pathname;
    history.pushState(null, "", FAKE_PATH);
    activate();
  }

  // Capture-phase: when a real link is clicked while our page is showing,
  // deactivate and realign the URL with the router's belief *before* React's
  // own click handler runs, then let the navigation proceed normally.
  function onDocumentClick(e) {
    if (!active) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || a.closest(`li[${LI_ATTR}]`)) return;
    deactivate({ restoreUrl: true });
  }

  function onPopState() {
    if (!enabled) return;
    if (isFakePath()) activate();
    else deactivate({ restoreUrl: false });
  }

  // ── Observer loop ───────────────────────────────────────────────────────────

  function ensure() {
    const ul = findSettingsUl();
    if (!ul) {
      // Settings page unmounted (navigated elsewhere in the SPA).
      if (active && !document.getElementById(CONTAINER_ID)?.isConnected) {
        active = false;
        demotedLi = null;
        demotedClass = "";
      }
      return;
    }
    injectLi(ul);
    if (coldLoadWanted && !active) {
      coldLoadWanted = false;
      if (!isFakePath()) {
        // Tulip's SPA redirected the unknown route somewhere real — remember
        // it as the fallback, then take the URL back.
        lastRealPath = location.pathname;
        history.pushState(null, "", FAKE_PATH);
      }
      activate();
      return;
    }
    if (active) applyActive();
  }

  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (enabled) ensure();
    });
  }

  function start() {
    ensureStyles();
    coldLoadWanted = isFakePath();
    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("popstate", onPopState);
    observer = new MutationObserver(scheduleEnsure);
    observer.observe(document.body, { childList: true, subtree: true });
    ensure();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("popstate", onPopState);
    deactivate({ restoreUrl: true });
    removeLi();
    document.getElementById(STYLE_ID)?.remove();
  }

  async function syncFromStorage() {
    const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
    const next = stored[FEATURE_ID] === true;
    if (next === enabled) return;
    enabled = next;
    if (enabled) start();
    else stop();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
