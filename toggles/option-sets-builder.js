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
//
// The page itself is the Option Sets builder: named sets of typed options
// (text / integer / number), ordered, each with an optional description,
// persisted to the tenant origin's localStorage under `tulbelt-option-sets`.
// Values are stored as strings; the data type governs the input widget and
// validation, never silent coercion.

(() => {
  const FEATURE_ID = "option-sets-builder";
  const STORAGE_KEY = "toggles";
  const FAKE_PATH = "/account/option-sets";
  const LI_ATTR = "data-tulbelt-osb-item";
  const HIDDEN_ATTR = "data-tulbelt-osb-hidden";
  const STYLE_ID = "tulbelt-osb-styles";
  const CONTAINER_ID = "tulbelt-osb-page";
  const LS_KEY = "tulbelt-option-sets";

  const DATA_TYPES = [
    { id: "text", label: "Text" },
    { id: "integer", label: "Integer" },
    { id: "number", label: "Number" },
  ];

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

  // ── Option set data (tenant-origin localStorage) ────────────────────────────

  let data = null;
  let storageError = "";
  // UI state survives navigating away and back within the tab.
  const ui = { selectedId: null, creating: false, confirmDelete: false, focus: null };

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function loadData() {
    storageError = "";
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { version: 1, sets: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.sets)) return { version: 1, sets: [] };
      return parsed;
    } catch (err) {
      storageError = `Couldn't read saved option sets (${err.message}). Starting empty — saving will overwrite.`;
      return { version: 1, sets: [] };
    }
  }

  function saveData() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
      if (storageError) {
        storageError = "";
        renderBanner();
      }
    } catch (err) {
      storageError = `Couldn't save option sets: ${err.message}`;
      renderBanner();
    }
  }

  function selectedSet() {
    return data.sets.find((s) => s.id === ui.selectedId) || null;
  }

  function touch(set) {
    set.updatedAt = Date.now();
    saveData();
  }

  function valueInvalid(type, raw) {
    const s = String(raw).trim();
    if (s === "") return true;
    if (type === "integer") return !/^-?\d+$/.test(s);
    if (type === "number") return !Number.isFinite(Number(s));
    return false;
  }

  // ── Builder UI ──────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function typeLabel(id) {
    return DATA_TYPES.find((t) => t.id === id)?.label || id;
  }

  function renderBanner() {
    const banner = document.querySelector(`#${CONTAINER_ID} .osb-banner`);
    if (!banner) return;
    banner.textContent = storageError;
    banner.style.display = storageError ? "" : "none";
  }

  function render() {
    const root = document.querySelector(`#${CONTAINER_ID} .osb-root`);
    if (!root) return;
    root.textContent = "";

    const banner = el("div", "osb-banner");
    banner.style.display = storageError ? "" : "none";
    banner.textContent = storageError;
    root.appendChild(banner);

    const layout = el("div", "osb-layout");
    layout.appendChild(renderListPanel());
    layout.appendChild(renderEditorPanel());
    root.appendChild(layout);

    // Focus requested by the action that triggered this render (add option,
    // create set, …).
    if (ui.focus) {
      root.querySelector(ui.focus)?.focus();
      ui.focus = null;
    }
  }

  function renderListPanel() {
    const panel = el("aside", "osb-list");
    const newBtn = el("button", "osb-btn osb-btn-primary", "+ New option set");
    newBtn.type = "button";
    newBtn.addEventListener("click", () => {
      ui.creating = true;
      ui.selectedId = null;
      ui.confirmDelete = false;
      ui.focus = ".osb-create-name";
      render();
    });
    panel.appendChild(newBtn);

    if (data.sets.length === 0) {
      panel.appendChild(el("p", "osb-hint", "No option sets yet."));
      return panel;
    }

    const list = el("div", "osb-set-list");
    for (const set of data.sets) {
      const row = el("button", "osb-set-row" + (set.id === ui.selectedId ? " osb-selected" : ""));
      row.type = "button";
      const name = el("span", "osb-set-name", set.name || "(unnamed)");
      name.dataset.nameFor = set.id;
      row.appendChild(name);
      const meta = el("span", "osb-set-meta");
      meta.appendChild(el("span", "osb-badge", typeLabel(set.dataType)));
      meta.appendChild(el("span", "", `${set.options.length} option${set.options.length === 1 ? "" : "s"}`));
      row.appendChild(meta);
      row.addEventListener("click", () => {
        ui.selectedId = set.id;
        ui.creating = false;
        ui.confirmDelete = false;
        render();
      });
      list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
  }

  function renderEditorPanel() {
    const panel = el("section", "osb-editor");
    if (ui.creating) {
      panel.appendChild(renderCreateForm());
    } else {
      const set = selectedSet();
      if (set) panel.appendChild(renderSetEditor(set));
      else {
        panel.appendChild(
          el(
            "p",
            "osb-hint",
            data.sets.length
              ? "Select an option set on the left, or create a new one."
              : "Create your first option set to get started. Option sets are stored in this browser for this Tulip instance only."
          )
        );
      }
    }
    return panel;
  }

  function renderCreateForm() {
    const form = el("div", "osb-create");
    form.appendChild(el("h2", "", "New option set"));

    const nameLabel = el("label", "osb-field");
    nameLabel.appendChild(el("span", "osb-field-label", "Name"));
    const nameInput = el("input", "osb-input osb-create-name");
    nameInput.type = "text";
    nameInput.placeholder = "e.g. Defect Types";
    nameLabel.appendChild(nameInput);
    form.appendChild(nameLabel);

    const typeLabelEl = el("label", "osb-field");
    typeLabelEl.appendChild(el("span", "osb-field-label", "Data type"));
    const select = el("select", "osb-input");
    for (const t of DATA_TYPES) {
      const opt = el("option", "", t.label);
      opt.value = t.id;
      select.appendChild(opt);
    }
    typeLabelEl.appendChild(select);
    form.appendChild(typeLabelEl);
    form.appendChild(el("p", "osb-hint", "The data type is fixed once the set is created."));

    const actions = el("div", "osb-actions");
    const create = el("button", "osb-btn osb-btn-primary", "Create");
    create.type = "button";
    create.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.classList.add("osb-invalid");
        nameInput.focus();
        return;
      }
      const set = {
        id: newId("os"),
        name,
        description: "",
        dataType: select.value,
        options: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      data.sets.push(set);
      saveData();
      ui.creating = false;
      ui.selectedId = set.id;
      render();
    });
    const cancel = el("button", "osb-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      ui.creating = false;
      render();
    });
    actions.appendChild(create);
    actions.appendChild(cancel);
    form.appendChild(actions);
    return form;
  }

  function renderSetEditor(set) {
    const wrap = el("div", "osb-set-editor");

    // Header: name, type badge, delete with inline confirm.
    const header = el("div", "osb-editor-header");
    const nameInput = el("input", "osb-input osb-editor-name" + (set.name.trim() ? "" : " osb-invalid"));
    nameInput.type = "text";
    nameInput.value = set.name;
    nameInput.placeholder = "Option set name";
    nameInput.addEventListener("input", () => {
      set.name = nameInput.value;
      nameInput.classList.toggle("osb-invalid", !set.name.trim());
      const listName = document.querySelector(`[data-name-for="${set.id}"]`);
      if (listName) listName.textContent = set.name || "(unnamed)";
      touch(set);
    });
    header.appendChild(nameInput);
    header.appendChild(el("span", "osb-badge", typeLabel(set.dataType)));

    const del = el("div", "osb-delete");
    if (ui.confirmDelete) {
      del.appendChild(el("span", "", "Delete this set?"));
      const yes = el("button", "osb-btn osb-btn-danger", "Yes");
      yes.type = "button";
      yes.addEventListener("click", () => {
        data.sets = data.sets.filter((s) => s.id !== set.id);
        saveData();
        ui.selectedId = null;
        ui.confirmDelete = false;
        render();
      });
      const no = el("button", "osb-btn", "No");
      no.type = "button";
      no.addEventListener("click", () => {
        ui.confirmDelete = false;
        render();
      });
      del.appendChild(yes);
      del.appendChild(no);
    } else {
      const btn = el("button", "osb-btn", "Delete set");
      btn.type = "button";
      btn.addEventListener("click", () => {
        ui.confirmDelete = true;
        render();
      });
      del.appendChild(btn);
    }
    header.appendChild(del);
    wrap.appendChild(header);

    const desc = el("textarea", "osb-input osb-desc");
    desc.rows = 2;
    desc.placeholder = "Description (optional)";
    desc.value = set.description || "";
    desc.addEventListener("input", () => {
      set.description = desc.value;
      touch(set);
    });
    wrap.appendChild(desc);

    // Options.
    wrap.appendChild(el("h3", "osb-options-title", "Options"));
    if (set.options.length === 0) {
      wrap.appendChild(el("p", "osb-hint", "No options yet — add the first one."));
    } else {
      const list = el("div", "osb-options");
      set.options.forEach((option, index) => list.appendChild(renderOptionRow(set, option, index)));
      wrap.appendChild(list);
    }

    const add = el("button", "osb-btn osb-btn-primary", "+ Add option");
    add.type = "button";
    add.addEventListener("click", () => {
      const option = { id: newId("op"), value: "", description: "" };
      set.options.push(option);
      touch(set);
      ui.focus = `[data-opt-value="${option.id}"]`;
      render();
    });
    wrap.appendChild(add);
    return wrap;
  }

  function renderOptionRow(set, option, index) {
    const row = el("div", "osb-option-row");

    const move = el("div", "osb-move");
    const up = el("button", "osb-btn osb-btn-icon", "▲");
    up.type = "button";
    up.disabled = index === 0;
    up.title = "Move up";
    const down = el("button", "osb-btn osb-btn-icon", "▼");
    down.type = "button";
    down.disabled = index === set.options.length - 1;
    down.title = "Move down";
    const swap = (delta) => {
      const target = index + delta;
      [set.options[index], set.options[target]] = [set.options[target], set.options[index]];
      touch(set);
      render();
    };
    up.addEventListener("click", () => swap(-1));
    down.addEventListener("click", () => swap(1));
    move.appendChild(up);
    move.appendChild(down);
    row.appendChild(move);

    const value = el(
      "input",
      "osb-input osb-opt-value" + (valueInvalid(set.dataType, option.value) ? " osb-invalid" : "")
    );
    value.dataset.optValue = option.id;
    if (set.dataType === "integer") {
      value.type = "number";
      value.step = "1";
    } else if (set.dataType === "number") {
      value.type = "number";
      value.step = "any";
    } else {
      value.type = "text";
    }
    value.placeholder = "Value";
    value.value = option.value;
    value.addEventListener("input", () => {
      option.value = value.value;
      value.classList.toggle("osb-invalid", valueInvalid(set.dataType, option.value));
      touch(set);
    });
    row.appendChild(value);

    const desc = el("input", "osb-input osb-opt-desc");
    desc.type = "text";
    desc.placeholder = "Description (optional)";
    desc.value = option.description || "";
    desc.addEventListener("input", () => {
      option.description = desc.value;
      touch(set);
    });
    row.appendChild(desc);

    const remove = el("button", "osb-btn osb-btn-icon", "✕");
    remove.type = "button";
    remove.title = "Remove option";
    remove.addEventListener("click", () => {
      set.options = set.options.filter((o) => o.id !== option.id);
      touch(set);
      render();
    });
    row.appendChild(remove);
    return row;
  }

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
      #${CONTAINER_ID} h2 { font-size: 1.15em; margin: 0 0 12px; }
      #${CONTAINER_ID} .osb-banner { background: #fdecea; color: #b3261e; border: 1px solid #f5c6c2; border-radius: 4px; padding: 8px 12px; margin-bottom: 12px; }
      #${CONTAINER_ID} .osb-layout { display: flex; gap: 24px; align-items: flex-start; }
      #${CONTAINER_ID} .osb-list { flex: 0 0 240px; display: flex; flex-direction: column; gap: 8px; }
      #${CONTAINER_ID} .osb-set-list { display: flex; flex-direction: column; gap: 4px; }
      #${CONTAINER_ID} .osb-set-row { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px; border: 1px solid #d5dae2; border-radius: 6px; background: #fff; cursor: pointer; font: inherit; }
      #${CONTAINER_ID} .osb-set-row:hover { border-color: #1c69e1; }
      #${CONTAINER_ID} .osb-set-row.osb-selected { border-color: #1c69e1; background: #eef4fd; }
      #${CONTAINER_ID} .osb-set-name { font-weight: 600; }
      #${CONTAINER_ID} .osb-set-meta { display: flex; gap: 8px; align-items: center; color: #788293; font-size: 0.85em; }
      #${CONTAINER_ID} .osb-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; background: #e8edf5; color: #45526b; font-size: 0.8em; white-space: nowrap; }
      #${CONTAINER_ID} .osb-editor { flex: 1 1 auto; min-width: 0; max-width: 720px; }
      #${CONTAINER_ID} .osb-hint { color: #788293; margin: 8px 0; }
      #${CONTAINER_ID} .osb-input { font: inherit; padding: 6px 8px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; }
      #${CONTAINER_ID} .osb-input:focus { outline: none; border-color: #1c69e1; }
      #${CONTAINER_ID} .osb-input.osb-invalid { border-color: #b3261e; }
      #${CONTAINER_ID} .osb-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; max-width: 320px; }
      #${CONTAINER_ID} .osb-field-label { font-weight: 600; font-size: 0.9em; }
      #${CONTAINER_ID} .osb-actions { display: flex; gap: 8px; margin-top: 8px; }
      #${CONTAINER_ID} .osb-btn { font: inherit; padding: 6px 12px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; cursor: pointer; }
      #${CONTAINER_ID} .osb-btn:hover:not(:disabled) { border-color: #1c69e1; }
      #${CONTAINER_ID} .osb-btn:disabled { opacity: 0.4; cursor: default; }
      #${CONTAINER_ID} .osb-btn-primary { background: #1c69e1; border-color: #1c69e1; color: #fff; }
      #${CONTAINER_ID} .osb-btn-danger { background: #b3261e; border-color: #b3261e; color: #fff; }
      #${CONTAINER_ID} .osb-btn-icon { padding: 2px 8px; line-height: 1.2; }
      #${CONTAINER_ID} .osb-editor-header { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
      #${CONTAINER_ID} .osb-editor-name { flex: 1 1 auto; min-width: 0; font-weight: 600; }
      #${CONTAINER_ID} .osb-delete { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
      #${CONTAINER_ID} .osb-desc { width: 100%; box-sizing: border-box; resize: vertical; margin-bottom: 8px; }
      #${CONTAINER_ID} .osb-options-title { font-size: 1em; margin: 12px 0 6px; }
      #${CONTAINER_ID} .osb-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      #${CONTAINER_ID} .osb-option-row { display: flex; gap: 8px; align-items: center; }
      #${CONTAINER_ID} .osb-move { display: flex; flex-direction: column; gap: 2px; }
      #${CONTAINER_ID} .osb-move .osb-btn-icon { padding: 0 6px; font-size: 0.7em; }
      #${CONTAINER_ID} .osb-opt-value { flex: 0 1 200px; min-width: 100px; }
      #${CONTAINER_ID} .osb-opt-desc { flex: 1 1 auto; min-width: 0; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildContainer() {
    const container = document.createElement("div");
    container.id = CONTAINER_ID;
    const title = el("h1", "", "Option Sets");
    container.appendChild(title);
    container.appendChild(el("div", "osb-root"));
    // Reload from localStorage on every activation so edits from another tab
    // on this tenant show up after navigating away and back.
    data = loadData();
    return container;
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
      if (!document.getElementById(CONTAINER_ID)) {
        parent.appendChild(buildContainer());
        render();
      }
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
