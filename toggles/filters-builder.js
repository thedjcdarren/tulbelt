// On connector function pages, the `filters` query parameter is a single
// text field that demands a JSON array. This script hides that row and
// renders a row-shaped block directly below it in the query-params-editor
// list, so the builder reads as the filters parameter, lined up with the
// surrounding rows. The block uses the same flex layout the rows use —
// content area on the left, a cloned copy of the original row's delete
// cell on the right — so width, vertical rhythm and the delete button
// land in the same positions as on the other parameter rows. The original
// input wrapper stays mounted (hidden) so React keeps owning the state;
// on every builder change we serialize to JSON and push it into the field
// via the native value setter + a bubbling `input` event so React's onChange
// fires.
//
// Variable pills are surface sugar for `$VariableName$` literal text that
// Tulip substitutes at submit time. We round-trip them as JSON strings of
// the form `"$Label$"`, so a user can also just type `$Name$` directly in
// the arg field and get the same wire format. The catch: the field is a
// pill editor (`TextInputWithPills`) whose value is an ordered token list —
// one <input> per text run, one `.param-pill` per `$Variable$` — and writing
// a JSON blob into one input leaves the old pill tokens behind, so they pile
// up and corrupt the value. So when pills are present we rebuild the field
// from scratch on each push: clear the text tokens, delete the pills through
// Tulip's own Backspace handler, then write the JSON and let Tulip re-pillify
// the `$Variable$`s cleanly. See `pushJson`/`rebuildValue`.

