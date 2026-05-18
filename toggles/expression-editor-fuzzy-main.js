// Main-world half of the fuzzy-search feature.
//
// Lives in `world: "MAIN"` so React fiber expando properties (`__reactFiber$…`,
// `__reactProps$…`) on DOM nodes are visible. From an isolated content-script
// world Chrome's expando bridge often returns nothing, which is why the
// previous incarnation kept failing with "no fiber on list element".
//
// Enable/disable is signalled by the isolated half via the `data-tulbelt-
// fuzzy-enabled` attribute on `<html>` (no chrome.* APIs in main world).

(() => {
const ATTR = 'data-tulbelt-fuzzy-enabled';
const STYLE_ID = 'tulbelt-fuzzy-styles';
const HIDE_REACT_LIST_ATTR = 'data-tulbelt-fuzzy-hide-react-list';
const OVERLAY_CLASS = 'tulbelt-fuzzy-overlay';
const ROW_CLASS = 'tulbelt-fuzzy-row';
const SELECTED_CLASS = 'tulbelt-fuzzy-row--selected';
const EMPTY_CLASS = 'tulbelt-fuzzy-empty';
const MAX_RESULTS = 200;
let traceSelect = false;

// Hard-filter: any item whose label starts with one of these prefixes
// (case-insensitive) is hidden from the overlay entirely. These are
// Tulip categories the user has flagged as "never useful" — surfacing
// them only crowds out the real results. Case-insensitive comparison
// keeps it forgiving against Tulip's label casing changing over time.
const HIDDEN_LABEL_PREFIXES = [
  '@Users',
  '@User Groups',
  '@Machine Activity Field',
  '@Last Machine Output',
].map((s) => s.toLowerCase());

const DEBUG = false;

function log(...args) {
  if (!DEBUG && !traceSelect && !observing) return;
  try { console.log('[tulbelt:fuzzy:main]', ...args); } catch (_) {}
}

const POPPER_SEL = '[data-testid="popper"]';
const EDITOR_SEL = '[data-testid="expression-editor-input"]';
const LIST_SEL = '.ReactVirtualized__List';

let enabled = false;
let docObserver = null;
let pendingScan = false;
const popperState = new WeakMap();

// ---------- React fiber access ----------
// React's fiber expando key varies:
//   * React 16/17/18 — `__reactFiber$<rand>` (host) / `__reactContainer$<rand>` (root)
//   * React 15-      — `__reactInternalInstance$<rand>`
// Use `getOwnPropertyNames` rather than `Object.keys` so non-enumerable
// expandos (which some bundlers / dev-tool patches produce) are still found.
const FIBER_PREFIXES = [
  '__reactFiber$',
  '__reactInternalInstance$',
  '__reactContainer$',
];
function fiberOf(node) {
  if (!node) return null;
  let keys;
  try { keys = Object.getOwnPropertyNames(node); } catch (_) { return null; }
  for (const k of keys) {
    for (const prefix of FIBER_PREFIXES) {
      if (k.startsWith(prefix)) {
        const v = node[k];
        if (v) return v;
      }
    }
  }
  return null;
}

// Climb to the nearest ancestor (or self) that has a fiber. The
// `.ReactVirtualized__List` element is from a wrapper component; in some
// build configurations the fiber lives on a parent host element instead.
function fiberOfNearestHost(node) {
  let n = node;
  let i = 0;
  while (n && i++ < 6) {
    const f = fiberOf(n);
    if (f) return { fiber: f, host: n };
    n = n.parentElement;
  }
  return null;
}

// Diagnostic — dump every expando-looking key on the node so we can see
// what React (if any) is actually attaching.
function reactKeysOn(node) {
  if (!node) return [];
  let keys;
  try { keys = Object.getOwnPropertyNames(node); } catch (_) { return []; }
  return keys.filter((k) => k.startsWith('__'));
}

function* walkUp(fiber) {
  let f = fiber;
  for (let i = 0; f && i < 200; i++) {
    yield f;
    f = f.return;
  }
}

// Descend into a fiber's children/siblings up to `maxDepth` levels.
// Sibling traversal stays at the same depth; child traversal increments.
function* walkDown(fiber, maxDepth = 4) {
  if (!fiber) return;
  function* recurse(f, depth) {
    if (!f) return;
    yield f;
    if (depth >= maxDepth) return;
    if (f.child) yield* recurse(f.child, depth + 1);
    if (f.sibling) yield* recurse(f.sibling, depth);
  }
  if (fiber.child) yield* recurse(fiber.child, 1);
}

function arrayLooksLikeOptions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0];
  if (typeof first === 'string') return true;
  if (typeof first !== 'object' || first === null) return false;
  for (const k of ['label', 'displayName', 'display', 'name', 'text', 'value', 'path']) {
    if (typeof first[k] === 'string') return true;
  }
  return false;
}

function arrayHasIndexes(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0];
  return (
    !!first &&
    typeof first === 'object' &&
    !!first.indexes &&
    typeof first.indexes === 'object' &&
    typeof first.indexes.start === 'number' &&
    typeof first.indexes.end === 'number'
  );
}

