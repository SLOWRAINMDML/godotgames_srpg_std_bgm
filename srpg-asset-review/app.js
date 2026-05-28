const IS_SOURCE_PREVIEW = location.pathname.includes("/local_asset_review/web/");
const MANIFEST_URL = IS_SOURCE_PREVIEW ? "../manifest/srpg_unit_asset_manifest.json" : "manifest.json";
const DECISIONS_URL = IS_SOURCE_PREVIEW ? "../decisions/decisions.json" : "decisions.json";
const DIRECTIONS = ["s", "sw", "w", "nw", "n", "ne", "e", "se"];
const PAGE_SIZE = 100;
const ACTIVE_TARGET = 100;
const STORAGE_KEY = "srpg_unit_usage_decisions_v1";

const STATES = [
  {
    id: "USE_NOW",
    label: "당장 사용",
    shortLabel: "USE",
    className: "use-now",
    description: "스테이지/유닛 리소스에서 바로 쓰는 전투 투입 대상",
  },
  {
    id: "CANDIDATE",
    label: "후보 보관",
    shortLabel: "HOLD",
    className: "candidate",
    description: "완성도는 있지만 지금 투입 여부는 별도 판단",
  },
  {
    id: "NOT_NOW",
    label: "지금 안 씀",
    shortLabel: "SKIP",
    className: "not-now",
    description: "현재 빌드/스테이지에서는 제외하고, 수동 결정 시 아카이브 후보로 보관할 대상",
  },
  {
    id: "FIX_FIRST",
    label: "수정 필요",
    shortLabel: "FIX",
    className: "fix-first",
    description: "참조되거나 쓸 수 있지만 프리뷰/필수 이미지가 부족함",
  },
  {
    id: "CHECK",
    label: "판단 보류",
    shortLabel: "CHECK",
    className: "check",
    description: "이름, 용도, 중복 여부를 더 봐야 함",
  },
];

const LEGACY_STATE_MAP = {
  KEEP: "USE_NOW",
  ARCHIVE: "NOT_NOW",
  REJECT: "NOT_NOW",
  REVIEW: "CHECK",
  BLOCKED: null,
};

let manifest = { units: [] };
let decisions = emptyDecisionSet();
let currentPage = 0;

const $ = (id) => document.getElementById(id);

function emptyDecisionSet() {
  return {
    schema_version: 2,
    purpose: "unit_usage_review",
    decisions: {},
  };
}

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
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("Could not parse stored unit usage decisions", error);
    return null;
  }
}

function saveStoredDecisions() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions));
  } catch (error) {
    console.warn("Could not save unit usage decisions", error);
  }
}

function normalizeDecisionRecord(record) {
  if (!record || typeof record !== "object") return null;
  const mappedState = LEGACY_STATE_MAP[record.state] === undefined ? record.state : LEGACY_STATE_MAP[record.state];
  if (!mappedState || !stateById(mappedState)) return null;
  return {
    state: mappedState,
    notes: record.notes || "",
    reviewer: record.reviewer || "pages",
    updated_at: record.updated_at || "",
  };
}

function normalizeDecisionSet(payload) {
  const normalized = emptyDecisionSet();
  for (const [unitId, record] of Object.entries(payload?.decisions || {})) {
    const clean = normalizeDecisionRecord(record);
    if (clean) normalized.decisions[unitId] = clean;
  }
  return normalized;
}

function mergeDecisions(fileDecisions, storedDecisions) {
  const merged = emptyDecisionSet();
  Object.assign(merged.decisions, normalizeDecisionSet(fileDecisions).decisions);
  Object.assign(merged.decisions, normalizeDecisionSet(storedDecisions).decisions);
  return merged;
}

function stateById(stateId) {
  return STATES.find((state) => state.id === stateId);
}

function stateLabel(stateId) {
  return stateById(stateId)?.label || stateId || "판단 보류";
}

function stateClass(stateId) {
  return stateById(stateId)?.className || "check";
}

function unitRefPaths(unit) {
  return (unit.references?.text_refs || []).map((ref) => ref.path || "");
}

function primaryRefPaths(unit) {
  return unitRefPaths(unit).filter((path) => !path.includes("addons/srpg_editor/bundled/"));
}

