import {
  getDeveloperMode,
  getPopupFeatureGroups,
  getToggles,
  setDeveloperMode,
  setToggle,
} from "./features.js";

const DEV_MODE_CLICKS = 5;
const DEV_MODE_CLICK_WINDOW_MS = 2000;

const featureTemplate = document.createElement("template");
featureTemplate.innerHTML = `
  <li class="feature">
    <label>
      <span class="feature-name"></span>
      <span class="feature-controls">
        <button type="button" class="feature-info" aria-controls="tooltip" aria-expanded="false">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm0 1.3a5.45 5.45 0 1 0 0 10.9 5.45 5.45 0 0 0 0-10.9ZM8 4.1a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm-.75 2.85h1.5v4.7h-1.5v-4.7Z"
            />
          </svg>
        </button>
        <span class="switch">
          <input type="checkbox" />
          <span class="slider"></span>
        </span>
      </span>
    </label>
  </li>
`;

const sectionTemplate = document.createElement("template");
sectionTemplate.innerHTML = `
  <li class="feature-section"><span class="feature-section-label"></span></li>
`;

const tooltip = document.getElementById("tooltip");
const SHOW_DELAY_MS = 150;
let showTimer = null;
// The info button whose tooltip is pinned open by a click, if any. A pinned
// tooltip stays put until it, its button, or anything outside is clicked.
let pinnedAnchor = null;

function positionTooltip(anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 6;
  const inset = 10;
  const tipRect = tooltip.getBoundingClientRect();
  const alignRight = anchor.closest(".header-links");

  let top = rect.bottom + margin;
  if (top + tipRect.height > window.innerHeight - inset) {
    top = rect.top - tipRect.height - margin;
  }

  tooltip.style.top = `${Math.max(inset, top)}px`;
  if (alignRight) {
    const maxLeft = window.innerWidth - tipRect.width - inset;
    const left = Math.max(inset, Math.min(rect.right - tipRect.width, maxLeft));
    tooltip.style.left = `${left}px`;
  } else {
    tooltip.style.left = `${inset}px`;
  }
}

function revealTooltip(text, anchor) {
  tooltip.textContent = text;
  tooltip.hidden = false;
  positionTooltip(anchor);
}

function showTooltip(text, anchor) {
  if (pinnedAnchor) return;
  clearTimeout(showTimer);
  if (!tooltip.hidden) revealTooltip(text, anchor);
  else showTimer = setTimeout(() => revealTooltip(text, anchor), SHOW_DELAY_MS);
}

function hideTooltip() {
  clearTimeout(showTimer);
  tooltip.hidden = true;
  tooltip.classList.remove("pinned");
  if (pinnedAnchor) {
    pinnedAnchor.setAttribute("aria-expanded", "false");
    pinnedAnchor = null;
  }
}

function hideHoverTooltip() {
  if (pinnedAnchor) return;
  hideTooltip();
}

function toggleTooltip(text, anchor) {
  const wasOpen = pinnedAnchor === anchor;
  hideTooltip();
  if (wasOpen) return;
  pinnedAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  tooltip.classList.add("pinned");
  revealTooltip(text, anchor);
}

function bindHoverTooltip(anchor, text) {
  anchor.addEventListener("mouseenter", () => showTooltip(text, anchor));
  anchor.addEventListener("mouseleave", hideHoverTooltip);
  anchor.addEventListener("focusin", () => showTooltip(text, anchor));
  anchor.addEventListener("focusout", hideHoverTooltip);
}

function bindInfoButton(button, name, description) {
  button.setAttribute("aria-label", `About ${name}`);
  button.addEventListener("click", (event) => {
    // Keep the click off the surrounding label (which would flip the toggle)
    // and off the outside-click handler that closes the tooltip.
    event.preventDefault();
    event.stopPropagation();
    toggleTooltip(description, button);
  });
}

function createSectionNode(title, sectionId) {
  const node = sectionTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".feature-section-label").textContent = title;
  node.dataset.section = sectionId;
  return node;
}