// Walk the fiber chain (up + a few levels down at each ancestor) and
// collect every options-shaped array we can see. We surface:
//
//   * master — LARGEST options array. Tulip's full ~31k catalog.
//   * indexed — preferred: array whose items have `.indexes` already
//     attached. (Empirically Tulip does NOT pre-inject indexes, so this is
//     usually null. Kept for forward-compat.) Fallback: the smallest
//     non-master options array, which is our best heuristic for Tulip's
//     currently-visible, context-filtered list.
//   * all — every option-array we found, with fiber + source key, so the
//     debug API can dump them for inspection.
//
// Both master + indexed are returned with their `{fiber, key}` so callers
// can cheaply re-read the live value each render (Tulip's immutable
// updates change the array reference at every keystroke).
function findLists(startFiber) {
  const all = [];
  const seenFibers = new Set();
  const consider = (v, fiber, key) => {
    if (!arrayLooksLikeOptions(v)) return;
    all.push({ list: v, fiber, key });
  };
  const examine = (f) => {
    if (!f || seenFibers.has(f)) return;
    seenFibers.add(f);
    const props = f.memoizedProps;
    if (props && typeof props === 'object') {
      for (const k of Object.keys(props)) {
        consider(props[k], f, { kind: 'props', name: k });
      }
    }
    let hook = f.memoizedState;
    for (let depth = 0; hook && depth < 50; depth++) {
      const v = hook.memoizedState;
      consider(v, f, { kind: 'hook', name: `state[${depth}]` });
      // useMemo / useCallback / etc. store `[value, deps]`; check the value too.
      if (Array.isArray(v) && v.length === 2 && Array.isArray(v[1])) {
        consider(v[0], f, { kind: 'memo', name: `state[${depth}]` });
      }
      hook = hook.next;
    }
  };
  for (const f of walkUp(startFiber)) {
    examine(f);
    for (const child of walkDown(f, 3)) examine(child);
  }

  let master = null;
  for (const cand of all) {
    if (!master || cand.list.length > master.list.length) master = cand;
  }

  let indexed = all.find((x) => arrayHasIndexes(x.list)) || null;
  if (!indexed && master) {
    let smallest = null;
    for (const cand of all) {
      if (cand.list === master.list) continue;
      if (!smallest || cand.list.length < smallest.list.length) smallest = cand;
    }
    indexed = smallest;
  }

  return { master, indexed, all };
}

// Cheap re-read for a previously-located list. Tulip almost always replaces
// the array reference on each render (immutable update), so the source we
// recorded at attach time is what we want to read live.
function readArrayFrom(source) {
  if (!source) return null;
  const { fiber, key } = source;
  if (!fiber) return null;
  if (key.kind === 'props') {
    const v = fiber.memoizedProps?.[key.name];
    return arrayLooksLikeOptions(v) ? v : null;
  }
  if (key.kind === 'hook' || key.kind === 'memo') {
    const m = /state\[(\d+)\]/.exec(key.name);
    const idx = m ? Number(m[1]) : -1;
    if (idx < 0) return null;
    let hook = fiber.memoizedState;
    for (let i = 0; hook && i <= idx; i++) {
      if (i === idx) {
        const v = hook.memoizedState;
        if (key.kind === 'hook') return arrayLooksLikeOptions(v) ? v : null;
        if (Array.isArray(v) && v.length === 2 && Array.isArray(v[1])) {
          return arrayLooksLikeOptions(v[0]) ? v[0] : null;
        }
        return null;
      }
      hook = hook.next;
    }
  }
  return null;
}

const SELECT_KEYS = [
  // Tulip's actual handler name.
  'onSelection',
  // Other common shapes, kept as fallbacks.
  'onSelect',
  'onSelectItem',
  'onSelected',
  'onChoose',
  'onPick',
  'onItemClick',
  'onItemSelect',
  'onClickItem',
  'onSuggestionSelected',
  'select',
];

function findSelectHandler(startFiber, quiet = false) {
  for (const f of walkUp(startFiber)) {
    const p = f.memoizedProps;
    if (!p || typeof p !== 'object') continue;
    for (const k of SELECT_KEYS) {
      if (typeof p[k] === 'function') {
        if (!quiet) {
          log('select handler:', k, 'on', f.type?.displayName || f.type?.name || f.type);
        }
        return p[k];
      }
    }
  }
  return null;
}

function getLabel(item) {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return String(item);
  for (const k of [
    'displayName',
    'display',
    'label',
    'fullPath',
    'path',
    'text',
    'name',
    'value',
  ]) {
    if (typeof item[k] === 'string') return item[k];
  }
  return JSON.stringify(item);
}

