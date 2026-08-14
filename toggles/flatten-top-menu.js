// Flattens Tulip's top navigation: the links Tulip only reveals inside the
// header's hover dropdowns are lifted into the header bar itself, and the
// dropdowns stop opening.
//
// Which links live in those menus isn't fixed — it varies with the tenant's
// license and the signed-in user's permissions — so the list can't be
// hardcoded. It's harvested once per workspace instead: synthesize a hover on
// each `a[aria-haspopup="menu"]` in the header, read the anchors Tulip renders
// into the popper, then cache the result in chrome.storage. The whole probe
// runs with poppers pinned `visibility: hidden`, so the menus never visibly
// flash open. If the probe comes back empty the nav is left completely alone —
// a header we can't read is a header we must not dismantle.
//
// The originals are hidden with an attribute + stylesheet rather than removed
// (React still owns them), and each flattened link is a *clone* of a plain nav
// anchor, so it inherits the styled-component classes without inheriting the
// hover handler that opens a dropdown. A clone carries no React router
// binding either, so a plain left click is routed through the real menu the
// same way `move-variables-to-toolbar` drives the real Variables button:
// re-open the (still display:none) source menu off-screen, click the matching
// real anchor, and fall back to normal navigation if that doesn't pan out.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "flatten-top-menu";
  const STYLE_ID = "tulbelt-flatten-top-menu-styles";
  const PROBE_STYLE_ID = "tulbelt-flatten-top-menu-probe-styles";
  const CACHE_KEY = "flatNavMenus";
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const HEADER_SELECTOR = '[data-testid="tulip-header"]';
  const MENU_ANCHOR_SELECTOR = 'a[aria-haspopup="menu"]';
  const POPPER_SELECTOR = '[data-testid="popper"], [role="menu"]';

  const HIDDEN_ATTR = "data-tulbelt-flat-nav-hidden";
  const RENDERED_ATTR = "data-tulbelt-flat-nav-rendered";
  const CLONE_ATTR = "data-tulbelt-flat-nav-item";
  const GROUP_ATTR = "data-tulbelt-flat-nav-group";
  const PARENT_ATTR = "data-tulbelt-flat-nav-parent";

  const POLL_MS = 50;
  const MENU_OPEN_TIMEOUT_MS = 2000;
  const MENU_CLOSE_TIMEOUT_MS = 800;
  const CLICK_PROBE_TIMEOUT_MS = 700;
  const MAX_HARVEST_ATTEMPTS = 2;
  const HARVEST_RETRY_MS = 3000;

  const HIDE_CSS = `[${HIDDEN_ATTR}="true"] { display: none !important; }`;
  const PROBE_CSS = `${POPPER_SELECTOR} { visibility: hidden !important; pointer-events: none !important; }`;

  let enabled = false;
  let cache = null; // { key, groups }
  let harvesting = false;
  let harvestAttempts = 0;
  let lastCacheKey = "";
  // Set once a lookup comes back empty so apply() stops hitting storage on
  // every mutation batch; a timer lifts it for the next attempt.
  let blocked = false;
  // Flipped to false the first time the click-through probe times out, so a
  // Tulip build we can't drive costs one slow click, not one per click.
  let routeThroughMenus = true;
  let activeTemplate = null;
  let inactiveTemplate = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const labelOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  function pathOf(href) {
    if (!href) return "";
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return url.href;
      return url.pathname.replace(/\/+$/, "") || "/";
    } catch {
      return href;
    }
  }

  // Top-level section of a nav path, ignoring the workspace prefix:
  // "/w/DEFAULT/apps/folders" and "/w/DEFAULT/apps/x/versions/y" are both "apps".
  function sectionOf(path) {
    const withoutWorkspace = path.replace(/^\/w\/[^/]+/, "");
    return (withoutWorkspace.split("/").filter(Boolean)[0] || "").toLowerCase();
  }

  const groupKeyOf = (anchor) =>
    anchor.id || labelOf(anchor) || pathOf(anchor.getAttribute("href"));

  function cacheKeyFor(anchors) {
    let workspace = location.pathname.match(/^\/w\/([^/]+)/)?.[1] ?? "";
    for (const anchor of anchors) {
      const match = pathOf(anchor.getAttribute("href")).match(/^\/w\/([^/]+)/);
      if (match) {
        workspace = match[1];
        break;
      }
    }
    return `${location.host}|${workspace}`;
  }

  async function readCache(key) {
    const { [CACHE_KEY]: all = {} } = await chrome.storage.local.get(CACHE_KEY);
    return all[key] ?? null;
  }

  async function writeCache(key, entry) {
    const { [CACHE_KEY]: all = {} } = await chrome.storage.local.get(CACHE_KEY);
    await chrome.storage.local.set({ [CACHE_KEY]: { ...all, [key]: entry } });
  }

  /* ---------------------------------------------------------------- hovering */

  function pointAt(el) {
    const rect = el.getBoundingClientRect();
    return {
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
  }

  function fireMouse(el, type, extra = {}) {
    const bubbles = type !== "mouseenter" && type !== "mouseleave";
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles,
        cancelable: true,
        view: window,
        ...pointAt(el),
        ...extra,
      }),
    );
  }

  function firePointer(el, type, extra = {}) {
    if (typeof PointerEvent !== "function") return;
    const bubbles = type !== "pointerenter" && type !== "pointerleave";
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles,
        cancelable: true,
        view: window,
        pointerType: "mouse",
        isPrimary: true,
        ...pointAt(el),
        ...extra,
      }),
    );
  }

  // React synthesises onMouseEnter/onMouseLeave from mouseover/mouseout pairs,
  // and some Tulip surfaces listen for the pointer events directly — fire both
  // families so either implementation opens.
  function hoverIn(el) {
    firePointer(el, "pointerover", { relatedTarget: document.body });
    firePointer(el, "pointerenter");
    fireMouse(el, "mouseover", { relatedTarget: document.body });
    fireMouse(el, "mouseenter");
    fireMouse(el, "mousemove");
  }

  function hoverOut(el) {
    firePointer(el, "pointerout", { relatedTarget: document.body });
    firePointer(el, "pointerleave", { relatedTarget: document.body });
    fireMouse(el, "mouseout", { relatedTarget: document.body });
    fireMouse(el, "mouseleave", { relatedTarget: document.body });
    // The pointer "arriving" somewhere else is what React turns into the leave.
    document.body.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        view: window,
        relatedTarget: el,
      }),
    );
  }

  // Anchors inside a popper that currently has layout boxes. A closed popper is
  // `display: none` and so has none, which holds even while the probe stylesheet
  // pins the open one to `visibility: hidden`.
  function openMenuAnchors() {
    const anchors = [];
    for (const popper of document.querySelectorAll(POPPER_SELECTOR)) {
      if (!popper.getClientRects().length) continue;
      for (const anchor of popper.querySelectorAll("a[href]")) {
        if (anchor.hasAttribute(CLONE_ATTR)) continue;
        anchors.push(anchor);
      }
    }
    return anchors;
  }

  function describe(anchor) {
    return {
      href: anchor.getAttribute("href") || "",
      label: labelOf(anchor),
      target: anchor.getAttribute("target") || "",
    };
  }

  // Opens `anchor`'s menu and returns its links. Waits for two consecutive
  // identical non-empty reads so a half-rendered menu is never cached.
  async function readMenu(anchor) {
    hoverIn(anchor);
    let previous = "";
    for (let waited = 0; waited < MENU_OPEN_TIMEOUT_MS; waited += POLL_MS) {
      await delay(POLL_MS);
      const items = openMenuAnchors()
        .map(describe)
        .filter((item) => item.href && item.label);
      const signature = JSON.stringify(items);
      if (items.length && signature === previous) return items;
      previous = signature;
    }
    return [];
  }

  async function closeMenu(anchor) {
    hoverOut(anchor);
    for (let waited = 0; waited < MENU_CLOSE_TIMEOUT_MS; waited += POLL_MS) {
      if (!openMenuAnchors().length) return;
      await delay(POLL_MS);
    }
  }

  async function harvest(anchors) {
    ensureStyles(PROBE_STYLE_ID, PROBE_CSS);
    const groups = [];
    try {
      for (const anchor of anchors) {
        await closeMenu(anchor);
        const children = await readMenu(anchor);
        await closeMenu(anchor);
        groups.push({
          key: groupKeyOf(anchor),
          href: anchor.getAttribute("href") || "",
          label: labelOf(anchor),
          children,
        });
      }
    } finally {
      removeStyles(PROBE_STYLE_ID);
    }
    return groups;
  }

  /* ------------------------------------------------------------ menu sources */

  const covers = (groups, anchors) =>
    anchors.every((anchor) => groups.some((group) => group.key === groupKeyOf(anchor)));

  function cachedGroupsFor(anchors) {
    if (!cache || cache.key !== cacheKeyFor(anchors)) return null;
    return covers(cache.groups, anchors) ? cache.groups : null;
  }

  async function loadGroups(anchors) {
    if (harvesting) return null;
    harvesting = true;
    const key = cacheKeyFor(anchors);
    try {
      const stored = await readCache(key);
      if (stored && Date.now() - stored.at < CACHE_TTL_MS && covers(stored.groups, anchors)) {
        cache = { key, groups: stored.groups };
        return cache.groups;
      }
      if (harvestAttempts >= MAX_HARVEST_ATTEMPTS) return null;
      harvestAttempts += 1;
      const groups = await harvest(anchors);
      // A menu that came back empty means the probe failed, not that the menu
      // is empty — don't cache it, and don't touch the nav on its account.
      if (!groups.length || groups.some((group) => !group.children.length)) return null;
      cache = { key, groups };
      await writeCache(key, { at: Date.now(), groups });
      return groups;
    } finally {
      harvesting = false;
    }
  }

  /* -------------------------------------------------------------- rendering */

  function isHighlighted(anchor) {
    const colour = anchor.style.borderBottomColor;
    if (!colour) return false;
    const channels = colour.match(/^rgba?\(([^)]+)\)$/);
    if (!channels) return true;
    const parts = channels[1].split(",").map((part) => parseFloat(part));
    return parts.length < 4 || parts[3] > 0;
  }

  const templateOf = (anchor) => ({
    className: anchor.className,
    style: anchor.getAttribute("style") || "",
  });

  // The active/inactive looks are read off Tulip's own anchors — the hashed
  // styled-component class names change between builds and must never be
  // hardcoded. Hidden originals still get their highlight updated by React, so
  // they stay usable as templates after flattening.
  function captureTemplates(header) {
    for (const anchor of header.querySelectorAll("a[href]")) {
      if (anchor.hasAttribute(CLONE_ATTR)) continue;
      if (isHighlighted(anchor)) activeTemplate = templateOf(anchor);
      else if (!anchor.hasAttribute("aria-haspopup")) inactiveTemplate = templateOf(anchor);
    }
    if (!inactiveTemplate) {
      const fallback = header.querySelector(MENU_ANCHOR_SELECTOR);
      if (fallback && !isHighlighted(fallback)) inactiveTemplate = templateOf(fallback);
    }
  }

  function buildAnchor(item, groupKey) {
    const anchor = document.createElement("a");
    anchor.setAttribute(CLONE_ATTR, "true");
    anchor.setAttribute(GROUP_ATTR, groupKey);
    if (item.parent) anchor.setAttribute(PARENT_ATTR, "true");
    anchor.setAttribute("href", item.href);
    if (item.target) {
      anchor.setAttribute("target", item.target);
      anchor.setAttribute("rel", "noopener noreferrer");
    }
    anchor.className = inactiveTemplate?.className ?? "";
    if (inactiveTemplate?.style) anchor.setAttribute("style", inactiveTemplate.style);
    anchor.textContent = item.label;
    anchor.addEventListener("click", onCloneClick);
    return anchor;
  }

  // What a single dropdown flattens into. The parent link is kept only when its
  // own destination isn't already one of the children — "Shop floor" points at
  // the same page as its "Stations" child and so disappears, while "Apps"
  // survives if its menu has no Apps entry of its own.
  function planFor(group, taken) {
    const items = [];
    const parentPath = pathOf(group.href);
    const parentLabel = group.label.toLowerCase();
    const children = group.children ?? [];
    const parentCovered = children.some(
      (child) => pathOf(child.href) === parentPath || child.label.toLowerCase() === parentLabel,
    );
    if (!parentCovered && group.href) {
      items.push({ href: group.href, label: group.label, target: "", parent: true });
    }
    for (const child of children) items.push({ ...child, parent: false });

    return items.filter((item) => {
      const path = `p:${pathOf(item.href)}`;
      const label = `l:${item.label.toLowerCase()}`;
      if (taken.has(path) || taken.has(label)) return false;
      taken.add(path);
      taken.add(label);
      return true;
    });
  }

  const clonesSelector = (groupKey) => `[${CLONE_ATTR}][${GROUP_ATTR}="${CSS.escape(groupKey)}"]`;

  function removeClonesFor(groupKey) {
    for (const clone of document.querySelectorAll(clonesSelector(groupKey))) clone.remove();
  }

  function renderGroup(anchor, group, taken) {
    const plan = planFor(group, taken);
    const signature = JSON.stringify(plan.map((item) => [item.href, item.label]));
    // A React re-render can drop our clones while leaving the original (and its
    // signature attribute) in place, so the count is checked too — otherwise the
    // links would silently never come back.
    const rendered = document.querySelectorAll(clonesSelector(group.key)).length;
    if (anchor.getAttribute(RENDERED_ATTR) !== signature || rendered !== plan.length) {
      removeClonesFor(group.key);
      let previous = anchor;
      for (const item of plan) {
        const clone = buildAnchor(item, group.key);
        previous.insertAdjacentElement("afterend", clone);
        previous = clone;
      }
      anchor.setAttribute(RENDERED_ATTR, signature);
    }
    if (anchor.getAttribute(HIDDEN_ATTR) !== "true") anchor.setAttribute(HIDDEN_ATTR, "true");
  }

  // Tulip highlights whichever nav item owns the current section; once the item
  // that used to carry it is hidden, the highlight has to be re-homed onto the
  // flattened link with the longest matching path.
  function refreshHighlight(header) {
    const clones = [...header.querySelectorAll(`[${CLONE_ATTR}]`)];
    if (!clones.length) return;
    const here = location.pathname.replace(/\/+$/, "");
    const hereSection = sectionOf(here);
    let best = null;
    let bestScore = -1;
    for (const clone of clones) {
      const path = pathOf(clone.getAttribute("href"));
      if (!hereSection || sectionOf(path) !== hereSection) continue;
      const score = here.startsWith(path) ? path.length : 0;
      if (score > bestScore) {
        bestScore = score;
        best = clone;
      }
    }
    for (const clone of clones) {
      const template = clone === best ? activeTemplate : inactiveTemplate;
      if (!template) continue;
      if (clone.className !== template.className) clone.className = template.className;
      if ((clone.getAttribute("style") || "") !== template.style) {
        anchorStyle(clone, template.style);
      }
    }
  }

  function anchorStyle(anchor, style) {
    if (style) anchor.setAttribute("style", style);
    else anchor.removeAttribute("style");
  }

  /* ---------------------------------------------------------------- clicking */

  const originalFor = (groupKey) =>
    [...document.querySelectorAll(`${HEADER_SELECTOR} ${MENU_ANCHOR_SELECTOR}`)].find(
      (anchor) => groupKeyOf(anchor) === groupKey,
    ) ?? null;

  async function findRealMenuAnchor(href) {
    const wanted = pathOf(href);
    for (let waited = 0; waited < CLICK_PROBE_TIMEOUT_MS; waited += POLL_MS) {
      await delay(POLL_MS);
      for (const anchor of openMenuAnchors()) {
        const candidate = anchor.getAttribute("href");
        if (candidate === href || pathOf(candidate) === wanted) return anchor;
      }
    }
    return null;
  }

  // Clones have no React Router binding, so a plain left click would force a
  // full page load. Drive Tulip's own link instead: re-open the source menu
  // (the original anchor is display:none, but synthetic events don't care) and
  // click the matching anchor inside it.
  async function routeThrough(clone) {
    const href = clone.getAttribute("href");
    const original = originalFor(clone.getAttribute(GROUP_ATTR));
    if (!original) {
      location.assign(href);
      return;
    }
    if (clone.hasAttribute(PARENT_ATTR)) {
      original.click();
      return;
    }
    ensureStyles(PROBE_STYLE_ID, PROBE_CSS);
    hoverIn(original);
    const target = await findRealMenuAnchor(href);
    if (target) target.click();
    else routeThroughMenus = false;
    hoverOut(original);
    // Leave the probe stylesheet up long enough for the menu to unmount, so the
    // click never leaves a stray dropdown on screen.
    setTimeout(() => removeStyles(PROBE_STYLE_ID), 300);
    if (!target) location.assign(href);
  }

  function onCloneClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!routeThroughMenus) return;
    event.preventDefault();
    void routeThrough(event.currentTarget);
  }

  /* ----------------------------------------------------------------- driving */

  function apply() {
    if (!enabled) return;
    const header = document.querySelector(HEADER_SELECTOR);
    if (!header) return;
    const anchors = [...header.querySelectorAll(MENU_ANCHOR_SELECTOR)];
    if (!anchors.length) return;

    const key = cacheKeyFor(anchors);
    if (key !== lastCacheKey) {
      lastCacheKey = key;
      harvestAttempts = 0;
      blocked = false;
    }

    captureTemplates(header);
    const groups = cachedGroupsFor(anchors);
    if (!groups) {
      if (blocked) return;
      void loadGroups(anchors).then((loaded) => {
        if (loaded) return apply();
        blocked = true;
        if (harvestAttempts < MAX_HARVEST_ATTEMPTS) {
          setTimeout(() => {
            blocked = false;
            apply();
          }, HARVEST_RETRY_MS);
        }
      });
      return;
    }

    // Links already in the bar win over anything a dropdown repeats.
    const taken = new Set();
    for (const anchor of header.querySelectorAll("a[href]")) {
      if (anchor.hasAttribute(CLONE_ATTR) || anchor.hasAttribute("aria-haspopup")) continue;
      taken.add(`p:${pathOf(anchor.getAttribute("href"))}`);
      taken.add(`l:${labelOf(anchor).toLowerCase()}`);
    }
    for (const anchor of anchors) {
      const group = groups.find((candidate) => candidate.key === groupKeyOf(anchor));
      if (group) renderGroup(anchor, group, taken);
    }
    refreshHighlight(header);
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  });

  function revert() {
    for (const clone of document.querySelectorAll(`[${CLONE_ATTR}]`)) clone.remove();
    for (const anchor of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
      anchor.removeAttribute(HIDDEN_ATTR);
      anchor.removeAttribute(RENDERED_ATTR);
    }
    removeStyles(STYLE_ID);
    removeStyles(PROBE_STYLE_ID);
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      enabled = true;
      harvestAttempts = 0;
      lastCacheKey = "";
      blocked = false;
      ensureStyles(STYLE_ID, HIDE_CSS);
      apply();
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("popstate", apply);
    },
    onDisable() {
      enabled = false;
      observer.disconnect();
      window.removeEventListener("popstate", apply);
      revert();
    },
  });
})();