function refInfo(unit) {
  const primary = primaryRefPaths(unit);
  const stageRefs = primary.filter((path) => path.startsWith("srpg_data/stages/"));
  const unitRefs = primary.filter((path) => path.startsWith("srpg_data/units/"));
  const characterRefs = primary.filter((path) => path.startsWith("srpg_data/characters/"));
  const skillRefs = primary.filter((path) => path.startsWith("srpg_data/skills/"));
  const cutsceneRefs = primary.filter((path) => path.startsWith("srpg_data/cutscenes/"));
  const registryRefs = primary.filter((path) => path === "srpg_data/monster_skill_registry.json");
  return {
    primary,
    stageRefs,
    unitRefs,
    characterRefs,
    skillRefs,
    cutsceneRefs,
    registryRefs,
    immediateRefs: [...stageRefs, ...unitRefs],
  };
}

function isMonster(unit) {
  return String(unit.id || "").startsWith("monster_");
}

function hasAllDirections(unit) {
  const resolved = unit.asset_paths?.battle_visual_resolved || {};
  return Boolean(unit.asset_status?.all_directional_battle_visuals_exist) || DIRECTIONS.every((dir) => Boolean(resolved[dir]));
}

function hasMissingAssets(unit) {
  return Boolean(unit.asset_status?.missing_paths?.length);
}

function hasRuntimeModel(unit) {
  return Boolean(unit.asset_paths?.model_3d);
}

function hasBattleImage(unit) {
  const resolved = unit.asset_paths?.battle_visual_resolved || {};
  return Boolean(unit.asset_status?.battle_visual_exists) || Object.keys(resolved).length > 0;
}

function missingDirectionCount(unit) {
  const resolved = unit.asset_paths?.battle_visual_resolved || {};
  const missingPaths = unit.asset_status?.missing_paths || [];
  return DIRECTIONS.filter((dir) => !resolved[dir] || missingPaths.includes(resolved[dir])).length;
}

function isPreviewComplete(unit) {
  return hasAllDirections(unit) || hasRuntimeModel(unit) || hasBattleImage(unit);
}

function inferredUsage(unit) {
  const refs = refInfo(unit);
  const complete = isPreviewComplete(unit);
  if (refs.immediateRefs.length && !complete) {
    const reason = refs.immediateRefs.length
      ? "스테이지/유닛에서 참조되지만 8방향 배틀 프리뷰가 불완전합니다."
      : "배틀 프리뷰 방향 또는 필수 이미지가 부족합니다.";
    return { state: "FIX_FIRST", reason };
  }
  if (refs.immediateRefs.length) {
    return { state: "USE_NOW", reason: "스테이지 또는 유닛 리소스에서 직접 참조됩니다." };
  }
  if (!isMonster(unit)) {
    return { state: "CANDIDATE", reason: "몬스터가 아닌 캐릭터 자산이지만 현재 스테이지/유닛 참조는 없습니다." };
  }
  return { state: "NOT_NOW", reason: "몬스터 스킬/레지스트리 참조만 있고 현재 스테이지 투입 대상은 아닙니다." };
}

function hasManualDecision(unit) {
  return Object.prototype.hasOwnProperty.call(decisions.decisions || {}, unit.id);
}

function currentDecision(unit) {
  const manual = decisions.decisions?.[unit.id];
  if (manual?.state) {
    return { ...manual, manual: true, inferred_reason: inferredUsage(unit).reason };
  }
  const inferred = inferredUsage(unit);
  return {
    state: inferred.state,
    notes: "",
    reviewer: "inferred",
    updated_at: "",
    manual: false,
    inferred_reason: inferred.reason,
  };
}

