const MANIFEST_URL = "manifest.json";
const DECISIONS_URL = "decisions.json";
const STATES = ["KEEP", "ARCHIVE", "REJECT", "REVIEW", "BLOCKED"];
const DIRECTIONS = ["sw", "se", "ne", "nw"];
const PAGE_SIZE = 100;
const STORAGE_KEY = "srpg_asset_review_decisions_v2";
const BG_STORAGE_KEY = "srpg_asset_review_bg_mode_v1";

let manifest = null;
let decisions = { schema_version: "1.0", decisions: {} };
let currentPage = 0;

const $ = (id) => document.getElementById(id);

async function loadJson(url, fallback) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (error) {
    console.warn(`Could not load ${url}`, error);
    return fallback;
  }
}

function loadStoredDecisions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (error) {
    console.warn("Could not parse stored decisions", error);
    return null;
  }
}

function saveStoredDecisions() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions));
  } catch (error) {
    console.warn("Could not save decisions to localStorage", error);
  }
}

function mergeDecisions(fileDecisions, storedDecisions) {
  const merged = {
    schema_version: "1.0",
    project_root: fileDecisions?.project_root || manifest?.project_root || "",
    decisions: {},
  };
  Object.assign(merged.decisions, fileDecisions?.decisions || {});
  Object.assign(merged.decisions, storedDecisions?.decisions || {});
  return merged;
}

function fileUrl(relPath) {
  if (!relPath) return "";
  return relPath;
}

function currentDecision(unit) {
  return decisions.decisions?.[unit.id] || unit.decision || { state: "REVIEW", notes: "" };
}

function setDecision(unitId, patch) {
  if (!decisions.decisions) decisions.decisions = {};
  decisions.decisions[unitId] = {
    ...(decisions.decisions[unitId] || {}),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  saveStoredDecisions();
  updateSummary();
}

function badge(text, cls = "") {
  const el = document.createElement("span");
  el.className = `badge ${cls}`.trim();
  el.textContent = text;
  return el;
}

function hasAllRuntimeDirections(unit) {
  return Boolean(unit.asset_status?.all_directional_battle_visuals_exist);
}

function missingDirectionCount(unit) {
  const resolved = unit.asset_paths?.battle_visual_resolved || {};
  const missingPaths = unit.asset_status?.missing_paths || [];
  return DIRECTIONS.filter((dir) => !resolved[dir] || missingPaths.includes(resolved[dir])).length;
}

function directionCell(unit, dir) {
  const resolved = unit.asset_paths?.battle_visual_resolved || {};
  const relPath = resolved[dir] || "";
  const cell = document.createElement("div");
  cell.className = `dir-cell ${relPath ? "" : "missing-dir"}`.trim();
  const label = document.createElement("div");
  label.className = "dir-label";
  label.textContent = dir.toUpperCase();
  cell.appendChild(label);

  if (relPath) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = `${unit.id} ${dir}: ${relPath}`;
    img.src = fileUrl(relPath);
    img.onerror = () => {
      img.remove();
      cell.classList.add("broken-image");
      const msg = document.createElement("span");
      msg.className = "dir-missing-text";
      msg.textContent = "missing";
      cell.appendChild(msg);
    };
    cell.appendChild(img);
  } else {
    const msg = document.createElement("span");
    msg.className = "dir-missing-text";
    msg.textContent = "no path";
    cell.appendChild(msg);
  }
  return cell;
}

function makeStateButtons(unit, card, select) {
  const wrap = document.createElement("div");
  wrap.className = "state-buttons";
  for (const state of STATES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `state-btn ${state.toLowerCase()}`;
    btn.textContent = state;
    if (!unit.safety?.archive_eligible && ["ARCHIVE", "REJECT"].includes(state)) {
      btn.disabled = true;
      btn.title = "Not archive eligible: referenced/missing/parse issue must be resolved first.";
    }
    btn.addEventListener("click", () => {
      select.value = state;
      setDecision(unit.id, { state, reviewer: "local" });
      card.dataset.state = state;
      syncActiveStateButtons(wrap, state);
    });
    wrap.appendChild(btn);
  }
  syncActiveStateButtons(wrap, currentDecision(unit).state || "REVIEW");
  return wrap;
}

function syncActiveStateButtons(wrap, state) {
  for (const btn of wrap.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.textContent === state);
  }
}

