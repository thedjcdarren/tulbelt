// Isolated-world half. The real work happens in
// `app-list-date-columns-main.js` (loaded into the page's main world via the
// manifest's `world: "MAIN"` content_scripts entry), where the page's own
// `fetch`/XHR responses — which carry the apps' created/last-completed dates —
// are actually visible.
//
// This half:
//   * reads the feature toggle from chrome.storage,
//   * mirrors the toggle to `<html data-tulbelt-app-dates-enabled="true|false">`,
//     which the main-world script watches via MutationObserver,
//   * keeps that attribute in sync as the toggle changes.

(() => {
const FEATURE_ID = 'app-list-date-columns';
const STORAGE_KEY = 'toggles';
const ATTR = 'data-tulbelt-app-dates-enabled';

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
  } catch (_) {
    return;
  }
  setAttr(stored[FEATURE_ID] === true);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