(() => {
const FEATURE_ID = 'filters-builder';
const STORAGE_KEY = 'toggles';

// `<input placeholder="Add key">` is what Tulip renders for each query-param
// key cell. The placeholder is stable across styled-component rebuilds; the
// `sc-*` hashed classes around it are not.
const KEY_INPUT_SELECTOR = 'input[placeholder="Add key"]';

// CSS-module class name on the TextInputWithPills wrapper. CSS-module names
// are stable; the styled-component hashes above them aren't.
const PILL_WRAPPER_SELECTOR =
  '[class*="TextInputWithPills-styles--styles"]';
const PILL_SELECTOR = '.param-pill';

const HIDDEN_ROW_ATTR = 'data-tulbelt-filters-hidden-row';
const BUILDER_CLASS = 'tulbelt-filters';
const BUILDER_BLOCK_CLASS = 'tulbelt-filters-block';
const STYLE_ID = 'tulbelt-filters-builder-styles';

const FUNCTION_TYPES = [
  { value: 'equal', label: 'equal', arg: 'single' },
  { value: 'notEqual', label: 'notEqual', arg: 'single' },
  { value: 'blank', label: 'blank', arg: 'none' },
  { value: 'notBlank', label: 'notBlank', arg: 'none' },
  { value: 'greaterThan', label: 'greaterThan (>)', arg: 'single' },
  { value: 'greaterThanOrEqual', label: 'greaterThanOrEqual (≥)', arg: 'single' },
  { value: 'lessThan', label: 'lessThan (<)', arg: 'single' },
  { value: 'lessThanOrEqual', label: 'lessThanOrEqual (≤)', arg: 'single' },
  { value: 'isIn', label: 'isIn', arg: 'array' },
  { value: 'notIsIn', label: 'notIsIn', arg: 'array' },
  { value: 'contains', label: 'contains', arg: 'single' },
  { value: 'notContains', label: 'notContains', arg: 'single' },
  { value: 'startsWith', label: 'startsWith', arg: 'single' },
  { value: 'notStartsWith', label: 'notStartsWith', arg: 'single' },
  { value: 'endsWith', label: 'endsWith', arg: 'single' },
  { value: 'notEndsWith', label: 'notEndsWith', arg: 'single' },
];
const FT_BY_VALUE = new Map(FUNCTION_TYPES.map((ft) => [ft.value, ft]));
const FT_VALUES = new Set(FUNCTION_TYPES.map((ft) => ft.value));

let enabled = false;
let observer = null;
// Row element -> builder controller. WeakMap so React-replaced rows are
// auto-collected without leaking.
const trackedRows = new WeakMap();

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${HIDDEN_ROW_ATTR}="true"] {
      display: none !important;
    }

    /* The block is a vertical stack: header row (with the cloned delete
       cell), filter rows, add button. Width shrinks to the widest child
       (a filter row at its max grid track sizes) instead of stretching to
       the full container width — so the rows stay compact and the cloned
       delete cells (header + per row) line up at the block's right edge. */
    .${BUILDER_BLOCK_CLASS} {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: max-content;
      max-width: 100%;
      align-self: flex-start;
      box-sizing: border-box;
      margin: 8px 0;
      font-family: "Noto Sans", sans-serif;
      font-size: 13px;
      color: inherit;
    }

    /* Header row: "filters = (N filters)" on the left, cloned delete cell
       pinned to the right. min-height mimics a native param row height so
       the cloned trash lands at roughly the same y as the deletes on the
       rows above and below. */
    .${BUILDER_CLASS}__header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 36px;
    }
    .${BUILDER_CLASS}__key {
      font-weight: 500;
      color: inherit;
    }
    .${BUILDER_CLASS}__eq {
      color: rgba(0, 0, 0, 0.5);
      font-weight: 500;
    }
    .${BUILDER_CLASS}__count {
      color: rgba(0, 0, 0, 0.55);
      font-size: 12px;
    }
    .${BUILDER_CLASS}__header-spacer { flex: 1 1 auto; }
    .${BUILDER_CLASS}__delete-slot {
      flex: 0 0 auto;
    }

    .${BUILDER_CLASS}__warning {
      background: rgba(255, 224, 130, 0.35);
      color: #8a6d3b;
      border: 1px solid rgba(255, 193, 7, 0.5);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.4;
    }

    .${BUILDER_CLASS}__list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    /* Each column has a sensible max — together they total roughly the
       width of a native [key | = | value] area, but no wider. With the
       block sized to max-content, both the header delete and the row
       deletes (sitting in the last grid column) land at the same x. */
    .${BUILDER_CLASS}__row {
      display: grid;
      grid-template-columns:
        minmax(120px, 240px) minmax(100px, 180px) minmax(140px, 320px) auto;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .${BUILDER_CLASS}__row input,
    .${BUILDER_CLASS}__row select {
      box-sizing: border-box;
      width: 100%;
      padding: 5px 8px;
      border: 1px solid rgba(0, 0, 0, 0.2);
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
      background: rgba(255, 255, 255, 0.85);
      color: inherit;
      min-width: 0;
    }
    .${BUILDER_CLASS}__row input:focus,
    .${BUILDER_CLASS}__row select:focus {
      outline: 0;
      border-color: #3a82f7;
      box-shadow: 0 0 0 2px rgba(58, 130, 247, 0.25);
    }
    .${BUILDER_CLASS}__row--no-arg input.${BUILDER_CLASS}__arg {
      visibility: hidden;
    }
    .${BUILDER_CLASS}__row-btn {
      background: transparent;
      border: 0;
      cursor: pointer;
      color: rgba(0, 0, 0, 0.45);
      padding: 2px 4px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .${BUILDER_CLASS}__row-btn:hover {
      background: rgba(0, 0, 0, 0.06);
      color: rgba(0, 0, 0, 0.8);
    }
    .${BUILDER_CLASS}__add {
      align-self: flex-start;
      background: transparent;
      border: 1px dashed rgba(0, 0, 0, 0.25);
      border-radius: 4px;
      color: rgba(0, 0, 0, 0.55);
      cursor: pointer;
      padding: 4px 10px;
      font-family: inherit;
      font-size: 12px;
    }
    .${BUILDER_CLASS}__add:hover {
      border-color: #3a82f7;
      color: #3a82f7;
    }
    .${BUILDER_CLASS}__empty {
      color: rgba(0, 0, 0, 0.45);
      font-size: 12px;
      font-style: italic;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

// Drive React's onChange handler by going around the React-overridden value
// property setter on HTMLInputElement.
function setNativeInputValue(input, value) {
  const proto = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  proto.set.call(input, value);
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertReplacementText',
    }),
  );
}

// Walk up from a key input to the row container holding the key cell, the
// literal "=" separator, and the value cell.
function findRow(keyInput) {
  let node = keyInput.parentElement;
  while (node && node !== document.body) {
    const wrappers = node.querySelectorAll(PILL_WRAPPER_SELECTOR);
    if (wrappers.length >= 2) {
      const hasEquals = Array.from(node.children).some(
        (c) => c.textContent?.trim() === '=',
      );
      if (hasEquals) return node;
    }
    node = node.parentElement;
  }
  return null;
}