function renderCard(unit, absoluteIndex) {
  const decision = currentDecision(unit);
  const state = decision.state || "REVIEW";
  const card = document.createElement("article");
  card.className = "asset-row";
  card.dataset.state = state;

  const head = document.createElement("div");
  head.className = "asset-head";

  const index = document.createElement("div");
  index.className = "asset-index";
  index.textContent = String(absoluteIndex + 1).padStart(4, "0");

  const title = document.createElement("div");
  title.className = "asset-title-block";
  const titleLine = document.createElement("div");
  titleLine.className = "asset-title";
  titleLine.textContent = unit.name || unit.id;
  const subLine = document.createElement("div");
  subLine.className = "asset-subtitle";
  subLine.textContent = `${unit.id} · ${unit.source_path}`;
  title.append(titleLine, subLine);

  const badges = document.createElement("div");
  badges.className = "badges";
  badges.appendChild(badge(state, state.toLowerCase()));
  if (hasAllRuntimeDirections(unit)) badges.appendChild(badge("4-dir", "ready"));
  else badges.appendChild(badge(`missing 4-dir ${missingDirectionCount(unit)}`, "missing"));
  if (unit.safety?.is_referenced) badges.appendChild(badge("referenced", "referenced"));
  if (unit.asset_status?.missing_paths?.length) badges.appendChild(badge(`missing ${unit.asset_status.missing_paths.length}`, "missing"));
  if (unit.safety?.archive_eligible) badges.appendChild(badge("archive eligible", "ready"));
  for (const reason of unit.safety?.block_reasons || []) badges.appendChild(badge(reason, "blocked"));

  head.append(index, title, badges);

  const frame = document.createElement("div");
  frame.className = "asset-frame";

  const grid = document.createElement("div");
  grid.className = "direction-grid";
  for (const dir of DIRECTIONS) grid.appendChild(directionCell(unit, dir));

  const side = document.createElement("aside");
  side.className = "review-side";

  const meta = document.createElement("div");
  meta.className = "meta";
  const refCount = unit.references?.text_refs?.length || 0;
  meta.innerHTML = [
    `<b>class</b> ${unit.initial_class_id || "-"}`,
    `<b>faction</b> ${unit.default_faction ?? "-"}`,
    `<b>refs</b> ${refCount}`,
    `<b>state</b> ${state}`,
  ].join(" · ");

  const select = document.createElement("select");
  select.className = "state-select";
  for (const s of STATES) {
    const option = document.createElement("option");
    option.value = s;
    option.textContent = s;
    option.selected = s === state;
    if (!unit.safety?.archive_eligible && ["ARCHIVE", "REJECT"].includes(s)) option.disabled = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    setDecision(unit.id, { state: select.value, reviewer: "local" });
    card.dataset.state = select.value;
    badges.firstChild.textContent = select.value;
    syncActiveStateButtons(buttons, select.value);
  });

  const buttons = makeStateButtons(unit, card, select);

  const notes = document.createElement("textarea");
  notes.className = "notes";
  notes.placeholder = "notes: keep reason / archive reason / redraw issue / merge target";
  notes.value = decision.notes || "";
  notes.addEventListener("input", () => setDecision(unit.id, { notes: notes.value, state: select.value, reviewer: "local" }));

  const paths = document.createElement("details");
  paths.className = "path-details";
  const summary = document.createElement("summary");
  summary.textContent = "paths / missing / references";
  const pre = document.createElement("pre");
  const battle = unit.asset_paths?.battle_visual_resolved || {};
  pre.textContent = [
    `battle template: ${unit.asset_paths?.battle_visual_template || ""}`,
    ...DIRECTIONS.map((dir) => `${dir.toUpperCase()}: ${battle[dir] || "MISSING PATH"}`),
    ...(unit.asset_status?.missing_paths || []).map((p) => `MISSING FILE: ${p}`),
    ...(unit.references?.text_refs || []).slice(0, 20).map((r) => `REF: ${r.path} x${r.count}`),
  ].join("\n");
  paths.append(summary, pre);

  side.append(meta, select, buttons, notes, paths);
  frame.append(grid, side);
  card.append(head, frame);
  return card;
}

function filteredUnits() {
  const q = $("search").value.toLowerCase().trim();
  const state = $("stateFilter").value;
  const missingOnly = $("missingFilter").checked;
  const referencedOnly = $("referencedFilter").checked;
  const incompleteDirsOnly = $("incompleteDirsFilter").checked;
  return (manifest?.units || []).filter((unit) => {
    const decision = currentDecision(unit);
    const haystack = `${unit.id} ${unit.name} ${unit.initial_class_id} ${unit.source_path}`.toLowerCase();
    if (q && !haystack.includes(q)) return false;
    if (state !== "ALL" && decision.state !== state) return false;
    if (missingOnly && !(unit.asset_status?.missing_paths?.length)) return false;
    if (referencedOnly && !unit.safety?.is_referenced) return false;
    if (incompleteDirsOnly && hasAllRuntimeDirections(unit)) return false;
    return true;
  });
}

