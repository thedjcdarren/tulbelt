// TEMPORARY MAIN-WORLD PROBE for the filters-builder-v2 pill investigation.
// DELETE THIS FILE AND ITS manifest.json REGISTRATION BEFORE COMMITTING
// (docs/devtools.md restore-stub rule applies to this file too).
//
// Runs in world: "MAIN" so React fiber expandos (`__reactFiber$…`) are
// visible. Goal: discover how Tulip's TextInputWithPills component stores
// the field value in React state, and whether a direct props.onChange call
// can replace filters-builder-v2's fragile clear-and-backspace write path.
// Logs go through the tulbelt:devlog bridge (Dev Tools toggle must be on);
// helpers live on window.__tulbeltPillProbe in the page ("top") context.

(() => {
  const WRAPPER_SELECTOR = '[class*="TextInputWithPills-styles--styles"]';
  const PILL_SELECTOR = '.param-pill';

  function plog(tag, data) {
    try {
      document.dispatchEvent(
        new CustomEvent('tulbelt:devlog', {
          detail: JSON.stringify({ tag: 'pill-probe:' + tag, data }),
        }),
      );
    } catch (_) {}
  }

  // JSON-safe preview: short strings, function signatures, shallow objects.
  function preview(v, depth = 0) {
    if (v === null || v === undefined) return v ?? null;
    const t = typeof v;
    if (t === 'string') {
      return v.length > 400 ? v.slice(0, 400) + `…(len ${v.length})` : v;
    }
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'function') return `[fn ${v.name || 'anon'}/${v.length}]`;
    if (t !== 'object') return `[${t}]`;
    if (v instanceof Element) {
      const cls = (v.className || '').toString().slice(0, 60);
      return `[<${v.tagName.toLowerCase()} class="${cls}">]`;
    }
    if (depth >= 3) {
      return Array.isArray(v)
        ? `[array ${v.length}]`
        : `[object ${Object.keys(v).slice(0, 10).join(',')}]`;
    }
    if (Array.isArray(v)) return v.slice(0, 8).map((x) => preview(x, depth + 1));
    const out = {};
    for (const k of Object.keys(v).slice(0, 30)) {
      if (k.startsWith('__react') || k === '_owner' || k === '_store') continue;
      try {
        out[k] = preview(v[k], depth + 1);
      } catch (_) {
        out[k] = '[err]';
      }
    }
    return out;
  }

  const FIBER_PREFIXES = [
    '__reactFiber$',
    '__reactInternalInstance$',
    '__reactContainer$',
  ];
  function fiberOf(node) {
    if (!node) return null;
    let keys;
    try {
      keys = Object.getOwnPropertyNames(node);
    } catch (_) {
      return null;
    }
    for (const k of keys) {
      for (const p of FIBER_PREFIXES) {
        if (k.startsWith(p)) {
          const v = node[k];
          if (v) return v;
        }
      }
    }
    return null;
  }

  function startFiber(wrapper) {
    return (
      fiberOf(wrapper) ||
      fiberOf(wrapper.querySelector('input')) ||
      fiberOf(wrapper.parentElement)
    );
  }

  function nameOf(fiber) {
    const t = fiber.type;
    if (typeof t === 'string') return t;
    return (
      t?.displayName || t?.name || (typeof fiber.tag === 'number' ? `tag:${fiber.tag}` : '?')
    );
  }

  const INTERESTING_PROP = /value|change|token|pill|text|param|input|variable|blur|focus/i;

  function dumpFiberLevel(fiber, i) {
    const entry = { i, name: nameOf(fiber) };
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      entry.propKeys = Object.keys(props).slice(0, 40);
      const interesting = {};
      for (const k of entry.propKeys) {
        if (INTERESTING_PROP.test(k)) interesting[k] = preview(props[k]);
      }
      if (Object.keys(interesting).length) entry.props = interesting;
    }
    const sn = fiber.stateNode;
    if (sn && !(sn instanceof Element) && typeof sn === 'object') {
      if (sn.state && typeof sn.state === 'object') {
        entry.state = preview(sn.state);
      }
      try {
        const proto = Object.getPrototypeOf(sn);
        if (proto && proto !== Object.prototype) {
          entry.methods = Object.getOwnPropertyNames(proto)
            .filter((m) => m !== 'constructor' && typeof sn[m] === 'function')
            .slice(0, 40);
        }
      } catch (_) {}
    }
    // Hook state on function components (linked list of memoizedState).
    if (!entry.state && fiber.memoizedState && typeof fiber.memoizedState === 'object') {
      const hooks = [];
      let h = fiber.memoizedState;
      let n = 0;
      while (h && n++ < 12) {
        hooks.push(preview(h.memoizedState, 2));
        h = h.next;
      }
      if (hooks.length) entry.hooks = hooks;
    }
    return entry;
  }

  function findWrappers() {
    return Array.from(document.querySelectorAll(WRAPPER_SELECTOR));
  }

  // Identify which wrapper index is which by its visible content.
  function list() {
    const items = findWrappers().map((w, idx) => {
      let text = '';
      for (const child of w.children) {
        if (child.matches?.(PILL_SELECTOR)) {
          text += `«${child.textContent?.trim()}»`;
          continue;
        }
        const inp = child.matches?.('input')
          ? child
          : child.querySelector?.('input');
        if (inp) text += inp.value;
      }
      return { idx, pills: w.querySelectorAll(PILL_SELECTOR).length, text: text.slice(0, 160) };
    });
    plog('list', items);
    return items;
  }

  // Dump the fiber ancestry of wrapper #which: component names, prop keys,
  // value/onChange-ish props, class state/methods, hook state.
  function dump(which = 0) {
    const w = findWrappers()[which];
    if (!w) {
      plog('dump', { which, error: 'no wrapper at index' });
      return 'no wrapper';
    }
    const fiber = startFiber(w);
    if (!fiber) {
      plog('dump', { which, error: 'no fiber found' });
      return 'no fiber';
    }
    const levels = [];
    let f = fiber;
    let i = 0;
    while (f && i < 18) {
      levels.push(dumpFiberLevel(f, i));
      f = f.return;
      i++;
    }
    plog('dump', { which, levels });
    return levels;
  }

  // Climb from wrapper #which to the first fiber exposing a `value` prop and
  // an onChange-style function, then call it with `text`. Logs the candidate
  // (including the real shape of `value`) before calling, so even a wrong
  // guess about the argument type tells us what the right call would be.
  function setValue(text, which = 0) {
    const w = findWrappers()[which];
    if (!w) {
      plog('setValue', { which, error: 'no wrapper at index' });
      return 'no wrapper';
    }
    let f = startFiber(w);
    let i = 0;
    while (f && i < 18) {
      const props = f.memoizedProps;
      if (props && typeof props === 'object') {
        const fnKey = ['onChange', 'onValueChange', 'onTextChange', 'setValue'].find(
          (k) => typeof props[k] === 'function',
        );
        if (fnKey && 'value' in props) {
          const desc = {
            which,
            level: i,
            component: nameOf(f),
            fnKey,
            fnArity: props[fnKey].length,
            valueType: typeof props.value,
            valuePreview: preview(props.value),
          };
          plog('setValue:candidate', desc);
          try {
            const result = props[fnKey](text);
            plog('setValue:called', { ...desc, result: preview(result) });
          } catch (err) {
            plog('setValue:error', { ...desc, error: String(err) });
          }
          return desc;
        }
      }
      f = f.return;
      i++;
    }
    plog('setValue', { which, error: 'no fiber with value+onChange found' });
    return 'no candidate';
  }

  window.__tulbeltPillProbe = { list, dump, setValue };

  // Auto-dump once when pill wrappers first appear, so a plain reproduce
  // already captures the component shape.
  let dumped = false;
  function tryAutoDump() {
    if (dumped) return;
    if (findWrappers().length > 0) {
      dumped = true;
      list();
      dump(0);
    }
  }
  tryAutoDump();
  new MutationObserver(tryAutoDump).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  plog('loaded', { path: location.pathname });
})();