function pickLiveItem(state, item, i) {
  const indexed = state.indexedList;
  if (!Array.isArray(indexed) || indexed.length === 0) return item;
  const targetValue = item && typeof item === 'object' ? item.value : undefined;
  const targetLabel = getLabel(item);
  const matches = indexed.filter((cand) => {
    if (!cand || typeof cand !== 'object') return false;
    if (targetValue && cand.value === targetValue) return true;
    return getLabel(cand) === targetLabel;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const withIndexes = matches.find((cand) => cand && cand.indexes && typeof cand.indexes.start === 'number');
    if (withIndexes) return withIndexes;
  }
  if (i >= 0 && i < indexed.length) {
    const byIndex = indexed[i];
    if (byIndex && getLabel(byIndex) === targetLabel) return byIndex;
  }
  return item;
}

// ---------- filter ----------
// Case-insensitive substring on the item's label against the whole master
// list. We deliberately do NOT honor Tulip's "current context" gating
// (fields-only when prefixed with `@`, functions/operators otherwise) —
// that gating is exactly what this override exists to bypass. Users want
// to type a bare `User.ID` mid-formula and reach `@Table record.Current
// User.ID` without having to remember the `@` opener, and they want to
// type `floor` from anywhere and still reach the `Floor()` function.
//
// Two small wrinkles:
//   * Leading `@` on field labels is stripped from the haystack, so a
//     bare query `user.id` still matches a field label `@…user.id…`.
//     (The query's own leading `@` is also stripped before lowercasing.)
//   * If the user DID type a leading `@`, we treat that as a strong "I
//     want a field" signal and restrict results to items whose label
//     starts with `@`. So `@` alone narrows to the first MAX_RESULTS
//     fields, which is the natural behavior for the field opener.
//
// Master-list order is preserved — Tulip's own ordering is already
// meaningful (grouped by category) so functions/operators tend to surface
// before fields for ambiguous needles.
function isHiddenLabel(lowerLabel) {
  for (const p of HIDDEN_LABEL_PREFIXES) {
    if (lowerLabel.startsWith(p)) return true;
  }
  return false;
}

function fuzzyFilter(items, query) {
  const wantField = query.startsWith('@');
  const needle = (wantField ? query.slice(1) : query).toLowerCase();
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const label = getLabel(item);
    if (wantField && !label.startsWith('@')) continue;
    const lower = label.toLowerCase();
    if (isHiddenLabel(lower)) continue;
    if (needle) {
      const haystack = lower.startsWith('@') ? lower.slice(1) : lower;
      if (!haystack.includes(needle)) continue;
    }
    out.push(item);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// ---------- styles ----------
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${HIDE_REACT_LIST_ATTR}="true"] { display: none !important; }
    .${OVERLAY_CLASS} {
      box-sizing: border-box;
      overflow: auto;
      font-family: "Noto Sans", sans-serif;
      font-size: 13px;
      color: inherit;
      background: transparent;
    }
    .${ROW_CLASS} {
      padding: 4px 12px;
      line-height: 19px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .${ROW_CLASS}:hover {
      background: rgba(28, 105, 225, 0.10);
    }
    .${SELECTED_CLASS} {
      background: rgba(28, 105, 225, 0.20) !important;
    }
    .${EMPTY_CLASS} {
      padding: 8px 12px;
      color: rgba(0, 0, 0, 0.5);
      font-style: italic;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

// ---------- editor text + range ----------
// Tulip's `onSelection` expects the item to carry an `indexes: {start, end}`
// describing the range in the editor's textContent to splice the chosen
// value over. The master suggestions list does NOT have those — Tulip's
// own row click captures them from the editor's current cursor/token state
// at click time. So we have to do the same: read the caret offset in the
// `.content` contenteditable, walk outwards to the previous/next hard
// separator, and pass that range alongside the picked item.
//
// IMPORTANT: whitespace and `.` are intentionally NOT separators. Tulip
// field labels routinely contain spaces and dots
// (`@Table record.Current User.Date Created`), so we need a fuzzy query
// like `date c` to be able to reach them. The hard separators are the
// expression operators / brackets / quotes — `+` is the primary one in
// practice, but the others matter for non-trivial formulas.
const HARD_SEP_RE = /[+\-*/(),;"'=!<>%&|^~]/;
const WS_RE = /\s/;

// Tulip's expression editor is NOT a real contenteditable. It mirrors the
// formula in `.cursorContainer` (with `<span class="cursor">`) and `.content`
// (with `data-index` on each segment). The cursor often sits *inside* a field
// span, and a TreeWalker that only sums text nodes can report the offset at
// the end of the first chip instead of the active segment.
function chooseCursorEl(cursorContainer) {
  const cursorNodes = Array.from(cursorContainer.querySelectorAll('.cursor'));
  if (cursorNodes.length === 0) return null;
  let cursorEl = null;
  for (let i = cursorNodes.length - 1; i >= 0; i--) {
    const node = cursorNodes[i];
    let visible = false;
    try {
      const rects = typeof node.getClientRects === 'function' ? node.getClientRects() : null;
      visible = !!rects && rects.length > 0;
    } catch (_) {}
    if (visible) {
      cursorEl = node;
      break;
    }
  }
  if (!cursorEl) cursorEl = cursorNodes[cursorNodes.length - 1];
  if (traceSelect && cursorNodes.length > 1) {
    log('[trace:caret]', {
      cursorCount: cursorNodes.length,
      chosenIndex: cursorNodes.indexOf(cursorEl),
    });
  }
  return cursorEl;
}

function cursorContainerSegment(cursorContainer, cursorEl) {
  let segment = cursorEl.parentElement;
  while (segment && segment.parentElement !== cursorContainer) {
    segment = segment.parentElement;
  }
  return segment;
}

function contentSpans(editor) {
  const content = editor.querySelector('.content');
  if (!content) return [];
  return Array.from(content.children).filter(
    (el) => el.tagName === 'SPAN' && el.hasAttribute('data-index'),
  );
}

function caretOffsetIn(editor) {
  const content = editor.querySelector('.content');
  const cursorContainer = editor.querySelector('.cursorContainer');
  if (!content || !cursorContainer) return null;

  const cursorEl = chooseCursorEl(cursorContainer);
  if (!cursorEl) return null;

  const segment = cursorContainerSegment(cursorContainer, cursorEl);
  const spans = contentSpans(editor);
  if (segment) {
    const segText = (segment.textContent ?? '').replace(/\u200b/g, '');
    const containerKids = Array.from(cursorContainer.childNodes).filter(
      (n) => n.nodeType === Node.ELEMENT_NODE,
    );
    const segIndex = containerKids.indexOf(segment);

    const spanFromIndex =
      segIndex >= 0 && segIndex < spans.length ? spans[segIndex] : null;
    const spanFromText = spans.find((span) => {
      const spanText = (span.textContent ?? '').replace(/\u200b/g, '');
      return spanText === segText || (segText && spanText.startsWith(segText));
    });
    const span = spanFromText || spanFromIndex;

    if (span) {
      const base = parseInt(span.getAttribute('data-index'), 10);
      if (!Number.isNaN(base)) {
        const offset = base + segText.length;
        if (traceSelect) {
          log('[trace:caret:data-index]', {
            segIndex,
            base,
            segTextLen: segText.length,
            offset,
            spanClass: span.className,
            matchedBy: spanFromText ? 'text' : 'index',
          });
        }
        return offset;
      }
    }
  }

  // Fallback: count text nodes in cursorContainer up to the cursor.
  let offset = 0;
  const walker = document.createTreeWalker(cursorContainer, NodeFilter.SHOW_ALL);
  let node = walker.nextNode();
  while (node) {
    if (node === cursorEl) return offset;
    if (node.nodeType === Node.TEXT_NODE) offset += node.nodeValue.length;
    node = walker.nextNode();
  }
  return null;
}

function spanAtCaret(editor, caret) {
  const spans = contentSpans(editor);
  if (spans.length === 0 || caret == null) return null;
  for (let i = 0; i < spans.length; i++) {
    const start = parseInt(spans[i].getAttribute('data-index'), 10);
    if (Number.isNaN(start)) continue;
    const nextStart =
      i + 1 < spans.length ? parseInt(spans[i + 1].getAttribute('data-index'), 10) : null;
    const end =
      nextStart != null && !Number.isNaN(nextStart)
        ? nextStart
        : start + (spans[i].textContent?.length ?? 0);
    if (caret >= start && (nextStart == null || caret < nextStart)) {
      return { span: spans[i], start, end };
    }
  }
  return null;
}

function getCurrentRange(editor) {
  const content = editor.querySelector('.content');
  const text = content?.textContent ?? '';
  let caret = caretOffsetIn(editor);
  if (caret == null || caret > text.length || caret < 0) caret = text.length;
  // Walk BACK from the caret to find the token's start. Stop at the
  // previous hard separator (`+`, `-`, `(`, `'`, …). Spaces are NOT
  // separators — see HARD_SEP_RE comment.
  let start = caret;
  while (start > 0 && !HARD_SEP_RE.test(text[start - 1])) start--;
  // Then skip any leading whitespace inside the token so that, e.g.,
  // `@Foo + @bar` makes the active token `@bar` (not ` @bar`); otherwise
  // selecting would also splice over the space after `+`.
  while (start < caret && WS_RE.test(text[start])) start++;
  // Do not walk back out of the segment that contains the caret (field chip,
  // string literal, or partial token being typed).
  const active = spanAtCaret(editor, caret);
  if (active && start < active.start) start = active.start;
  // Walk FORWARD from the caret to find the token's end, so selecting
  // replaces the WHOLE token under the cursor — not just the prefix the
  // user has already typed. (For the common case of caret-at-end, this
  // is a no-op.)
  let end = caret;
  while (end < text.length && !HARD_SEP_RE.test(text[end])) end++;
  if (active && end > active.end) end = active.end;
  return { text, query: text.slice(start, caret), start, end };
}

function resolveSelectionRange(state) {
  if (state.pendingSelectionRange) {
    return { range: state.pendingSelectionRange, source: 'pending' };
  }
  // Always trust the range from the last overlay render (last keystroke).
  // A fresh read during Enter often snaps to an earlier field chip.
  if (state.currentRange) {
    return { range: state.currentRange, source: 'rendered' };
  }
  return { range: getCurrentRange(state.editor), source: 'fresh' };
}

// Tulip's onSelection splices from its internal caret, not our indexes.
// Only nudge the caret forward — never ArrowLeft, which jumps into prior chips.
function moveCaretToOffset(editor, targetOffset) {
  const current = caretOffsetIn(editor);
  if (current == null || targetOffset == null) return { from: current, to: targetOffset, moved: 0 };
  const delta = targetOffset - current;
  if (delta <= 0) return { from: current, to: targetOffset, moved: 0 };
  for (let i = 0; i < delta; i++) {
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  return { from: current, to: targetOffset, moved: delta };
}

// ---------- overlay ----------
function buildOverlay(popper) {
  const list = popper.querySelector(LIST_SEL);
  if (!list) return null;
  const wrapper = list.parentElement;
  if (!wrapper) return null;
  const width = list.style.width || '348px';
  const height = list.style.height || '200px';
  list.setAttribute(HIDE_REACT_LIST_ATTR, 'true');
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.style.width = width;
  overlay.style.height = height;
  wrapper.appendChild(overlay);
  return overlay;
}

function render(state) {
  const { overlay, editor } = state;
  if (!overlay) return;
  // React renders are immutable — the props.suggestions reference we cached
  // at attach time will go stale as soon as the user types. Re-read it (and
  // Tulip's currently-visible indexed list) on every render via the
  // fiber+key source we saved.
  const liveMaster = readArrayFrom(state.masterSource);
  if (liveMaster) state.masterList = liveMaster;
  const liveIndexed = readArrayFrom(state.indexedSource);
  if (liveIndexed) state.indexedList = liveIndexed;
  const range = getCurrentRange(editor);
  state.currentRange = range;
  const query = range.query;
  state.filtered = fuzzyFilter(state.masterList, query);
  if (state.selectedIndex >= state.filtered.length) {
    state.selectedIndex = state.filtered.length - 1;
  }
  if (state.selectedIndex < 0 && state.filtered.length > 0) {
    state.selectedIndex = 0;
  }

  overlay.replaceChildren();
  if (state.filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = EMPTY_CLASS;
    empty.textContent = query ? `No fuzzy matches for "${query}"` : 'No options';
    overlay.appendChild(empty);
    return;
  }
  for (let i = 0; i < state.filtered.length; i++) {
    const item = state.filtered[i];
    const row = document.createElement('div');
    row.className = ROW_CLASS;
    if (i === state.selectedIndex) row.classList.add(SELECTED_CLASS);
    row.textContent = getLabel(item);
    const idx = i;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      state.pendingSelectionRange = state.currentRange || getCurrentRange(state.editor);
    });
    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectItem(state, idx);
    });
    overlay.appendChild(row);
  }
}

// Dispatch synthetic Backspace keydown events at the editor host so
// Tulip's custom keydown handler processes them as real deletes. We use
// native KeyboardEvent (so it bubbles through React's event delegation
// path) with the legacy `keyCode`/`which` fields populated, since some
// older custom editor implementations check them.
function sendBackspaces(editor, count) {
  for (let i = 0; i < count; i++) {
    const ev = new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8,
      which: 8,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(ev);
  }
}

function selectItem(state, i) {
  const item = state.filtered[i];
  if (!item) return;
  const { range: live, source: liveSource } = resolveSelectionRange(state);
  state.pendingSelectionRange = null;
  if (!live) {
    log('no range — cannot select');
    return;
  }
  const caretMove = moveCaretToOffset(state.editor, live.end);
  // CRUCIAL: Tulip's `onSelection` ignores the `.indexes` we pass and
  // instead computes its own splice range internally by walking back
  // from the caret to the previous WHITESPACE — i.e. it is strictly
  // space-tokenized. Our tokenizer is wider (it stops at operators, not
  // whitespace) so a query like `date up` is meant to be replaced as a
  // whole, but Tulip would only replace `up` and leave a dangling `date `
  // in front. Bridge the gap by issuing synthetic Backspace keydowns for
  // each char between our intended start and Tulip's whitespace-based
  // start. After those deletes Tulip's idea of the "current token"
  // matches what the user actually typed, and the splice is correct.
  //
  // Note that for queries whose token doesn't include any internal
  // whitespace (e.g. `@User.Id`, `@upda`) this is a no-op — `extra` is 0
  // — so it doesn't change any of the cases that already work.
  let tulipStart = live.end;
  while (tulipStart > 0 && !WS_RE.test(live.text[tulipStart - 1])) tulipStart--;
  const extra = Math.max(0, tulipStart - live.start);
  if (extra > 0) sendBackspaces(state.editor, extra);

  // Re-resolve onSelect on the CURRENT fiber. Tulip recreates the
  // handler on every render and the handler's closure captures the
  // editor's tokenizer state at creation time. After our Backspaces the
  // editor has re-rendered, so a stale handler reference would be working
  // off pre-delete state. Grabbing the freshest version avoids that.
  let onSelect = state.onSelect;
  try {
    const found = fiberOfNearestHost(state.list);
    if (found) {
      const fresh = findSelectHandler(found.fiber, /*quiet=*/ true);
      if (typeof fresh === 'function') onSelect = fresh;
    }
  } catch (_) {}

  // Prefer the live Tulip item when we can resolve it; it may carry
  // metadata not present on the master catalog item.
  const liveItem = pickLiveItem(state, item, i);

  // We pass indexes for completeness — but Tulip recomputes its own
  // range internally, so really only the deletes above and the `.value`
  // / `.type` on the payload matter.
  const indexes = { start: live.start, end: live.end - extra };
  const payload = Object.assign({}, liveItem, { indexes });
  const beforeText = traceSelect ? snapshotEditorText(state.editor) : null;
  log('selecting', {
    label: getLabel(item),
    value: item.value,
    payloadLabel: getLabel(liveItem),
    payloadValue: liveItem && typeof liveItem === 'object' ? liveItem.value : undefined,
    payloadHasIndexes:
      !!(liveItem && typeof liveItem === 'object' && liveItem.indexes && typeof liveItem.indexes.start === 'number'),
    extra,
    originalRange: { start: live.start, end: live.end },
    indexesPassed: indexes,
    query: live.query,
    handlerFresh: onSelect !== state.onSelect,
    liveSource,
    caretMove,
  });
  try {
    onSelect(payload);
    if (traceSelect) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const afterText = snapshotEditorText(state.editor);
          log('[trace:select→after]', {
            picked: getLabel(item),
            payload: getLabel(liveItem),
            before: beforeText,
            after: afterText,
            delta: diffAround(beforeText ?? '', afterText ?? ''),
          });
        });
      });
    }
  } catch (e) {
    log('onSelect threw:', e?.message || e, 'payload=', payload);
    try {
      log('onSelection.toString() =\n' + String(onSelect).slice(0, 1500));
    } catch (_) {}
  }
}

