// Isolated-world half. The real work happens in
// `expression-editor-fuzzy-main.js` (loaded into the page's main world via
// the manifest's `world: "MAIN"` content_scripts entry), where React fiber
// expandos on DOM nodes are actually visible.
//
// This half:
//   * reads the feature toggle from chrome.storage,
//   * mirrors the toggle to `<html data-tulbelt-fuzzy-enabled="true|false">`,
//     which the main-world script watches via MutationObserver,
//   * keeps that attribute in sync as the toggle changes.

(() => {
const FEATURE_ID = 'expression-editor-fuzzy';
const STORAGE_KEY = 'toggles';
const ATTR = 'data-tulbelt-fuzzy-enabled';
const DEBUG = false;

function log(...args) {
  if (!DEBUG) return;
  try { console.log('[tulbelt:fuzzy]', ...args); } catch (_) {}
}

function setAttr(enabled) {
  try {
    document.documentElement.setAttribute(ATTR, enabled ? 'true' : 'false');
  } catch (_) {}
}

async function syncFromStorage() {
  let stored = {};
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    if (raw && typeof raw[STORAGE_KEY] === 'object') stored = raw[STORAGE_KEY];
  } catch (e) {
    log('storage read failed:', e?.message || e);
    return;
  }
  const next = stored[FEATURE_ID] ?? false;
  setAttr(next);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
