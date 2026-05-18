// Registry of toggleable behaviors. Each entry with a `rule` becomes a
// declarativeNetRequest dynamic rule when its toggle is on. Add a new entry
// to ship a new toggle — the popup and background sync read from here.

// Old toggles merged into `compact-app-editor-header`. Kept here so getToggles
// can migrate existing users once.
export const LEGACY_COMPACT_APP_EDITOR_HEADER_IDS = [
  'hide-app-editor-palette-icons',
  'hide-subheader-workspace-label',
];

export const FEATURES = [
  {
    id: 'table-default-sort',
    name: 'Sort tables by newest',
    description:
      'On tulip.co table views, redirect to a URL that sorts by _createdAt descending.',
    defaultEnabled: true,
    rule: {
      condition: {
        // Group 2 captures the path tail including the optional /w/<ws> prefix
        // so it always participates — Chrome DNR's regexSubstitution silently
        // drops the redirect when a backreference targets a non-participating
        // optional group.
        regexFilter:
          '^https://([^/]+)\\.tulip\\.co((?:/w/[^/]+)?/table/[^?]+)$',
        resourceTypes: ['main_frame'],
      },
      action: {
        type: 'redirect',
        redirect: {
          regexSubstitution:
            'https://\\1.tulip.co\\2?sortOptions=%5B%7B%22sortBy%22%3A%22_createdAt%22%2C%22sortDir%22%3A%22desc%22%7D%5D&offset=0',
        },
      },
    },
  },
  {
    id: 'reorder-row-buttons',
    name: 'Row actions next to name',
    description:
      'On app and folder lists, move the edit and actions buttons next to each row’s name instead of the far right.',
    defaultEnabled: true,
  },
  {
    id: 'auto-snapshot',
    name: 'Auto-snapshot every 15 active min',
    description:
      'In the app editor, track active editing time per app and automatically create a snapshot after each 15 minutes of activity.',
    defaultEnabled: false,
  },
  {
    id: 'hide-legacy-tiles',
    name: 'Hide legacy editor tiles',
    description:
      'In the app editor context pane, hide deprecated tiles: Step cycle time, Step comments, Process cycle time, and App comments.',
    defaultEnabled: true,
  },
  {
    id: 'disable-tooltips',
    name: 'Disable hover tooltips',
    description:
      'Suppress the tooltip pop-ups on hover-only action buttons (cut, copy, etc.) while leaving toolbar button tooltips intact.',
    defaultEnabled: false,
  },
  {
    id: 'hide-view-only-triggers',
    name: 'Hide view-only triggers',
    description:
      'In the trigger editor, hide locked/read-only triggers so only editable ones remain in the list.',
    defaultEnabled: false,
  },
  {
    id: 'move-variables-to-toolbar',
    name: 'Move variables to toolbar',
    description:
      'Hide the Variables tile in the app editor context pane and mirror its Edit button into the top toolbar.',
    defaultEnabled: false,
  },
  {
    id: 'dark-mode',
    name: 'Dark mode',
    description:
      'Apply a dark color scheme to tulip.co via filter-inversion (invert, contrast, brightness on the document; restored regions use the exact inverse so previews, canvas, images, and video stay hue-faithful). Targeted tweaks for specific surfaces are layered on top.',
    defaultEnabled: false,
  },
  {
    id: 'hide-app-editor-chrome',
    name: 'Hide editor header & palette',
    description:
      'On app version editor pages only (`/w/…/apps/…/versions/…`), hide the site header, subheader row (breadcrumbs, Run/Publish), and Add/Icons palette.',
    defaultEnabled: false,
  },
  {
    id: 'compact-app-editor-header',
    name: 'Compact app editor header',
    description:
      'In the app editor: hide the workspace name beside breadcrumbs; hide leading icons on palette buttons (Add, Icons, …, Forward/Back); tighten vertical padding on the subheader and palette rows.',
    defaultEnabled: false,
  },
  {
    id: 'context-menu-copy-cut',
    name: 'Copy/Cut in widget menu',
    description:
      'In the app editor canvas widget context menu (Delete / Move To Front / Back), add Copy (Ctrl+C) and Cut (Ctrl+X) rows that trigger those shortcuts when clicked.',
    defaultEnabled: true,
  },
  {
    id: 'strip-tab-title-prefix',
    name: 'Strip "Tulip | " from tab titles',
    description:
      'Remove the leading "Tulip | " prefix from browser tab/window titles so the page-specific name shows first.',
    defaultEnabled: false,
  },
  {
    id: 'filters-builder',
    name: 'Visual filters editor',
    description:
      'On connector function pages, replace the JSON text box for the `filters` query parameter with a row-per-filter builder (field, function, arg). Variable pills round-trip as `$Name$` strings; type `$Name$` directly in an arg field to reference a variable.',
    defaultEnabled: false,
  },
  {
    id: 'expression-editor-fuzzy',
    name: 'Fuzzy expression autocomplete',
    description:
      'In the formula/expression editor popup, replace the “starts with” filtering of suggestions with a case-insensitive substring (contains) match. Typing `User.` surfaces `@Table record.Current User.ID` etc. Arrow keys / Enter / click work as before.',
    defaultEnabled: false,
  },
];

export const STORAGE_KEY = 'toggles';

// Rule IDs must be stable positive integers. Index-based keeps them predictable
// across reloads as long as the order of FEATURES doesn't change.
export function ruleIdFor(index) {
  return index + 1;
}

export async function getToggles() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const result = {};
  for (const f of FEATURES) {
    if (f.id === 'compact-app-editor-header') {
      if (Object.prototype.hasOwnProperty.call(stored, f.id)) {
        result[f.id] = stored[f.id];
      } else {
        const migrated = LEGACY_COMPACT_APP_EDITOR_HEADER_IDS.some(
          (id) => stored[id] === true,
        );
        result[f.id] = migrated || f.defaultEnabled;
      }
    } else {
      result[f.id] = stored[f.id] ?? f.defaultEnabled;
    }
  }
  return result;
}

export async function setToggle(id, enabled) {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...stored, [id]: enabled },
  });
}
