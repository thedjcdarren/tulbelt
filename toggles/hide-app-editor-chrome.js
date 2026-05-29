// Hides editor chrome only on app version editor URLs (`/w/…/apps/…/versions/…` or `/apps/…/versions/…`):
// `[data-testid="tulip-header"]`, subheader row, and Add/Icons palette strip.

(() => {
const FEATURE_ID = 'hide-app-editor-chrome';
const STORAGE_KEY = 'toggles';
const STYLE_ID = 'tulbelt-hide-app-editor-chrome-styles';
const MARK = 'data-tulbelt-hide-app-editor-chrome';
/** App version editor: /w/<ws>/apps/<appId>/versions/<versionId> or /apps/<appId>/versions/<versionId> */
const APP_EDITOR_PATH_RE = /^(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\/[^/]+/;

let enabled = false;
let observer = null;

function isAppEditorUrl() {
  return APP_EDITOR_PATH_RE.test(location.pathname || '');
}

function installHistoryLocationHooks() {
  window.addEventListener('popstate', () => queueMicrotask(onLocationMaybeChanged));
  window.addEventListener('tulbelt:navigate', () => queueMicrotask(onLocationMaybeChanged));
  if (window.__tulbeltHistoryHooked) return;
  window.__tulbeltHistoryHooked = true;
  const { pushState, replaceState } = history;
  history.pushState = function patchedPushState(...args) {
    const r = pushState.apply(this, args);
    window.dispatchEvent(new CustomEvent('tulbelt:navigate'));
    return r;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const r = replaceState.apply(this, args);
    window.dispatchEvent(new CustomEvent('tulbelt:navigate'));
    return r;
  };
}

installHistoryLocationHooks();

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `[${MARK}="true"] { display: none !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

function markSubheaderRow() {
  const subheader = document.querySelector('[data-testid="subheader"]');
  const row = subheader?.parentElement;
  if (!row || row === document.body || row === document.documentElement) return;
  // Same row also mounts Run/Publish; avoids hiding unrelated subheaders.
  if (!row.querySelector('#app-editor-publish')) return;
  row.setAttribute(MARK, 'true');
}

function markPaletteRow() {
  const add = document.querySelector('#app-editor-add');
  const row = add?.parentElement;
  if (!row || row === document.body || row === document.documentElement) return;
  if (!row.querySelector('#app-editor-icons')) return;
  row.setAttribute(MARK, 'true');
}

function markTulipHeader() {
  const header = document.querySelector('[data-testid="tulip-header"]');
  if (!header) return;
  header.setAttribute(MARK, 'true');
}

function applyAll() {
  if (!isAppEditorUrl()) {
    restoreAll();
    return;
  }
  markTulipHeader();
  markSubheaderRow();
  markPaletteRow();
}

function onLocationMaybeChanged() {
  if (!enabled) return;
  applyAll();
}

function restoreAll() {
  for (const el of document.querySelectorAll(`[${MARK}="true"]`)) {
    el.removeAttribute(MARK);
  }
}

function touchesTarget(node) {
  if (!(node instanceof Element)) return false;
  const sel = [
    '[data-testid="tulip-header"]',
    '[data-testid="subheader"]',
    '#app-editor-add',
    '#app-editor-publish',
    '#app-editor-icons',
  ];
  for (const s of sel) {
    if (node.matches?.(s) || node.querySelector?.(s)) return true;
  }
  return false;
}

function onMutation(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (touchesTarget(node)) {
        applyAll();
        return;
      }
    }
  }
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
    applyAll();
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