function getValueWrapper(row, keyInput) {
  for (const w of row.querySelectorAll(PILL_WRAPPER_SELECTOR)) {
    if (!w.contains(keyInput)) return w;
  }
  return null;
}

// Concatenate the wrapper's segments into one string. Pills are translated
// to their `$Label$` form; the form depends on context — if the adjacent
// text already encloses the pill in quotes (`"<PILL>"`), the pill is inside
// a JSON string and we splice raw `$Label$`. Otherwise we emit a JSON-quoted
// `"$Label$"` so the resulting array still parses.
function getValueText(wrapper) {
  const segments = [];
  for (const child of wrapper.children) {
    if (child.matches?.(PILL_SELECTOR)) {
      segments.push({ kind: 'pill', label: child.textContent?.trim() ?? '' });
      continue;
    }
    const input = child.matches?.('input')
      ? child
      : child.querySelector?.('input');
    if (input) segments.push({ kind: 'text', value: input.value });
  }

  // Walk segments left to right, tracking whether we're currently inside a
  // JSON string literal. A pill that lands inside a string is spliced as raw
  // `$Label$`; one outside is JSON-quoted so the array still parses. Tracking
  // the real string state (instead of peeking only at the adjacent text)
  // keeps consecutive pills — `$A$$B$`, which Tulip renders with an empty
  // input between them — from each re-opening a quote and breaking the JSON.
  let out = '';
  let inString = false;
  for (const seg of segments) {
    if (seg.kind === 'text') {
      out += seg.value;
      inString = scanStringState(seg.value, inString);
      continue;
    }
    out += inString ? `$${seg.label}$` : JSON.stringify(`$${seg.label}$`);
  }
  return out;
}

// Update "are we inside a JSON string literal?" across a run of text. Flips on
// each unescaped double quote; skips the char following a backslash.
function scanStringState(text, inString) {
  let inStr = inString;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') inStr = !inStr;
  }
  return inStr;
}

function stringifyArg(arg) {
  if (arg === undefined || arg === null) return '';
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return '';
  }
}

function parseFiltersValue(wrapper) {
  const text = getValueText(wrapper);
  if (text.trim() === '') {
    return { filters: [], parseError: false };
  }
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
      return { filters: [], parseError: true };
    }
    const filters = [];
    for (const f of data) {
      if (!f || typeof f !== 'object') continue;
      const field = typeof f.field === 'string' ? f.field : '';
      const functionType = FT_VALUES.has(f.functionType)
        ? f.functionType
        : 'equal';
      const arg = stringifyArg(f.arg);
      filters.push({ field, functionType, arg });
    }
    return { filters, parseError: false };
  } catch {
    return { filters: [], parseError: true };
  }
}