function moveSelection(state, delta) {
  if (state.filtered.length === 0) return;
  const next = (state.selectedIndex + delta + state.filtered.length) % state.filtered.length;
  state.selectedIndex = next;
  const rows = state.overlay.querySelectorAll('.' + ROW_CLASS);
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle(SELECTED_CLASS, i === next);
  }
  rows[next]?.scrollIntoView({ block: 'nearest' });
}

// Keydown is handled by a single window-level capture-phase listener
// installed once at module load (see `installGlobalKeyHandler`). The reason
// it can't be per-editor is that Tulip already has its own keydown handler
// registered on the editor (custom expression-editor input — not a real
// contenteditable). Element-level listeners fire in registration order;
// ours would be added AFTER Tulip's when the popper opens, so Tulip would
// run first and (we suspect) call `stopImmediatePropagation`, preventing
// our handler from ever seeing the key. Capture-phase on window fires
// strictly before any element listener regardless of registration order,
// so we beat Tulip every time — and `stopImmediatePropagation` keeps
// Tulip from also navigating its (now-hidden) native list.
function findActiveStateForTarget(target) {
  if (!(target instanceof Element)) return null;
  for (const popper of document.querySelectorAll(POPPER_SEL)) {
    const s = popperState.get(popper);
    if (!s) continue;
    if (s.editor === target || s.editor.contains(target)) return s;
  }
  return null;
}