function setDecision(unitId, patch) {
  if (!decisions.decisions) decisions.decisions = {};
  decisions.decisions[unitId] = {
    ...(decisions.decisions[unitId] || {}),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  saveStoredDecisions();
}

function clearDecision(unitId) {
  if (!decisions.decisions) return;
  delete decisions.decisions[unitId];
  saveStoredDecisions();
}

function fileUrl(relPath) {
  if (!relPath) return "";
  if (/^(https?:|data:)/.test(relPath)) return relPath;
  if (relPath.startsWith("thumbs/")) return relPath;
  return IS_SOURCE_PREVIEW ? `../srpg_assets/${relPath}` : relPath;
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function badge(text, className = "") {
  return makeEl("span", `badge ${className}`.trim(), text);
}

function stateBadge(stateId, manual) {
  const meta = stateById(stateId);
  const text = manual ? `${meta?.label || stateId} - 수동` : `${meta?.label || stateId} - 기본`;
  return badge(text, stateClass(stateId));
}

function directionCell(unit, dir) {
  const resolved = unit.asset_paths?.battle_visual_resolved || {};
  const relPath = resolved[dir] || "";
  const cell = makeEl("div", `dir-cell ${relPath ? "" : "missing-dir"}`.trim());
  cell.appendChild(makeEl("span", "dir-label", dir.toUpperCase()));

  if (!relPath) {
    cell.appendChild(makeEl("span", "dir-missing-text", "no path"));
    return cell;
  }

  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = `${unit.id} ${dir}`;
  img.src = fileUrl(relPath);
  img.onerror = () => {
    img.remove();
    cell.classList.add("broken-image");
    cell.appendChild(makeEl("span", "dir-missing-text", "missing"));
  };
  cell.appendChild(img);
  return cell;
}

function makePreview(unit) {
  const resolved = unit.asset_paths?.battle_visual_resolved || {};
  if (Object.keys(resolved).length) {
    const grid = makeEl("div", "direction-grid");
    for (const dir of DIRECTIONS) grid.appendChild(directionCell(unit, dir));
    return grid;
  }

  if (hasRuntimeModel(unit)) {
    const model = makeEl("div", "model-preview");
    model.appendChild(makeEl("strong", "", "3D model battle unit"));
    model.appendChild(makeEl("span", "", unit.asset_paths.model_3d));
    return model;
  }

  const empty = makeEl("div", "no-preview");
  empty.appendChild(makeEl("strong", "", "No battle preview"));
  empty.appendChild(makeEl("span", "", unit.asset_paths?.battle_visual_template || unit.asset_paths?.illustration || unit.asset_paths?.portrait || "preview path is empty"));
  return empty;
}

function compactPathList(paths, limit = 5) {
  if (!paths.length) return ["-"];
  const shown = paths.slice(0, limit);
  if (paths.length > limit) shown.push(`... plus ${paths.length - limit}`);
  return shown;
}

function addMetaRow(parent, label, value) {
  const row = makeEl("div", "meta-row");
  row.appendChild(makeEl("b", "", label));
  row.appendChild(makeEl("span", "", value));
  parent.appendChild(row);
}

function makeStateButtons(unit) {
  const wrap = makeEl("div", "state-buttons");
  const decision = currentDecision(unit);
  for (const state of STATES) {
    const btn = makeEl("button", `state-btn ${state.className}`, state.label);
    btn.type = "button";
    btn.title = state.description;
    btn.classList.toggle("active", decision.state === state.id);
    btn.addEventListener("click", () => {
      setDecision(unit.id, { state: state.id, label: state.label, reviewer: "pages" });
      render();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function renderCard(unit, absoluteIndex) {
  const decision = currentDecision(unit);
  const refs = refInfo(unit);
  const card = makeEl("article", "unit-card");
  card.dataset.state = decision.state;

  const head = makeEl("div", "unit-head");
  head.appendChild(makeEl("div", "unit-index", String(absoluteIndex + 1).padStart(4, "0")));

  const titleBlock = makeEl("div", "unit-title-block");
  titleBlock.appendChild(makeEl("h2", "unit-title", unit.name || unit.id));
  titleBlock.appendChild(makeEl("div", "unit-subtitle", `${unit.id} - ${unit.source_path || "-"}`));
  head.appendChild(titleBlock);

  const badges = makeEl("div", "badges");
  badges.appendChild(stateBadge(decision.state, decision.manual));
  if (refs.immediateRefs.length) badges.appendChild(badge("stage/unit ref", "ref"));
  if (hasRuntimeModel(unit)) badges.appendChild(badge("3D model", "ready"));
  else if (hasAllDirections(unit)) badges.appendChild(badge("8-dir ready", "ready"));
  else if (hasBattleImage(unit)) badges.appendChild(badge("battle image", "ready"));
  else badges.appendChild(badge(`preview incomplete ${missingDirectionCount(unit)}`, "fix-first"));
  if (isMonster(unit)) badges.appendChild(badge("monster", "muted"));
  else badges.appendChild(badge("character", "candidate"));
  head.appendChild(badges);

  const body = makeEl("div", "unit-body");
  body.appendChild(makePreview(unit));

  const side = makeEl("aside", "decision-panel");
  const meta = makeEl("div", "meta-panel");
  addMetaRow(meta, "state", `${stateLabel(decision.state)} (${decision.manual ? "manual" : "inferred"})`);
  addMetaRow(meta, "class", unit.initial_class_id || "-");
  addMetaRow(meta, "faction", unit.default_faction ?? "-");
  addMetaRow(meta, "refs", String(refs.primary.length));
  addMetaRow(meta, "reason", decision.inferred_reason || "-");
  side.appendChild(meta);

  side.appendChild(makeStateButtons(unit));

  const notes = document.createElement("textarea");
  notes.className = "notes";
  notes.placeholder = "결정 이유, 수정 지시, 제외 사유";
  notes.value = decision.notes || "";
  notes.addEventListener("input", () => {
    const state = currentDecision(unit).state;
    setDecision(unit.id, { state, label: stateLabel(state), notes: notes.value, reviewer: "pages" });
    updateSummary();
  });
  side.appendChild(notes);

  const clearBtn = makeEl("button", "clear-btn", "기본값으로 되돌리기");
  clearBtn.type = "button";
  clearBtn.disabled = !decision.manual;
  clearBtn.addEventListener("click", () => {
    clearDecision(unit.id);
    render();
  });
  side.appendChild(clearBtn);

  const details = makeEl("details", "path-details");
  details.appendChild(makeEl("summary", "", "참조 / 원본 경로"));
  const pre = makeEl("pre");
  const battle = unit.asset_paths?.battle_visual_original_resolved || unit.asset_paths?.battle_visual_resolved || {};
  pre.textContent = [
    "[immediate refs]",
    ...compactPathList(refs.immediateRefs, 12),
    "",
    "[skill / registry refs]",
    ...compactPathList([...refs.skillRefs, ...refs.cutsceneRefs, ...refs.registryRefs], 12),
    "",
    "[battle visuals]",
    ...DIRECTIONS.map((dir) => `${dir.toUpperCase()}: ${battle[dir] || "MISSING PATH"}`),
    "",
    `[model] ${unit.asset_paths?.model_3d || "-"}`,
  ].join("\n");
  details.appendChild(pre);
  side.appendChild(details);

  body.appendChild(side);
  card.append(head, body);
  return card;
}

function filteredUnits() {
  const q = $("search").value.toLowerCase().trim();
  const state = $("stateFilter").value;
  const focus = $("focusFilter").value;
  return (manifest.units || []).filter((unit) => {
    const decision = currentDecision(unit);
    const refs = refInfo(unit);
    const haystack = [
      unit.id,
      unit.name,
      unit.initial_class_id,
      unit.source_path,
      unit.description_excerpt,
    ].join(" ").toLowerCase();

    if (q && !haystack.includes(q)) return false;
    if (state !== "ALL" && decision.state !== state) return false;
    if (focus === "IMMEDIATE_REF" && !refs.immediateRefs.length) return false;
    if (focus === "MANUAL" && !decision.manual) return false;
    if (focus === "MONSTER" && !isMonster(unit)) return false;
    if (focus === "NON_MONSTER" && isMonster(unit)) return false;
    if (focus === "INCOMPLETE" && decision.state !== "FIX_FIRST") return false;
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
  for (let i = 0; i < pageCount; i += 1) {
    const start = i * PAGE_SIZE + 1;
    const end = Math.min((i + 1) * PAGE_SIZE, units.length);
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = `Page ${i + 1} - ${String(start).padStart(4, "0")}-${String(end).padStart(4, "0")}`;
    option.selected = i === currentPage;
    select.appendChild(option);
  }

  $("prevPageBtn").disabled = currentPage <= 0;
  $("nextPageBtn").disabled = currentPage >= pageCount - 1;
  const start = units.length ? currentPage * PAGE_SIZE + 1 : 0;
  const end = Math.min((currentPage + 1) * PAGE_SIZE, units.length);
  $("pageInfo").textContent = `${start}-${end} / ${units.length} filtered - 100 per page`;
}

function computeCounts(units = manifest.units || []) {
  const counts = Object.fromEntries(STATES.map((state) => [state.id, 0]));
  let manual = 0;
  let immediateRefs = 0;
  let fixNeeded = 0;
  let monsters = 0;

  for (const unit of units) {
    const decision = currentDecision(unit);
    counts[decision.state] = (counts[decision.state] || 0) + 1;
    if (decision.manual) manual += 1;
    if (refInfo(unit).immediateRefs.length) immediateRefs += 1;
    if (decision.state === "FIX_FIRST") fixNeeded += 1;
    if (isMonster(unit)) monsters += 1;
  }

  return {
    total: units.length,
    manual,
    immediateRefs,
    fixNeeded,
    monsters,
    states: counts,
  };
}

function updateSummary(visible = Math.min(PAGE_SIZE, filteredUnits().length), filtered = filteredUnits().length) {
  const counts = computeCounts();
  const summary = $("summary");
  summary.replaceChildren(
    badge(`visible ${visible}`, "muted"),
    badge(`filtered ${filtered}`, "muted"),
    badge(`total ${counts.total}`, "muted"),
    ...STATES.map((state) => badge(`${state.label} ${counts.states[state.id] || 0}`, state.className)),
    badge(`manual ${counts.manual}`, counts.manual ? "ref" : "muted"),
    badge(`stage/unit refs ${counts.immediateRefs}`, "ref"),
    badge(`fix needed ${counts.fixNeeded}`, counts.fixNeeded ? "fix-first" : "ready"),
  );

  const useNowCount = counts.states.USE_NOW || 0;
  $("activeTarget").textContent = `${useNowCount} / ${ACTIVE_TARGET}`;
  $("activeTarget").classList.toggle("over-target", useNowCount > ACTIVE_TARGET);
  $("activeTargetHint").textContent = useNowCount > ACTIVE_TARGET
    ? "100개 목표를 넘었습니다."
    : "현재 당장 사용 수는 목표 안입니다.";
}

function render() {
  const cards = $("cards");
  cards.replaceChildren();
  const units = filteredUnits();
  refreshPager(units);

  if (!units.length) {
    cards.appendChild(makeEl("div", "empty", "현재 필터에 맞는 유닛이 없습니다."));
    updateSummary(0, 0);
    return;
  }

  const start = currentPage * PAGE_SIZE;
  const frag = document.createDocumentFragment();
  units.slice(start, start + PAGE_SIZE).forEach((unit, index) => {
    frag.appendChild(renderCard(unit, start + index));
  });
  cards.appendChild(frag);
  updateSummary(Math.min(PAGE_SIZE, units.length - start), units.length);
}

function resolvedDecisionForExport(unit) {
  const decision = currentDecision(unit);
  const refs = refInfo(unit);
  return {
    id: unit.id,
    name: unit.name || "",
    state: decision.state,
    label: stateLabel(decision.state),
    manual: decision.manual,
    notes: decision.notes || "",
    inferred_reason: decision.inferred_reason || "",
    preview_complete: isPreviewComplete(unit),
    immediate_refs: refs.immediateRefs,
    source_path: unit.source_path || "",
    class_id: unit.initial_class_id || "",
    faction: unit.default_faction ?? null,
    updated_at: decision.updated_at || "",
  };
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportFullTable() {
  const all = manifest.units || [];
  const payload = {
    schema_version: 2,
    purpose: "unit_usage_review_full_table",
    generated_at: new Date().toISOString(),
    active_target: ACTIVE_TARGET,
    states: Object.fromEntries(STATES.map((state) => [state.id, state.label])),
    summary: computeCounts(all),
    decisions: Object.fromEntries(all.map((unit) => [unit.id, resolvedDecisionForExport(unit)])),
  };
  downloadJson("unit_usage_decisions_full.json", payload);
}

function exportOverrides() {
  const payload = {
    ...decisions,
    generated_at: new Date().toISOString(),
    active_target: ACTIVE_TARGET,
    states: Object.fromEntries(STATES.map((state) => [state.id, state.label])),
    summary: computeCounts(),
  };
  downloadJson("unit_usage_overrides.json", payload);
}

function resetLocalDecisions() {
  if (!confirm("브라우저에 저장된 수동 결정을 모두 지울까요?")) return;
  decisions = emptyDecisionSet();
  localStorage.removeItem(STORAGE_KEY);
  render();
}

function initStateFilter() {
  const filter = $("stateFilter");
  filter.replaceChildren();
  const all = document.createElement("option");
  all.value = "ALL";
  all.textContent = "모든 상태";
  filter.appendChild(all);
  for (const state of STATES) {
    const option = document.createElement("option");
    option.value = state.id;
    option.textContent = state.label;
    filter.appendChild(option);
  }
}

async function init() {
  initStateFilter();
  manifest = await loadJson(MANIFEST_URL, { units: [] });
  const fileDecisions = await loadJson(DECISIONS_URL, emptyDecisionSet());
  decisions = mergeDecisions(fileDecisions, loadStoredDecisions());
  saveStoredDecisions();

  for (const id of ["search", "stateFilter", "focusFilter"]) {
    $(id).addEventListener("input", () => {
      currentPage = 0;
      render();
    });
  }

  $("prevPageBtn").addEventListener("click", () => {
    currentPage = Math.max(0, currentPage - 1);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("nextPageBtn").addEventListener("click", () => {
    currentPage += 1;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("pageSelect").addEventListener("change", (event) => {
    currentPage = Number(event.target.value || 0);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("exportFullBtn").addEventListener("click", exportFullTable);
  $("exportOverridesBtn").addEventListener("click", exportOverrides);
  $("resetBtn").addEventListener("click", resetLocalDecisions);

  render();
}

init();
