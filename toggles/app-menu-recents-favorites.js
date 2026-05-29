// Adds "Recents" and "Favorites" entries to the apps menu popper. The popper
// is portal-mounted lazily on open, so we watch document.body for the popper
// to appear and find the target <ul> by content (it contains an
// /apps/folders link). New items clone the last existing <li> to inherit
// Tulip's menu styling, and are tagged with a data attribute so disable can
// remove them cleanly.

(() => {
const FEATURE_ID = 'app-menu-recents-favorites';
const STORAGE_KEY = 'toggles';
const MARK = 'data-tulbelt-amrf';

let enabled = false;
let observer = null;

const ITEMS = [
  { label: 'Recents',   href: '/apps/folders?view=recents'   },
  { label: 'Favorites', href: '/apps/folders?view=favorites' },
];

const POPPER_SEL = '[data-testid="popper"], [x-attr-popper="popper"]';
const POPPER_UL_SEL = '[data-testid="popper"] ul, [x-attr-popper="popper"] ul';

function findTargetUl() {
  for (const ul of document.querySelectorAll(POPPER_UL_SEL)) {
    if (ul.querySelector('a[href*="/apps/folders"]')) return ul;
  }
  return null;
}

function isAlreadyInjected(ul) {
  return !!ul.querySelector('[' + MARK + ']');
}

function injectItems(ul) {
  const template = ul.lastElementChild;
  if (!template) return;
  for (const { label, href } of ITEMS) {
    const li = template.cloneNode(true);
    li.setAttribute(MARK, '1');
    const a = li.querySelector('a') || li;
    a.setAttribute('href', href);
    a.textContent = label;
    ul.appendChild(li);
  }
}

function removeInjections() {
  document.querySelectorAll('[' + MARK + ']').forEach((el) => el.remove());
}

function applyToPresent() {
  const ul = findTargetUl();
  if (!ul || isAlreadyInjected(ul)) return;
  injectItems(ul);
}

function onMutation(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches(POPPER_SEL) || node.querySelector(POPPER_SEL)) {
        applyToPresent();
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
    applyToPresent();
    startObserver();
  } else {
    stopObserver();
    removeInjections();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