function onGlobalKeyDown(e) {
  if (!enabled) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const state = findActiveStateForTarget(e.target);
  if (!state) return;
  if (e.key === 'Enter' && state.filtered.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  if (e.key === 'ArrowDown') moveSelection(state, 1);
  else if (e.key === 'ArrowUp') moveSelection(state, -1);
  else {
    if (state.currentRange) state.pendingSelectionRange = state.currentRange;
    selectItem(state, state.selectedIndex);
  }
}

let globalKeyHandlerInstalled = false;
function installGlobalKeyHandler() {
  if (globalKeyHandlerInstalled) return;
  globalKeyHandlerInstalled = true;
  window.addEventListener('keydown', onGlobalKeyDown, true);
}

// ---------- attach/detach ----------
function attachToPopper(popper) {
  if (popperState.has(popper)) return;
  const editor = popper.querySelector(EDITOR_SEL);
  if (!editor) return;
  const list = popper.querySelector(LIST_SEL);
  if (!list) return;

  log('candidate popper, looking up React fiber…', popper);

  const found = fiberOfNearestHost(list);
  if (!found) {
    log(
      'no fiber on list or any of its 6 nearest ancestors.',
      '\nlist expando keys:', reactKeysOn(list),
      '\nlist.parent keys:', reactKeysOn(list.parentElement),
      '\npopper keys:', reactKeysOn(popper),
      '\nallKeysOnList:', (() => {
        try { return Object.getOwnPropertyNames(list); } catch (_) { return '<err>'; }
      })(),
    );
    return;
  }
  if (found.host !== list) {
    log('fiber found on ancestor, not list itself:', found.host);
  }
  const listFiber = found.fiber;

  const { master, indexed } = findLists(listFiber);
  if (!master) {
    log(
      'no master list found on fiber chain. Dumping summary:',
      summarizeFiberChain(list),
    );
    return;
  }
  log(
    'master list:',
    `${master.key.kind}.${master.key.name}`,
    'len',
    master.list.length,
    'sample[0]',
    master.list[0],
  );
  if (indexed) {
    log(
      'indexed (context) list:',
      `${indexed.key.kind}.${indexed.key.name}`,
      'len',
      indexed.list.length,
      'sample[0]',
      indexed.list[0],
    );
  }

  const select = findSelectHandler(listFiber);
  if (!select) {
    log(
      'no select handler found on fiber chain. Dumping summary:',
      summarizeFiberChain(list),
    );
    return;
  }

  const overlay = buildOverlay(popper);
  if (!overlay) return;

  const state = {
    popper,
    editor,
    list,
    overlay,
    masterList: master.list,
    masterSource: master,
    indexedList: indexed?.list || null,
    indexedSource: indexed || null,
    onSelect: select,
    selectedIndex: 0,
    filtered: [],
    pendingSelectionRange: null,
  };

  const editorObs = new MutationObserver(() => render(state));
  editorObs.observe(editor, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  state.editorObs = editorObs;

  popperState.set(popper, state);
  render(state);
  log('attached');
}

function detachFromPopper(popper) {
  const state = popperState.get(popper);
  if (!state) return;
  state.editorObs?.disconnect();
  state.overlay?.remove();
  state.list?.removeAttribute(HIDE_REACT_LIST_ATTR);
  popperState.delete(popper);
}

// Anchor on the (singleton) virtualized list and walk up to its popper. There
// are dozens of `[data-testid="popper"]` elements on a Tulip page (tooltips,
// menus, every floating thing); we'd just rather not enumerate them all and
// generate log spam. `closest()` is O(depth) — far cheaper than 60× querySelector.
function scanAll() {
  const lists = document.querySelectorAll(LIST_SEL);
  if (lists.length === 0) return;
  for (const list of lists) {
    const popper = list.closest(POPPER_SEL);
    if (!popper) continue;
    if (!popper.querySelector(EDITOR_SEL)) continue;
    if (enabled) attachToPopper(popper);
    if (observing) attachObservePopper(popper);
  }
}

function summarizeFiberChain(node) {
  const f = fiberOf(node);
  if (!f) return { error: 'no fiber' };
  const rows = [];
  let i = 0;
  for (const fib of walkUp(f)) {
    const typeName =
      fib.type?.displayName ||
      fib.type?.name ||
      (typeof fib.type === 'string' ? fib.type : String(fib.type));
    const arrays = {};
    const fns = [];
    const p = fib.memoizedProps;
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) {
        const v = p[k];
        if (Array.isArray(v)) {
          let sample;
          try { sample = JSON.stringify(v[0]); } catch (_) { sample = '(non-ser)'; }
          arrays[k] = `len=${v.length} sample=${(sample || '').slice(0, 200)}`;
        } else if (typeof v === 'function') {
          fns.push(k);
        }
      }
    }
    rows.push({ depth: i++, type: typeName, propArrays: arrays, propFns: fns });
  }
  return rows;
}

