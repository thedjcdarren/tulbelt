// The trigger action-type picker (`select[data-testid$="action-editor"]`) lists
// every action alphabetically. This pins four frequent actions to the top of the
// list, with the rest following in their original order.
//
// The select is React-controlled, so we don't reorder its own nodes (React keeps
// re-rendering and scrambling our order back). Instead — the filters-builder.js
// pattern — we hide the real select and render a sibling proxy <select> we fully
// own. On change we forward the chosen value into the real select via the native
// value setter + a bubbling `change` event so React's onChange fires as usual.
// Frequent actions are matched by label text (option `value`s are random
// per-instance IDs).

(() => {
const FEATURE_ID = 'action-editor-frequent';
const STORAGE_KEY = 'toggles';

const SELECT_SEL = 'select[data-testid$="action-editor"]';
const PROXY_ATTR = 'data-tulbelt-frequent-proxy';
const HIDDEN_ATTR = 'data-tulbelt-frequent-hidden';
const STYLE_ID = 'tulbelt-frequent-actions-styles';

// Frequent action labels, in the order they should appear at the top.
const FREQUENT = [
  'Data Manipulation',
  'Table Records',
  'Run Function',
  'Run Connector Function',
];

let enabled = false;
let observer = null;
// real select -> { proxy, signature }. WeakMap so React-replaced selects are
// auto-collected; reset wholesale on disable.
let tracked = new WeakMap();

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `[${HIDDEN_ATTR}="true"] { display: none !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

// Drive React's onChange by going around the React-overridden value setter.
function setNativeSelectValue(select, value) {
  const proto = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  );
  proto.set.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

// A label-based signature of the real option set, to detect when React rebuilds
// the options (add/remove action types) and the proxy needs rebuilding.
function optionsSignature(select) {
  return Array.from(select.options)
    .map((o) => `${o.value}\u0000${o.textContent.trim()}`)
    .join('\u0001');
}

function cloneOption(opt) {
  const o = document.createElement('option');
  o.value = opt.value;
  o.textContent = opt.textContent;
  if (opt.disabled) o.disabled = true;
  return o;
}

function buildProxyOptions(proxy, real) {
  proxy.replaceChildren();
  const opts = Array.from(real.options);

  // First option with a given label wins for the frequent lookup.
  const byLabel = new Map();
  for (const o of opts) {
    const label = o.textContent.trim();
    if (!byLabel.has(label)) byLabel.set(label, o);
  }

  // The blank-label placeholder stays first so the unselected state works.
  const placeholder = opts.find((o) => o.textContent.trim() === '');

  const frequentOpts = [];
  for (const label of FREQUENT) {
    const o = byLabel.get(label);
    if (o) frequentOpts.push(o);
  }
  const frequentSet = new Set(frequentOpts);

  // Placeholder, then the frequent actions, then everything else in order.
  if (placeholder) proxy.appendChild(cloneOption(placeholder));
  for (const o of frequentOpts) proxy.appendChild(cloneOption(o));
  for (const o of opts) {
    if (o !== placeholder && !frequentSet.has(o)) {
      proxy.appendChild(cloneOption(o));
    }
  }

  proxy.value = real.value;
}

function hasFrequentOption(real) {
  return FREQUENT.some((label) =>
    Array.from(real.options).some((o) => o.textContent.trim() === label),
  );
}

function attach(real) {
  const existing = tracked.get(real);
  if (existing) {
    if (real.getAttribute(HIDDEN_ATTR) !== 'true') {
      real.setAttribute(HIDDEN_ATTR, 'true');
    }
    if (
      !existing.proxy.isConnected ||
      real.nextElementSibling !== existing.proxy
    ) {
      real.parentElement?.insertBefore(existing.proxy, real.nextSibling);
    }
    const sig = optionsSignature(real);
    if (existing.signature !== sig) {
      buildProxyOptions(existing.proxy, real);
      existing.signature = sig;
    } else if (existing.proxy.value !== real.value) {
      existing.proxy.value = real.value;
    }
    return;
  }

  if (!real.parentElement || !hasFrequentOption(real)) return;

  const proxy = document.createElement('select');
  proxy.setAttribute(PROXY_ATTR, '1');
  proxy.className = real.className;
  const aria = real.getAttribute('aria-label');
  if (aria) proxy.setAttribute('aria-label', aria);
  const inlineStyle = real.getAttribute('style');
  if (inlineStyle) proxy.setAttribute('style', inlineStyle);

  buildProxyOptions(proxy, real);
  proxy.addEventListener('change', () => {
    setNativeSelectValue(real, proxy.value);
  });

  real.parentElement.insertBefore(proxy, real.nextSibling);
  real.setAttribute(HIDDEN_ATTR, 'true');

  tracked.set(real, { proxy, signature: optionsSignature(real) });
}

function reconcile() {
  for (const real of document.querySelectorAll(SELECT_SEL)) {
    attach(real);
  }
}

function restoreAll() {
  document.querySelectorAll(`[${PROXY_ATTR}]`).forEach((el) => el.remove());
  document
    .querySelectorAll(`[${HIDDEN_ATTR}="true"]`)
    .forEach((el) => el.removeAttribute(HIDDEN_ATTR));
  tracked = new WeakMap();
}

function mutationTouchesTarget(node) {
  if (!(node instanceof Element)) return false;
  if (node.hasAttribute?.(PROXY_ATTR)) return false;
  return node.matches?.(SELECT_SEL) || !!node.querySelector?.(SELECT_SEL);
}

function onMutation(mutations) {
  let needsReconcile = false;
  for (const m of mutations) {
    // Ignore mutations inside our own proxy.
    if (m.target instanceof Element && m.target.closest?.(`[${PROXY_ATTR}]`)) {
      continue;
    }
    // Option set changed on a tracked real select.
    if (
      m.type === 'childList' &&
      m.target instanceof Element &&
      tracked.has(m.target)
    ) {
      needsReconcile = true;
    }
    for (const node of m.addedNodes) {
      if (mutationTouchesTarget(node)) needsReconcile = true;
    }
    for (const node of m.removedNodes) {
      if (node instanceof Element && tracked.has(node)) {
        tracked.get(node)?.proxy.remove();
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
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

async function syncFromStorage() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
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
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
