// Adds "Recents" and "Favorites" entries to the apps menu popper. The popper
// is portal-mounted lazily on open, so we watch document.body for the popper
// to appear and find the target <ul> by content (it contains an
// /apps/folders link). New items clone a native <li> to inherit Tulip's menu
// styling, and are tagged with a data attribute so disable can remove them
// cleanly.

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

function findTemplateLi(ul) {
  const items = [...ul.children].filter(
    (el) => el.tagName === 'LI' && !el.hasAttribute(MARK),
  );
  if (!items.length) return null;
  // Prefer a middle native row — the last item is often hovered when the menu
  // opens, and cloning it copies styled-components' active/hover classes.
  return items[Math.min(1, items.length - 1)];
}

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
  const template = findTemplateLi(ul);
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

function mutationTouchesAppMenu(mutation) {
  const target = mutation.target;
  if (target instanceof Element && target.closest(POPPER_SEL)) return true;
  for (const node of mutation.addedNodes) {
    if (!(node instanceof Element)) continue;
    // Match the popper itself, a wrapper containing it, OR a node added
    // inside an existing popper — menu items often stream in after the popper
    // shell mounts, and Tulip reuses the same popper across open/close while
    // React remounts the list.
    if (
      node.matches(POPPER_SEL) ||
      node.querySelector(POPPER_SEL) ||
      node.closest(POPPER_SEL)
    ) {
      return true;
    }
  }
  return false;
}

function onMutation(mutations) {
  for (const m of mutations) {
    if (mutationTouchesAppMenu(m)) {
      applyToPresent();
      return;
    }
  }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
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