// Coalesce scan requests across a single animation frame so that bursts of
// react-popper style updates don't trigger 60 redundant scans.
function requestScan() {
  if (pendingScan) return;
  pendingScan = true;
  requestAnimationFrame(() => {
    pendingScan = false;
    if (enabled || observing) scanAll();
  });
}

function onMutation(mutations) {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.target instanceof Element) {
      // We only care about attribute flips on a popper that *might* be ours.
      const popper = m.target.matches?.(POPPER_SEL)
        ? m.target
        : m.target.closest?.(POPPER_SEL);
      if (popper && !popperState.has(popper)) requestScan();
      continue;
    }
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.(LIST_SEL) ||
        node.querySelector?.(LIST_SEL) ||
        node.matches?.(POPPER_SEL) ||
        node.querySelector?.(POPPER_SEL)
      ) {
        requestScan();
        break;
      }
    }
    for (const node of m.removedNodes) {
      if (!(node instanceof Element)) continue;
      if (popperState.has(node)) detachFromPopper(node);
      if (observePoppers.has(node)) detachObservePopper(node);
    }
  }
}

function startObserver() {
  if (docObserver) return;
  docObserver = new MutationObserver(onMutation);
  docObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'data-testid'],
  });
  log('observer started');
}

function stopObserver() {
  docObserver?.disconnect();
  docObserver = null;
}

function detachAll() {
  for (const popper of document.querySelectorAll(POPPER_SEL)) {
    detachFromPopper(popper);
  }
}

// ---------- observe mode ----------
// Independent, console-toggleable shadow of Tulip's native popup. Does NOT
// touch the UI — no overlay, no list hide. Just tails every render and
// every row click so we can see exactly what Tulip is doing:
//
//   __tulbeltFuzzy.observe(true)   // start session-only logging
//   __tulbeltFuzzy.observe(false)  // stop
//   __tulbeltFuzzy.observe()       // toggle
//
// Most useful with the fuzzy override OFF (popup toggle), so Tulip's own
// UI is intact and clickable and you can compare its behavior to ours.
let observing = false;
const observePoppers = new WeakMap();

function snapshotEditorText(editor) {
  const content = editor?.querySelector('.content');
  return content?.textContent ?? '';
}

