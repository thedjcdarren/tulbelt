// In the app editor, snap a widget's position/size to a grid of 5 when a drag
// or resize ends. Tulip owns the drag entirely; we only write the snapped value
// back afterward.
//
// Widget position/size lives in Tulip's React state (painted as a transform
// matrix), so poking the DOM transform is clobbered on re-render and never
// persists. Instead we write through the context-pane number inputs Tulip
// already renders for the selected widget — the action-editor-frequent.js
// pattern: native value setter + bubbling input/change so React's onChange runs.
//
// Only fields that actually changed during the interaction are snapped, so a
// move never touches size and manual typing in the fields is never overridden.
//
// Node-shape checks use nodeType/tagName (not instanceof) and we scan reachable
// frames, since the canvas/context pane may live in a subframe (different realm
// = different constructors).

(() => {
const FEATURE_ID = 'snap-to-grid';
const STORAGE_KEY = 'toggles';
const GRID = 5;
const EPSILON = 0.001;

const INPUT_TESTIDS = {
  x: 'context-pane-tool-position-x',
  y: 'context-pane-tool-position-y',
  w: 'context-pane-tool-size-w',
  h: 'context-pane-tool-size-h',
};

const DEBUG = false;
function log(...args) {
  if (!DEBUG) return;
  try {
    console.log('[tulbelt:snap]', location.host + location.pathname, ...args);
  } catch (_) {}
}

let enabled = false;
let armed = false;
/** @type {{x:number|null,y:number|null,w:number|null,h:number|null}|null} */
let before = null;
/** @type {Document[]} */
let hookedDocs = [];
let sweepHandle = null;

// ---------- reachable documents (cross-frame) ----------
function documentsToScan() {
  /** @type {Document[]} */
  const out = [];
  const seen = new Set();
  const add = (d) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    out.push(d);
  };

  add(document);

  try {
    let w = window;
    for (let i = 0; i < 32 && w && w.parent && w !== w.parent; i++) {
      try {
        w = w.parent;
        add(w.document);
      } catch (_) {
        break;
      }
    }
  } catch (_) {}

  try {
    add(window.top.document);
  } catch (_) {}

  function descend(w) {
    try {
      for (let i = 0; i < w.frames.length; i++) {
        try {
          const fw = w.frames[i];
          add(fw.document);
          descend(fw);
        } catch (_) {}
      }
    } catch (_) {}
  }
  try { descend(window.top); } catch (_) { try { descend(window); } catch (_) {} }

  return out;
}

// ---------- scope ----------
// App version editor pages only: /w/<ws>/apps/<id>/versions/... or
// /apps/<id>/versions/...
const EDITOR_PATH = /(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\//;
function pathMatches() {
  try {
    return EDITOR_PATH.test(location.pathname);
  } catch (_) {
    return false;
  }
}

// ---------- input lookup / read / write ----------
function findInput(testid) {
  for (const doc of documentsToScan()) {
    try {
      const el = doc.querySelector('input[data-testid="' + testid + '"]');
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

function readNumber(testid) {
  const el = findInput(testid);
  if (!el) return null;
  const n = parseFloat(el.value);
  return Number.isFinite(n) ? n : null;
}

function readPlacement() {
  return {
    x: readNumber(INPUT_TESTIDS.x),
    y: readNumber(INPUT_TESTIDS.y),
    w: readNumber(INPUT_TESTIDS.w),
    h: readNumber(INPUT_TESTIDS.h),
  };
}

function snapValue(v) {
  return Math.round(v / GRID) * GRID;
}

// React-friendly write: go around React's overridden value setter, using the
// input's own window prototype so it works across realms (subframes).
function setInputValue(input, value) {
  try {
    const view = input.ownerDocument?.defaultView || window;
    const proto = view.HTMLInputElement?.prototype || HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(input, String(value));
    } else {
      input.value = String(value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    log('setInputValue failed', e?.message || e);
  }
}

function snapField(testid, beforeVal, afterVal) {
  if (beforeVal === null || afterVal === null) return;
  if (Math.abs(afterVal - beforeVal) <= EPSILON) return; // unchanged this drag
  const snapped = snapValue(afterVal);
  if (Math.abs(snapped - afterVal) <= EPSILON) return; // already on grid
  const el = findInput(testid);
  if (!el) return;
  log('snap', testid, afterVal, '->', snapped);
  setInputValue(el, snapped);
}

// ---------- gesture handling ----------
function withinCanvas(target) {
  if (!target || typeof target !== 'object' || target.nodeType !== 1) {
    return false;
  }
  try {
    return !!(
      target.closest?.('#cssCanvas') ||
      target.closest?.('[data-testid="widget"]')
    );
  } catch (_) {
    return false;
  }
}

function onPointerDown(e) {
  if (!enabled || !pathMatches()) return;
  if (e.button !== 0) return; // primary button only
  if (!withinCanvas(e.target)) return;
  armed = true;
  before = readPlacement();
  log('armed', before);
}

function onPointerUp() {
  if (!armed) return;
  armed = false;
  const start = before;
  before = null;
  if (!start) return;
  // Let Tulip commit the final drag/resize values before reading.
  requestAnimationFrame(() => {
    const after = readPlacement();
    snapField(INPUT_TESTIDS.x, start.x, after.x);
    snapField(INPUT_TESTIDS.y, start.y, after.y);
    snapField(INPUT_TESTIDS.w, start.w, after.w);
    snapField(INPUT_TESTIDS.h, start.h, after.h);
  });
}

function installHooksOn(doc) {
  if (!doc || hookedDocs.includes(doc)) return;
  try {
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    hookedDocs.push(doc);
    log('hooks attached', doc.location?.href || '(doc)');
  } catch (e) {
    log('install hooks failed', e?.message || e);
  }
}

function installHooks() {
  for (const doc of documentsToScan()) installHooksOn(doc);
}

function removeHooks() {
  for (const doc of hookedDocs) {
    try {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('pointerup', onPointerUp, true);
    } catch (_) {}
  }
  hookedDocs = [];
  armed = false;
  before = null;
}

// ---------- toggle ----------
async function syncFromStorage() {
  let stored = {};
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    if (raw[STORAGE_KEY] && typeof raw[STORAGE_KEY] === 'object') {
      stored = raw[STORAGE_KEY];
    }
  } catch (e) {
    log('storage read failed', e?.message || e);
  }
  const next = stored[FEATURE_ID] === true;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    installHooks();
    // Reach frames that mount after enable.
    sweepHandle = setInterval(installHooks, 1500);
  } else {
    if (sweepHandle) { clearInterval(sweepHandle); sweepHandle = null; }
    removeHooks();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