function createFeatureNode(feature, enabled, sectionId) {
  const node = featureTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".feature-name").textContent = feature.name;
  node.dataset.featureId = feature.id;
  node.dataset.search = `${feature.name} ${feature.description}`.toLowerCase();
  node.dataset.section = sectionId;
  bindInfoButton(node.querySelector(".feature-info"), feature.name, feature.description);
  const cb = node.querySelector("input");
  cb.checked = enabled;
  cb.addEventListener("change", () => setToggle(feature.id, cb.checked));
  return node;
}

function buildPopupFeatures(toggles, showDeveloperFeatures) {
  const { major, more } = getPopupFeatureGroups({ showDeveloperFeatures });
  const items = [];

  if (major.length) {
    items.push(createSectionNode("Major", "major"));
    for (const feature of major) {
      items.push(createFeatureNode(feature, toggles[feature.id], "major"));
    }
  }

  if (more.length) {
    items.push(createSectionNode("More", "more"));
    for (const feature of more) {
      items.push(createFeatureNode(feature, toggles[feature.id], "more"));
    }
  }

  return items;
}

function filterFeatures(query, list, noResults) {
  const q = query.trim().toLowerCase();
  let visibleFeatures = 0;

  hideTooltip();

  for (const node of list.querySelectorAll(".feature")) {
    const show = !q || node.dataset.search.includes(q);
    node.hidden = !show;
    if (show) visibleFeatures++;
  }

  for (const section of list.querySelectorAll(".feature-section")) {
    const sectionId = section.dataset.section;
    const hasVisible = [...list.querySelectorAll(`.feature[data-section="${sectionId}"]`)].some(
      (node) => !node.hidden,
    );
    section.hidden = !hasVisible;
  }

  noResults.hidden = visibleFeatures > 0;
  list.hidden = visibleFeatures === 0;
}

function bindDeveloperModeUnlock(onChange) {
  const title = document.querySelector(".header-brand h1");
  if (!title) return;

  let clicks = 0;
  let resetTimer = null;

  title.addEventListener("click", async () => {
    clicks += 1;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      clicks = 0;
    }, DEV_MODE_CLICK_WINDOW_MS);

    if (clicks < DEV_MODE_CLICKS) return;
    clicks = 0;
    clearTimeout(resetTimer);

    const next = !(await getDeveloperMode());
    await setDeveloperMode(next);
    onChange(next);
  });
}

function setDeveloperModeSubtitle(enabled) {
  const subtitle = document.querySelector(".subtitle");
  if (!subtitle) return;
  subtitle.textContent = enabled ? "tulip.co tweaks · developer" : "tulip.co tweaks";
}

async function render() {
  const developerMode = await getDeveloperMode();
  const toggles = await getToggles();
  const list = document.getElementById("toggles");
  const search = document.getElementById("feature-search");
  const noResults = document.getElementById("no-results");

  setDeveloperModeSubtitle(developerMode);
  list.replaceChildren(...buildPopupFeatures(toggles, developerMode));

  search.addEventListener("input", () => filterFeatures(search.value, list, noResults));

  document.addEventListener("scroll", hideTooltip, true);
  tooltip.addEventListener("click", hideTooltip);
  document.addEventListener("click", () => {
    if (pinnedAnchor) hideTooltip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTooltip();
  });

  for (const link of document.querySelectorAll(".header-links a")) {
    bindHoverTooltip(link, link.getAttribute("aria-label"));
    link.addEventListener("click", (e) => {
      e.preventDefault();
      hideTooltip();
      chrome.tabs.create({ url: link.href });
    });
  }

  bindDeveloperModeUnlock(async (enabled) => {
    setDeveloperModeSubtitle(enabled);
    const nextToggles = await getToggles();
    list.replaceChildren(...buildPopupFeatures(nextToggles, enabled));
    filterFeatures(search.value, list, noResults);
  });
}

render();