// Shape-match an arbitrary value against "looks like a Tulip suggestion".
// Tulip items have `value: string` plus at least one display-ish string
// (display/displayName/label/text) plus typically `type: string`. We do
// NOT require `.indexes` here — empirically Tulip computes those at click
// time and they are never on the prop, so requiring them returned null
// for every observe click in the last session.
function valueLooksLikeOption(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof v.value !== 'string') return false;
  if (typeof v.type !== 'string' && typeof v.display !== 'string') return false;
  if (
    typeof v.display !== 'string' &&
    typeof v.displayName !== 'string' &&
    typeof v.label !== 'string' &&
    typeof v.text !== 'string' &&
    typeof v.name !== 'string'
  ) {
    return false;
  }
  return true;
}

// Walk fibers up from a clicked DOM node looking for a prop whose value
// is a Tulip-shaped suggestion. That prop is the row's `item` /
// `suggestion` / `option` — the very thing Tulip will spread into the
// onSelection call.
function findRowItemNear(node) {
  let cur = node;
  for (let depth = 0; cur && depth < 12; depth++) {
    const f = fiberOf(cur);
    if (f) {
      let j = 0;
      for (const fib of walkUp(f)) {
        if (j++ > 12) break;
        const p = fib.memoizedProps;
        if (!p || typeof p !== 'object') continue;
        for (const k of Object.keys(p)) {
          if (valueLooksLikeOption(p[k])) return { key: k, item: p[k] };
        }
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

// Read every currently-rendered row's item out of the virtualized list's
// DOM by walking each row's React fiber. This is our most reliable signal
// for "what would Tulip show right now?" — it sidesteps the question of
// where exactly Tulip caches the filtered array in state/props, because
// by definition the items rendered to the DOM are the post-filter result.
// With virtualization only the visible rows are in the DOM, but for the
// small filter results we care about (1-handful of items, e.g. when the
// user is mid-typing) the entire filter is visible.
function readVisibleRowItems(list) {
  if (!list) return [];
  const rowEls = list.querySelectorAll(
    '.ReactVirtualized__Grid__innerScrollContainer > div',
  );
  const seen = new Set();
  const items = [];
  for (const rowEl of rowEls) {
    const f = fiberOf(rowEl);
    if (!f) continue;
    // DFS into the row's subtree looking for the item prop. Most virtualized
    // libs wrap the user's row in a positioned wrapper, so the actual row
    // component (with the item prop) is 1-2 fibers deeper.
    const stack = [f];
    let visits = 0;
    while (stack.length && visits++ < 40) {
      const fib = stack.pop();
      if (!fib) continue;
      const p = fib.memoizedProps;
      if (p && typeof p === 'object') {
        for (const k of Object.keys(p)) {
          if (valueLooksLikeOption(p[k]) && !seen.has(p[k])) {
            seen.add(p[k]);
            items.push(p[k]);
            break;
          }
        }
      }
      if (fib.child) stack.push(fib.child);
      if (fib.sibling) stack.push(fib.sibling);
    }
  }
  return items;
}

// Minimal diff: where text changed, what was removed/inserted.
function diffAround(before, after) {
  if (before === after) return { unchanged: true };
  let start = 0;
  const minLen = Math.min(before.length, after.length);
  while (start < minLen && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return {
    start,
    removed: before.slice(start, endB),
    inserted: after.slice(start, endA),
  };
}

function logObserveState(state, reason) {
  const master = readArrayFrom(state.masterSource);
  const indexed = readArrayFrom(state.indexedSource);
  const range = getCurrentRange(state.editor);
  const indexedTypes = indexed
    ? [
        ...new Set(
          indexed
            .map((it) => (it && typeof it === 'object' ? it.type : null))
            .filter(Boolean),
        ),
      ]
    : null;
  // The authoritative "what Tulip is currently showing" signal: rows it
  // has actually mounted in the DOM. Their types tell us the per-context
  // category rule (field vs function vs …) without us having to find
  // Tulip's filter array in state.
  const visible = readVisibleRowItems(state.list);
  const visibleTypes = visible.length
    ? [...new Set(visible.map((it) => it?.type).filter(Boolean))]
    : null;
  log(`[observe:${reason}]`, {
    text: range.text,
    query: range.query,
    range: { start: range.start, end: range.end },
    master: master ? { len: master.length, sample0: master[0] } : null,
    indexed: indexed
      ? {
          len: indexed.length,
          types: indexedTypes,
          sample0: indexed[0],
          all: indexed.length <= 20 ? indexed : undefined,
        }
      : null,
    visible: visible.length
      ? { len: visible.length, types: visibleTypes, items: visible }
      : null,
  });
}

function attachObservePopper(popper) {
  if (observePoppers.has(popper)) return;
  const editor = popper.querySelector(EDITOR_SEL);
  if (!editor) return;
  const list = popper.querySelector(LIST_SEL);
  if (!list) return;
  const found = fiberOfNearestHost(list);
  if (!found) {
    log('[observe] no fiber on list — cannot attach', popper);
    return;
  }
  const lists = findLists(found.fiber);
  if (!lists.master) {
    log('[observe] no master list — cannot attach', popper);
    return;
  }
  log(
    '[observe] attached. master:',
    `${lists.master.key.kind}.${lists.master.key.name}`,
    'len',
    lists.master.list.length,
    'indexed:',
    lists.indexed
      ? `${lists.indexed.key.kind}.${lists.indexed.key.name} len ${lists.indexed.list.length}`
      : '(none)',
  );

  const state = {
    popper,
    editor,
    list,
    masterSource: lists.master,
    indexedSource: lists.indexed,
  };

  // Coalesce bursts of mutations (Tulip can fire 3-5 per keystroke between
  // updating `.content`, the cursor span, error chip, etc.) into a single
  // log per animation frame. Otherwise the observe console is unreadable.
  const obs = new MutationObserver(() => {
    if (state._logScheduled) return;
    state._logScheduled = true;
    requestAnimationFrame(() => {
      state._logScheduled = false;
      logObserveState(state, 'edit');
    });
  });
  obs.observe(editor, { childList: true, subtree: true, characterData: true });
  state.obs = obs;

  // Capture-phase click listener — fires before React's synthetic handler
  // so we can snapshot the editor pre-insert, and on the next rAF we
  // snapshot post-insert to log the diff Tulip just made.
  const onClick = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const rowEl = target.closest(
      '.ReactVirtualized__Grid__innerScrollContainer > div',
    );
    const before = snapshotEditorText(editor);
    const item = findRowItemNear(target);
    log('[observe:click]', {
      row: rowEl?.textContent,
      item,
      'editor.before': before,
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const after = snapshotEditorText(editor);
        log('[observe:click→after]', {
          'editor.after': after,
          delta: diffAround(before, after),
        });
      });
    });
  };
  list.addEventListener('click', onClick, true);
  state.onClick = onClick;

  observePoppers.set(popper, state);
  logObserveState(state, 'attach');
}

function detachObservePopper(popper) {
  const s = observePoppers.get(popper);
  if (!s) return;
  s.obs?.disconnect();
  if (s.onClick && s.list) {
    s.list.removeEventListener('click', s.onClick, true);
  }
  observePoppers.delete(popper);
}

function detachAllObserve() {
  for (const popper of document.querySelectorAll(POPPER_SEL)) {
    detachObservePopper(popper);
  }
}

function applyObserving(next) {
  const value = !!next;
  if (value === observing) return;
  observing = value;
  if (observing) {
    log('observe: starting');
    startObserver();
    requestScan();
  } else {
    log('observe: stopping');
    detachAllObserve();
    if (!enabled) stopObserver();
  }
}

function applyEnabled(next) {
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    log('enabling');
    ensureStyles();
    installGlobalKeyHandler();
    startObserver();
    requestScan();
  } else {
    log('disabling');
    detachAll();
    removeStyles();
    // Keep the doc observer running if the user is still observing.
    if (!observing) stopObserver();
  }
}

function readEnabledAttr() {
  return document.documentElement.getAttribute(ATTR) === 'true';
}

// Watch <html data-tulbelt-fuzzy-enabled> for changes (set by the isolated
// content-script half whose chrome.storage listener fires on toggle).
const attrObserver = new MutationObserver(() => applyEnabled(readEnabledAttr()));
attrObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: [ATTR],
});