function pageCountFor(units) {
  return Math.max(1, Math.ceil(units.length / PAGE_SIZE));
}

function refreshPager(units) {
  const pageCount = pageCountFor(units);
  currentPage = Math.min(Math.max(currentPage, 0), pageCount - 1);
  const select = $("pageSelect");
  select.replaceChildren();
  for (let i = 0; i < pageCount; i++) {
    const start = i * PAGE_SIZE + 1;
    const end = Math.min((i + 1) * PAGE_SIZE, units.length);
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = `Page ${i + 1} · ${String(start).padStart(4, "0")}-${String(end).padStart(4, "0")}`;
    option.selected = i === currentPage;
    select.appendChild(option);
  }
  $("prevPageBtn").disabled = currentPage <= 0;
  $("nextPageBtn").disabled = currentPage >= pageCount - 1;
  const start = units.length ? currentPage * PAGE_SIZE + 1 : 0;
  const end = Math.min((currentPage + 1) * PAGE_SIZE, units.length);
  $("pageInfo").textContent = `Showing ${start}-${end} of ${units.length} filtered units · 100 per page`;
}

function render() {
  const cards = $("cards");
  cards.replaceChildren();
  const units = filteredUnits();
  refreshPager(units);
  if (!units.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No units match the current filters.";
    cards.appendChild(empty);
    updateSummary();
    return;
  }
  const start = currentPage * PAGE_SIZE;
  const pageUnits = units.slice(start, start + PAGE_SIZE);
  const frag = document.createDocumentFragment();
  pageUnits.forEach((unit, i) => frag.appendChild(renderCard(unit, start + i)));
  cards.appendChild(frag);
  updateSummary(pageUnits.length, units.length);
}

function updateSummary(visible = Math.min(PAGE_SIZE, filteredUnits().length), filtered = filteredUnits().length) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const unit of manifest?.units || []) counts[currentDecision(unit).state || "REVIEW"]++;
  const total = manifest?.units?.length || 0;
  const missing = (manifest?.units || []).filter((u) => u.asset_status?.missing_paths?.length).length;
  const referenced = (manifest?.units || []).filter((u) => u.safety?.is_referenced).length;
  const incompleteDirs = (manifest?.units || []).filter((u) => !hasAllEightDirections(u)).length;
  $("summary").replaceChildren(
    badge(`page ${currentPage + 1}`),
    badge(`visible ${visible}`),
    badge(`filtered ${filtered}`),
    badge(`total ${total}`),
    ...STATES.map((s) => badge(`${s} ${counts[s] || 0}`, s.toLowerCase())),
    badge(`incomplete 4-dir ${incompleteDirs}`, incompleteDirs ? "missing" : "ready"),
    badge(`missing files ${missing}`, missing ? "missing" : "ready"),
    badge(`referenced ${referenced}`, "referenced"),
  );
}

function exportDecisions() {
  const blob = new Blob([JSON.stringify(decisions, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "decisions.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function resetPageAndRender() {
  currentPage = 0;
  render();
}

function applyBackgroundMode(mode) {
  const safeMode = ["clean", "light", "dark", "checker"].includes(mode) ? mode : "clean";
  document.body.dataset.bgMode = safeMode;
  const select = $("bgMode");
  if (select) select.value = safeMode;
  try { localStorage.setItem(BG_STORAGE_KEY, safeMode); } catch (_error) {}
}

async function init() {
  manifest = await loadJson(MANIFEST_URL, { units: [] });
  const fileDecisions = await loadJson(DECISIONS_URL, { schema_version: "1.0", decisions: {} });
  decisions = mergeDecisions(fileDecisions, loadStoredDecisions());
  saveStoredDecisions();

  let storedBgMode = "clean";
  try { storedBgMode = localStorage.getItem(BG_STORAGE_KEY) || "clean"; } catch (_error) {}
  applyBackgroundMode(storedBgMode);

  for (const id of ["search", "stateFilter", "missingFilter", "referencedFilter", "incompleteDirsFilter"]) {
    $(id).addEventListener("input", resetPageAndRender);
  }
  $("bgMode").addEventListener("change", (event) => applyBackgroundMode(event.target.value));
  $("exportBtn").addEventListener("click", exportDecisions);
  $("prevPageBtn").addEventListener("click", () => { currentPage = Math.max(0, currentPage - 1); render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("nextPageBtn").addEventListener("click", () => { currentPage += 1; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("pageSelect").addEventListener("change", (event) => { currentPage = Number(event.target.value || 0); render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  render();
}

init();
