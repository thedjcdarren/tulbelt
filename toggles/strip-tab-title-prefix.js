// Strips the leading "Tulip | " from the tab title. Tulip sets
// `document.title` on every SPA navigation, so we watch the <title> element
// for text changes and rewrite each new value. The most recently observed
// un-stripped title is cached so disabling the toggle can put it back.

(() => {
  const FEATURE_ID = "strip-tab-title-prefix";
  const STORAGE_KEY = "toggles";
  const PREFIX = "Tulip | ";

  let enabled = false;
  let titleObserver = null;
  let headObserver = null;
  let lastOriginalTitle = null;

  function stripIfNeeded() {
    const title = document.title;
    if (title.startsWith(PREFIX)) {
      lastOriginalTitle = title;
      document.title = title.slice(PREFIX.length);
    }
  }

  function observeTitleEl(titleEl) {
    titleObserver = new MutationObserver(stripIfNeeded);
    titleObserver.observe(titleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    stripIfNeeded();
  }

  function startObserver() {
    if (titleObserver || headObserver) return;
    const titleEl = document.querySelector("title");
    if (titleEl) {
      observeTitleEl(titleEl);
      return;
    }
    // <title> not in the document yet; wait for it.
    headObserver = new MutationObserver(() => {
      const t = document.querySelector("title");
      if (!t) return;
      headObserver.disconnect();
      headObserver = null;
      observeTitleEl(t);
    });
    headObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function stopObserver() {
    titleObserver?.disconnect();
    titleObserver = null;
    headObserver?.disconnect();
    headObserver = null;
  }

  function restore() {
    if (lastOriginalTitle !== null && !document.title.startsWith(PREFIX)) {
      document.title = lastOriginalTitle;
    }
  }

  async function syncFromStorage() {
    const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
    const next = stored[FEATURE_ID] === true;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      startObserver();
    } else {
      stopObserver();
      restore();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