// Best-effort coercion of free-text arg into the JSON value to emit. JSON.parse
// first (so `123`, `true`, `"x"` round-trip) with fall-back to the raw string
// for things like ISO timestamps, bare text, or `$Variable$` references.
function coerceSingleArg(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function coerceArrayArg(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to comma-split
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function serializeFilters(filters) {
  const out = [];
  for (const f of filters) {
    const ft = FT_BY_VALUE.get(f.functionType);
    const obj = { field: f.field, functionType: f.functionType };
    if (!ft || ft.arg === 'none') {
      out.push(obj);
      continue;
    }
    if (ft.arg === 'array') {
      obj.arg = coerceArrayArg(f.arg ?? '');
    } else {
      obj.arg = coerceSingleArg(f.arg ?? '');
    }
    out.push(obj);
  }
  return JSON.stringify(out);
}

function pillsIn(wrapper) {
  return wrapper.querySelectorAll(PILL_SELECTOR);
}

// Direct write into a single-token field (no pills): set the first input to
// the JSON, empty any stragglers. Safe and synchronous.
function writeSingle(wrapper, json) {
  const inputs = wrapper.querySelectorAll('input');
  let first = true;
  for (const input of inputs) {
    setNativeInputValue(input, first ? json : '');
    first = false;
  }
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Tulip's pill editor removes the pill before the caret when Backspace is
// pressed at the start of a text token. Drive that handler directly.
function dispatchBackspace(input) {
  const init = {
    key: 'Backspace',
    code: 'Backspace',
    keyCode: 8,
    which: 8,
    bubbles: true,
    cancelable: true,
  };
  input.dispatchEvent(new KeyboardEvent('keydown', init));
  input.dispatchEvent(new KeyboardEvent('keyup', init));
}

// Rebuild the value field from a clean slate. Tulip stores the field as an
// ordered token list (one <input> per text run, one `.param-pill` per
// `$Variable$`); a blob write leaves the old pill tokens behind, so we first
// clear text, then delete pills through Tulip's own handler (keeping its
// state consistent), then write the JSON and let Tulip re-pillify cleanly.
async function rebuildValue(wrapper, json) {
  for (const input of wrapper.querySelectorAll('input')) {
    if (input.value !== '') setNativeInputValue(input, '');
  }
  await nextTick();

  // Bail on a pass that removes nothing so a change in Tulip's Backspace
  // behavior can't spin us forever; we fall back to a blob write below.
  let guard = 0;
  while (pillsIn(wrapper).length > 0 && guard++ < 100) {
    const inputs = wrapper.querySelectorAll('input');
    const last = inputs[inputs.length - 1];
    if (!last) break;
    try {
      last.setSelectionRange(0, 0);
    } catch (_) {}
    const before = pillsIn(wrapper).length;
    dispatchBackspace(last);
    await nextTick();
    if (pillsIn(wrapper).length >= before) break;
  }

  writeSingle(wrapper, json);
  await nextTick();
}

// Per-wrapper coalescing scheduler. A rebuild spans several frames, so newer
// values that arrive mid-rebuild are picked up when the current one settles.
const pushState = new WeakMap();

function pushJson(wrapper, json) {
  // Fast path: no pills means a direct synchronous write is correct.
  if (pillsIn(wrapper).length === 0) {
    writeSingle(wrapper, json);
    return;
  }

  let state = pushState.get(wrapper);
  if (!state) {
    state = { latest: json, running: false };
    pushState.set(wrapper, state);
  }
  state.latest = json;
  if (state.running) return;
  state.running = true;
  (async () => {
    try {
      let applied = null;
      while (applied !== state.latest) {
        applied = state.latest;
        await rebuildValue(wrapper, applied);
      }
    } finally {
      state.running = false;
    }
  })();
}

const TRASH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg>`;

function buildBuilder({ initialFilters, keyLabel, onChange, sourceRow }) {
  const filters = initialFilters.map((f) => ({ ...f }));

  const root = document.createElement('div');
  root.className = BUILDER_BLOCK_CLASS;

  const header = document.createElement('div');
  header.className = `${BUILDER_CLASS}__header`;
  root.appendChild(header);

  const keyEl = document.createElement('span');
  keyEl.className = `${BUILDER_CLASS}__key`;
  keyEl.textContent = keyLabel;
  header.appendChild(keyEl);

  const eqEl = document.createElement('span');
  eqEl.className = `${BUILDER_CLASS}__eq`;
  eqEl.textContent = '=';
  header.appendChild(eqEl);

  const countEl = document.createElement('span');
  countEl.className = `${BUILDER_CLASS}__count`;
  header.appendChild(countEl);

  const spacer = document.createElement('span');
  spacer.className = `${BUILDER_CLASS}__header-spacer`;
  header.appendChild(spacer);

  const headerDelete = cloneDeleteCell(sourceRow, () => {
    sourceRow.querySelector('button[aria-label="Delete"]')?.click();
  });
  if (headerDelete) {
    headerDelete.classList.add(`${BUILDER_CLASS}__delete-slot`);
    header.appendChild(headerDelete);
  }

  let warningEl = null;
  function setWarning(text) {
    if (!text) {
      warningEl?.remove();
      warningEl = null;
      return;
    }
    if (!warningEl) {
      warningEl = document.createElement('div');
      warningEl.className = `${BUILDER_CLASS}__warning`;
      root.insertBefore(warningEl, header.nextSibling);
    }
    warningEl.textContent = text;
  }

  const list = document.createElement('div');
  list.className = `${BUILDER_CLASS}__list`;
  root.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = `${BUILDER_CLASS}__add`;
  addBtn.textContent = '+ Add filter';
  addBtn.addEventListener('click', () => {
    filters.push({ field: '', functionType: 'equal', arg: '' });
    rerender({ focusLast: true });
  });
  root.appendChild(addBtn);

  function updateCount() {
    countEl.textContent = filters.length
      ? `(${filters.length} filter${filters.length === 1 ? '' : 's'})`
      : '';
  }

  function emit() {
    updateCount();
    onChange(serializeFilters(filters));
  }

  function buildRow(filter, index) {
    const row = document.createElement('div');
    row.className = `${BUILDER_CLASS}__row`;
    const ft = FT_BY_VALUE.get(filter.functionType);
    if (ft?.arg === 'none') row.classList.add(`${BUILDER_CLASS}__row--no-arg`);

    const fieldInput = document.createElement('input');
    fieldInput.type = 'text';
    fieldInput.placeholder = 'field';
    fieldInput.spellcheck = false;
    fieldInput.value = filter.field;
    fieldInput.className = `${BUILDER_CLASS}__field`;
    fieldInput.addEventListener('input', () => {
      filter.field = fieldInput.value;
      emit();
    });
    row.appendChild(fieldInput);

    const select = document.createElement('select');
    select.className = `${BUILDER_CLASS}__op`;
    for (const def of FUNCTION_TYPES) {
      const opt = document.createElement('option');
      opt.value = def.value;
      opt.textContent = def.label;
      select.appendChild(opt);
    }
    select.value = filter.functionType;
    select.addEventListener('change', () => {
      filter.functionType = select.value;
      rerender();
    });
    row.appendChild(select);

    const argInput = document.createElement('input');
    argInput.type = 'text';
    argInput.spellcheck = false;
    argInput.className = `${BUILDER_CLASS}__arg`;
    if (ft?.arg === 'array') {
      argInput.placeholder = '["a", "b"] or a, b, c';
    } else if (ft?.arg === 'none') {
      argInput.placeholder = '';
      argInput.disabled = true;
    } else {
      argInput.placeholder = 'value';
    }
    argInput.value = filter.arg ?? '';
    argInput.addEventListener('input', () => {
      filter.arg = argInput.value;
      emit();
    });
    row.appendChild(argInput);

    const removeCell = cloneDeleteCell(sourceRow, () => {
      filters.splice(index, 1);
      rerender();
    });
    if (removeCell) {
      removeCell.classList.add(`${BUILDER_CLASS}__row-trash`);
      row.appendChild(removeCell);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = `${BUILDER_CLASS}__row-btn`;
      remove.title = 'Remove filter';
      remove.setAttribute('aria-label', 'Remove filter');
      remove.innerHTML = TRASH_ICON;
      remove.addEventListener('click', () => {
        filters.splice(index, 1);
        rerender();
      });
      row.appendChild(remove);
    }

    return { row, fieldInput };
  }

  function rerender(opts = {}) {
    list.replaceChildren();
    let lastBuilt = null;
    filters.forEach((f, i) => {
      const built = buildRow(f, i);
      list.appendChild(built.row);
      lastBuilt = built;
    });
    if (filters.length === 0) {
      const empty = document.createElement('div');
      empty.className = `${BUILDER_CLASS}__empty`;
      empty.textContent = 'No filters. Click "+ Add filter" to start.';
      list.appendChild(empty);
    }
    if (opts.focusLast && lastBuilt) lastBuilt.fieldInput.focus();
    emit();
  }

  rerender();

  return { root, setWarning };
}

// Clone the row's delete cell so it inherits Tulip's exact styled-component
// classes (size, padding, hover treatment). Strip tooltip ids that would
// otherwise dangle, and route clicks to the supplied handler. Used for both
// the cloned outer delete (proxies to whatever delete button is live on the
// hidden row at click time, so React re-renders don't break us) and the
// per-filter-row trashes (which just splice the local filter list).
function cloneDeleteCell(row, onClick) {
  const cells = Array.from(row.children);
  if (cells.length === 0) return null;
  const deleteCell = cells[cells.length - 1];
  if (!deleteCell.querySelector('button[aria-label="Delete"]')) return null;

  const clone = deleteCell.cloneNode(true);
  clone.removeAttribute('aria-describedby');
  for (const el of clone.querySelectorAll('[aria-describedby]')) {
    el.removeAttribute('aria-describedby');
  }

  const proxyBtn = clone.querySelector('button[aria-label="Delete"]');
  proxyBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return clone;
}

function attachBuilder(row, keyInput) {
  const valueWrapper = getValueWrapper(row, keyInput);
  if (!valueWrapper) return;

  const existing = trackedRows.get(row);
  if (existing) {
    if (row.getAttribute(HIDDEN_ROW_ATTR) !== 'true') {
      row.setAttribute(HIDDEN_ROW_ATTR, 'true');
    }
    if (!existing.host.isConnected || existing.host.previousElementSibling !== row) {
      row.parentElement?.insertBefore(existing.host, row.nextSibling);
    }
    return;
  }

  const { filters, parseError } = parseFiltersValue(valueWrapper);

  const builder = buildBuilder({
    initialFilters: filters,
    keyLabel: keyInput.value,
    onChange: (json) => pushJson(valueWrapper, json),
    sourceRow: row,
  });

  if (parseError) {
    builder.setWarning(
      'Existing value could not be parsed as JSON; starting with an empty filter list. Saving will overwrite the existing value.',
    );
  }

  row.parentElement.insertBefore(builder.root, row.nextSibling);
  row.setAttribute(HIDDEN_ROW_ATTR, 'true');

  trackedRows.set(row, { host: builder.root, valueWrapper });
}

function detachBuilder(row) {
  const data = trackedRows.get(row);
  if (!data) return;
  data.host.remove();
  row.removeAttribute(HIDDEN_ROW_ATTR);
  trackedRows.delete(row);
}

function reconcile() {
  for (const keyInput of document.querySelectorAll(KEY_INPUT_SELECTOR)) {
    const row = findRow(keyInput);
    if (!row) continue;
    if (keyInput.value === 'filters') {
      attachBuilder(row, keyInput);
    } else {
      detachBuilder(row);
    }
  }
}

function restoreAll() {
  for (const row of document.querySelectorAll(`[${HIDDEN_ROW_ATTR}="true"]`)) {
    detachBuilder(row);
  }
  cleanupLegacy();
}

// Strip leftover state from earlier versions of this script (in-cell host
// inside a value cell, attribute markers we no longer use, dangling blocks
// from previous loads). Called before reconcile, so any of our own hosts
// from the current load aren't tracked yet — wiping them all here is safe
// and reconcile re-creates fresh ones.
function cleanupLegacy() {
  for (const host of document.querySelectorAll(
    `.${BUILDER_BLOCK_CLASS}, .tulbelt-filters-host`,
  )) {
    host.remove();
  }
  const STALE_ATTRS = [
    'data-tulbelt-filters-hidden-inner',
    'data-tulbelt-filters-row',
    'data-tulbelt-filters-builder',
  ];
  for (const attr of STALE_ATTRS) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      el.removeAttribute(attr);
    }
  }
}

function mutationTouchesTarget(node) {
  if (!(node instanceof Element)) return false;
  return (
    node.matches?.(KEY_INPUT_SELECTOR) ||
    node.querySelector?.(KEY_INPUT_SELECTOR) ||
    node.matches?.(PILL_WRAPPER_SELECTOR) ||
    node.querySelector?.(PILL_WRAPPER_SELECTOR)
  );
}

function onMutation(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (mutationTouchesTarget(node)) {
        reconcile();
        return;
      }
    }
    for (const node of m.removedNodes) {
      if (node instanceof Element && trackedRows.has(node)) {
        const data = trackedRows.get(node);
        data?.host.remove();
        trackedRows.delete(node);
      }
    }
  }
}

function onInputCapture(e) {
  if (!(e.target instanceof HTMLInputElement)) return;
  // Builder-owned inputs handle their own state.
  if (e.target.closest(`.${BUILDER_BLOCK_CLASS}`)) return;
  if (e.target.matches(KEY_INPUT_SELECTOR)) reconcile();
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });
  document.body.addEventListener('input', onInputCapture, true);
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
  document.body.removeEventListener('input', onInputCapture, true);
}

async function syncFromStorage() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const next = stored[FEATURE_ID] === true;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    ensureStyles();
    cleanupLegacy();
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