// Devtools API — accessible from the page's main world, so the regular
// console (no context switch needed) can poke at it.
const debugApi = {
  enabled: () => enabled,
  observing: () => observing,
  traceSelect: (next) => {
    if (next === undefined) {
      traceSelect = !traceSelect;
    } else {
      traceSelect = !!next;
    }
    log('traceSelect =', traceSelect);
    return traceSelect;
  },
  // Session-only fuzzy toggle. Storage / popup toggles still win the next
  // time they fire, but for the rest of this page lifetime this overrides
  // them without round-tripping through chrome.storage.
  setEnabled: (next) => applyEnabled(!!next),
  // Toggle the passive shadow logger. Works whether fuzzy is on or off.
  // Pass nothing to flip, pass a bool to set.
  observe: (next) => applyObserving(next === undefined ? !observing : !!next),
  // One-shot dump of current popper state. Tries the observe attachment
  // first, falls back to fuzzy. Returns nothing — output is in the log.
  snapshot: () => {
    for (const popper of document.querySelectorAll(POPPER_SEL)) {
      const s = observePoppers.get(popper) || popperState.get(popper);
      if (s) {
        logObserveState(s, 'snapshot');
        return;
      }
    }
    log('snapshot: no active popper');
  },
  scan: () => scanAll(),
  popper: () => document.querySelector(POPPER_SEL),
  list: () => document.querySelector(LIST_SEL),
  editor: () => document.querySelector(EDITOR_SEL),
  fiber: (node) => fiberOf(node ?? document.querySelector(LIST_SEL)),
  dump: (node) => summarizeFiberChain(node ?? document.querySelector(LIST_SEL)),
  findLists: (node) => {
    const f = fiberOf(node ?? document.querySelector(LIST_SEL));
    return f ? findLists(f) : null;
  },
  // Dump EVERY options-shaped array we can find on/near the list's fiber
  // chain, with its source key and a sample. Use this to hunt down where
  // Tulip stashes its filtered list — you'll spot it as the array whose
  // length matches what the popup is currently showing.
  dumpArrays: (node) => {
    const f = fiberOf(node ?? document.querySelector(LIST_SEL));
    if (!f) return null;
    const result = findLists(f);
    const summarize = (entry) => entry && {
      len: entry.list.length,
      key: entry.key,
      fiberType:
        entry.fiber.type?.displayName ||
        entry.fiber.type?.name ||
        String(entry.fiber.type).slice(0, 30),
      sample: entry.list[0],
      hasIndexes: arrayHasIndexes(entry.list),
    };
    return {
      master: summarize(result.master),
      indexed: summarize(result.indexed),
      all: result.all.map(summarize),
    };
  },
  visible: () => readVisibleRowItems(document.querySelector(LIST_SEL)),
  findSelect: (node) => {
    const f = fiberOf(node ?? document.querySelector(LIST_SEL));
    return f ? findSelectHandler(f) : null;
  },
  range: () => {
    const ed = document.querySelector(EDITOR_SEL);
    return ed ? getCurrentRange(ed) : null;
  },
  // Inspect the live state attached to the (single) currently-active popper.
  state: () => {
    for (const popper of document.querySelectorAll(POPPER_SEL)) {
      const s = popperState.get(popper);
      if (s) {
        return {
          masterLen: s.masterList?.length ?? 0,
          masterSrc: s.masterSource?.key,
          indexedLen: s.indexedList?.length ?? 0,
          indexedSrc: s.indexedSource?.key,
          indexedSample: s.indexedList?.[0],
          range: s.currentRange,
          filteredLen: s.filtered?.length ?? 0,
        };
      }
    }
    return null;
  },
};

try { window.__tulbeltFuzzy = debugApi; } catch (_) {}

applyEnabled(readEnabledAttr());
})();
