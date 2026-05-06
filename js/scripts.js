/* global mapboxgl, turf */

const STYLE = "mapbox://styles/mapbox/light-v11";
const DEFAULT_VIEW = { center: [-86.8, 32.8], zoom: 6 };

const FIXED_MERGED_COLS = 10;
const FIXED_SPLIT_COLS = 10;
const FIXED_ASSOC_COLS = 10;

const LINEAGE_COLORS = {
  merged: "#8b5cf6",
  split: "#06b6d4",
  changed: "#f59e0b",
  associated: "#22c55e",
  unmatched: "#9ca3af",
};

const STORAGE_KEY_TOKEN = "geojsonLineage.mapboxToken";

const ui = {
  // token
  mapboxToken: document.getElementById("mapboxToken"),
  saveTokenBtn: document.getElementById("saveTokenBtn"),
  tokenHelpBtn: document.getElementById("tokenHelpBtn"),
  tokenModal: document.getElementById("tokenModal"),
  closeTokenModalBtn: document.getElementById("closeTokenModalBtn"),

  // dataset mode dropdowns
  olderMode: document.getElementById("olderMode"),
  newerMode: document.getElementById("newerMode"),
  olderUrlWrap: document.getElementById("olderUrlWrap"),
  olderFileWrap: document.getElementById("olderFileWrap"),
  newerUrlWrap: document.getElementById("newerUrlWrap"),
  newerFileWrap: document.getElementById("newerFileWrap"),

  // dataset inputs
  urlOlder: document.getElementById("urlOlder"),
  urlNewer: document.getElementById("urlNewer"),
  fileOlder: document.getElementById("fileOlder"),
  fileNewer: document.getElementById("fileNewer"),

  // actions
  loadBtn: document.getElementById("loadBtn"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  downloadLink: document.getElementById("downloadLink"),
  summary: document.getElementById("summary"),
};

let dataOlder = null;
let dataNewer = null;
let lineageNewerBase = null;

let mapOlder = null;
let mapNewer = null;
let mapLineage = null;

/* =========================
   UI helpers
========================= */
function setSummary(html, isError = false) {
  ui.summary.innerHTML = isError
    ? `<span style="color:#ffb4b4;"><b>Error:</b> ${html}</span>`
    : html;
}

function clearDownloadLink() {
  ui.downloadLink.style.display = "none";
  ui.downloadLink.removeAttribute("href");
}

function setDownloadLink(geojson, filename = "lineage_newer_base.geojson") {
  const blob = new Blob([JSON.stringify(geojson)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  ui.downloadLink.href = url;
  ui.downloadLink.download = filename;
  ui.downloadLink.style.display = "inline-block";
}

/* =========================
   Token handling
========================= */
function loadTokenFromStorage() {
  const t = localStorage.getItem(STORAGE_KEY_TOKEN) || "";
  ui.mapboxToken.value = t;
  return t;
}

function saveTokenToStorage(token) {
  localStorage.setItem(STORAGE_KEY_TOKEN, token);
}

function validateTokenFormat(token) {
  if (!token) return { ok: false, msg: "No Mapbox token set. Maps will not render." };
  // Mapbox public tokens typically start with pk (public) and secret start with sk. [1](https://docs.mapbox.com/help/getting-started/access-tokens/)[2](https://docs.mapbox.com/help/glossary/access-token/)
  if (!token.startsWith("pk.")) {
    return { ok: true, msg: "Warning: token does not start with pk. Ensure you're using a public token." };
  }
  return { ok: true, msg: "" };
}

function applyToken(token) {
  mapboxgl.accessToken = token; // must be set before creating maps in many setups
}

/* =========================
   Modal
========================= */
function openTokenModal() {
  ui.tokenModal.style.display = "flex";
  ui.tokenModal.setAttribute("aria-hidden", "false");
}

function closeTokenModal() {
  ui.tokenModal.style.display = "none";
  ui.tokenModal.setAttribute("aria-hidden", "true");
}

/* =========================
   URL normalization (GitHub blob -> raw)
========================= */
function normalizeGeoJsonUrl(url) {
  if (!url) return "";
  const u = url.trim();

  if (u.includes("raw.githubusercontent.com")) return u;

  // github.com/<owner>/<repo>/blob/<branch>/<path> -> raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
  const blobMatch = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (blobMatch) {
    const owner = blobMatch[1];
    const repo = blobMatch[2];
    const branch = blobMatch[3];
    const path = blobMatch[4];
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  }

  return u;
}

/* =========================
   Loading
========================= */
async function fetchGeojson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch (${res.status}): ${url}`);
  return res.json();
}

function readFileAsJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed reading file."));
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch {
        reject(new Error("File is not valid JSON / GeoJSON."));
      }
    };
    reader.readAsText(file);
  });
}

/* =========================
   ✅ GeoJSON Validation
========================= */
function validateGeoJson(geojson, label) {
  const errors = [];
  const warnings = [];
  const stats = { featureCount: 0, missingGeoIdCount: 0, nonPolygonCount: 0 };

  if (!geojson || typeof geojson !== "object") {
    errors.push(`${label}: Not a JSON object.`);
    return { ok: false, errors, warnings, stats };
  }
  if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    errors.push(`${label}: Must be a FeatureCollection with a features[] array.`);
    return { ok: false, errors, warnings, stats };
  }

  stats.featureCount = geojson.features.length;
  if (stats.featureCount === 0) warnings.push(`${label}: FeatureCollection has 0 features.`);

  for (const f of geojson.features) {
    if (!f || f.type !== "Feature") { warnings.push(`${label}: Found non-Feature in features[].`); continue; }
    const geomType = f.geometry?.type;
    if (geomType !== "Polygon" && geomType !== "MultiPolygon") stats.nonPolygonCount++;

    const props = f.properties || {};
    const geoid = props.GEOID ?? props.geoid ?? null;
    if (!geoid) stats.missingGeoIdCount++;
  }

  if (stats.nonPolygonCount > 0) {
    warnings.push(`${label}: ${stats.nonPolygonCount} features are not Polygon/MultiPolygon (lineage expects polygons).`);
  }

  // If >25% missing GEOIDs, block the run (lineage becomes unreliable)
  if (stats.featureCount > 0 && stats.missingGeoIdCount / stats.featureCount > 0.25) {
    errors.push(`${label}: Too many features missing GEOID/geoid (${stats.missingGeoIdCount}/${stats.featureCount}).`);
  } else if (stats.missingGeoIdCount > 0) {
    warnings.push(`${label}: ${stats.missingGeoIdCount}/${stats.featureCount} features missing GEOID/geoid.`);
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/* =========================
   Dataset mode UI (URL vs File)
========================= */
function setModeUI(which) {
  if (which === "older") {
    const mode = ui.olderMode.value;
    ui.olderUrlWrap.style.display = mode === "url" ? "block" : "none";
    ui.olderFileWrap.style.display = mode === "file" ? "block" : "none";
  } else if (which === "newer") {
    const mode = ui.newerMode.value;
    ui.newerUrlWrap.style.display = mode === "url" ? "block" : "none";
    ui.newerFileWrap.style.display = mode === "file" ? "block" : "none";
  }
}

/* =========================
   Maps
========================= */
function addNav(map) {
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
}

function safeResizeAll() {
  mapOlder?.resize();
  mapNewer?.resize();
  mapLineage?.resize();
}

function destroyMaps() {
  mapOlder?.remove();
  mapNewer?.remove();
  mapLineage?.remove();
  mapOlder = null;
  mapNewer = null;
  mapLineage = null;
}

function createMaps() {
  mapOlder = new mapboxgl.Map({
    container: "map2019",
    style: STYLE,
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
  });
  addNav(mapOlder);

  mapNewer = new mapboxgl.Map({
    container: "map2024",
    style: STYLE,
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
  });
  addNav(mapNewer);

  mapLineage = new mapboxgl.Map({
    container: "mapChanges",
    style: STYLE,
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
  });
  addNav(mapLineage);

  mapOlder.on("load", () => {
    mapOlder.addSource("older", { type: "geojson", data: dataOlder || { type: "FeatureCollection", features: [] } });
    mapOlder.addLayer({ id: "older-outline", type: "line", source: "older", paint: { "line-color": "#1f4fff", "line-width": 1 } });
  });

  mapNewer.on("load", () => {
    mapNewer.addSource("newer", { type: "geojson", data: dataNewer || { type: "FeatureCollection", features: [] } });
    mapNewer.addLayer({ id: "newer-outline", type: "line", source: "newer", paint: { "line-color": "#ff2d2d", "line-width": 1 } });
  });

  mapLineage.on("load", () => {
    mapLineage.addSource("older", { type: "geojson", data: dataOlder || { type: "FeatureCollection", features: [] } });
    mapLineage.addLayer({ id: "older-outline-faint", type: "line", source: "older", paint: { "line-color": "#1f4fff", "line-width": 0.7, "line-opacity": 0.25 } });

    mapLineage.addSource("newer", { type: "geojson", data: dataNewer || { type: "FeatureCollection", features: [] } });
    mapLineage.addLayer({ id: "newer-outline-faint", type: "line", source: "newer", paint: { "line-color": "#ff2d2d", "line-width": 0.7, "line-opacity": 0.25 } });
  });

  window.setTimeout(safeResizeAll, 250);
  window.addEventListener("resize", safeResizeAll);
}

/* =========================
   Lineage logic (centroid join + intersects fallback)
========================= */
function getId(feature) {
  if (!feature || !feature.properties) return null;
  return feature.properties.GEOID ?? feature.properties.geoid ?? null;
}
function geometryChanged(g1, g2) { return JSON.stringify(g1) !== JSON.stringify(g2); }
function bboxContainsPoint(bbox, pt) {
  const [minX, minY, maxX, maxY] = bbox;
  const [x, y] = pt;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}
function bboxesOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
function intersectingOlderIdsForNewer(polyNewer, bboxNewer, featuresOlder) {
  const hits = [];
  for (const fOld of featuresOlder) {
    const bboxOld = turf.bbox(fOld);
    if (!bboxesOverlap(bboxNewer, bboxOld)) continue;
    if (turf.booleanIntersects(polyNewer, fOld)) {
      const idOld = getId(fOld);
      if (idOld) hits.push(idOld);
    }
  }
  return Array.from(new Set(hits));
}

function buildLineageNewerBase() {
  const older = (dataOlder?.features || []).filter(f => getId(f));
  const newer = (dataNewer?.features || []).filter(f => getId(f));

  const byIdOlder = new Map(older.map(f => [getId(f), f]));

  const centroidsOlder = older.map(f => {
    const id = getId(f);
    const c = turf.centroid(f);
    return { id, coord: c.geometry.coordinates };
  });

  const centroidsNewer = newer.map(f => {
    const id = getId(f);
    const c = turf.centroid(f);
    return { id, feature: f, coord: c.geometry.coordinates, bbox: turf.bbox(f) };
  });

  const mapNewerToOlder = new Map();
  const splitGroups = new Map();

  for (const entry of centroidsNewer) {
    const { id: idNewer, coord: cNewer } = entry;
    let parentOlder = null;

    for (const polyOld of older) {
      const bboxOld = turf.bbox(polyOld);
      if (!bboxContainsPoint(bboxOld, cNewer)) continue;
      if (turf.booleanPointInPolygon(turf.point(cNewer), polyOld)) {
        parentOlder = getId(polyOld);
        break;
      }
    }

    mapNewerToOlder.set(idNewer, parentOlder);
    if (parentOlder) {
      if (!splitGroups.has(parentOlder)) splitGroups.set(parentOlder, []);
      splitGroups.get(parentOlder).push(idNewer);
    }
  }

  const mergedFromMap = new Map();
  for (const entry of centroidsNewer) {
    const { id: idNewer, feature: polyNewer, bbox: bboxNewer } = entry;
    const inside = [];
    for (const cOld of centroidsOlder) {
      if (!bboxContainsPoint(bboxNewer, cOld.coord)) continue;
      if (turf.booleanPointInPolygon(turf.point(cOld.coord), polyNewer)) inside.push(cOld.id);
    }
    mergedFromMap.set(idNewer, Array.from(new Set(inside)));
  }

  const computed = centroidsNewer.map(({ id: idNewer, feature: fNewer, bbox: bboxNewer }) => {
    const mergedOlder = mergedFromMap.get(idNewer) || [];
    const parentOlder = mapNewerToOlder.get(idNewer) || null;
    const isSplit = parentOlder && (splitGroups.get(parentOlder)?.length || 0) > 1;

    let status = "unmatched";
    let listMerged = [];
    let listSplit = [];
    let listAssoc = [];

    if (mergedOlder.length > 1) {
      status = "merged";
      listMerged = mergedOlder;
    } else if (isSplit) {
      status = "split";
      listSplit = [parentOlder];
    } else {
      if (parentOlder) {
        const oldMatch = byIdOlder.get(parentOlder);
        if (parentOlder !== idNewer) {
          status = "changed";
          listAssoc = [parentOlder];
        } else if (oldMatch && geometryChanged(oldMatch.geometry, fNewer.geometry)) {
          status = "changed";
          listAssoc = [parentOlder];
        } else {
          status = "associated";
          listAssoc = [parentOlder];
        }
      } else {
        const intersectsOlder = intersectingOlderIdsForNewer(fNewer, bboxNewer, older);
        if (intersectsOlder.length > 0) {
          status = "changed";
          listAssoc = intersectsOlder;
        }
      }
    }

    return { fNewer, status, listMerged, listSplit, listAssoc };
  });

  const outFeatures = computed.map(({ fNewer, status, listMerged, listSplit, listAssoc }) => {
    const props = { ...(fNewer.properties || {}) };
    props["lineage_status"] = status;

    for (let i = 1; i <= FIXED_MERGED_COLS; i++) props[`merged 2019 geoid ${i}`] = "";
    for (let i = 1; i <= FIXED_SPLIT_COLS; i++) props[`split 2019 geoid ${i}`] = "";
    for (let i = 1; i <= FIXED_ASSOC_COLS; i++) props[`associated 2019 geoid ${i}`] = "";

    if (status === "merged") {
      listMerged.slice(0, FIXED_MERGED_COLS).forEach((id, idx) => props[`merged 2019 geoid ${idx + 1}`] = id);
    } else if (status === "split") {
      listSplit.slice(0, FIXED_SPLIT_COLS).forEach((id, idx) => props[`split 2019 geoid ${idx + 1}`] = id);
    } else if (status === "changed" || status === "associated") {
      listAssoc.slice(0, FIXED_ASSOC_COLS).forEach((id, idx) => props[`associated 2019 geoid ${idx + 1}`] = id);
    }

    props["merged_2019_count"] = listMerged.length;
    props["split_2019_count"] = listSplit.length;
    props["associated_2019_count"] = listAssoc.length;

    props["merged_2019_overflow"] = Math.max(0, listMerged.length - FIXED_MERGED_COLS);
    props["split_2019_overflow"] = Math.max(0, listSplit.length - FIXED_SPLIT_COLS);
    props["associated_2019_overflow"] = Math.max(0, listAssoc.length - FIXED_ASSOC_COLS);

    return { type: "Feature", geometry: fNewer.geometry, properties: props };
  });

  return { type: "FeatureCollection", name: "lineage_newer_base", features: outFeatures };
}

function upsertLineageLayer(geojson) {
  if (!mapLineage) return;

  if (mapLineage.getSource("lineage")) {
    mapLineage.getSource("lineage").setData(geojson);
    return;
  }

  mapLineage.addSource("lineage", { type: "geojson", data: geojson });

  mapLineage.addLayer({
    id: "lineage-fill",
    type: "fill",
    source: "lineage",
    paint: {
      "fill-color": [
        "match",
        ["get", "lineage_status"],
        "merged", LINEAGE_COLORS.merged,
        "split", LINEAGE_COLORS.split,
        "changed", LINEAGE_COLORS.changed,
        "associated", LINEAGE_COLORS.associated,
        LINEAGE_COLORS.unmatched
      ],
      "fill-opacity": 0.55
    }
  });

  mapLineage.addLayer({
    id: "lineage-outline",
    type: "line",
    source: "lineage",
    paint: { "line-color": "#2b2b2b", "line-width": 0.6 }
  });
}

/* =========================
   Actions
========================= */
async function loadDatasets() {
  try {
    ui.analyzeBtn.disabled = true;
    clearDownloadLink();
    setSummary("Loading datasets…");

    // Token check
    const token = ui.mapboxToken.value.trim();
    const tokenCheck = validateTokenFormat(token);
    if (!tokenCheck.ok) {
      setSummary(tokenCheck.msg, true);
      return;
    }
    if (token) applyToken(token);

    // Load older based on dropdown
    if (ui.olderMode.value === "file") {
      const f = ui.fileOlder.files?.[0];
      if (!f) throw new Error("Older: Please select a file (or switch Source to URL).");
      dataOlder = await readFileAsJson(f);
    } else {
      const url = normalizeGeoJsonUrl(ui.urlOlder.value);
      if (!url) throw new Error("Older: Please enter a URL (or switch Source to Upload).");
      dataOlder = await fetchGeojson(url);
    }

    // Load newer based on dropdown
    if (ui.newerMode.value === "file") {
      const f = ui.fileNewer.files?.[0];
      if (!f) throw new Error("Newer: Please select a file (or switch Source to URL).");
      dataNewer = await readFileAsJson(f);
    } else {
      const url = normalizeGeoJsonUrl(ui.urlNewer.value);
      if (!url) throw new Error("Newer: Please enter a URL (or switch Source to Upload).");
      dataNewer = await fetchGeojson(url);
    }

    // Validate
    const vOld = validateGeoJson(dataOlder, "Older");
    const vNew = validateGeoJson(dataNewer, "Newer");

    const report = [];
    report.push(`<b>Validation</b>`);
    report.push(`Older: ${vOld.stats.featureCount} features (missing GEOID: ${vOld.stats.missingGeoIdCount})`);
    report.push(`Newer: ${vNew.stats.featureCount} features (missing GEOID: ${vNew.stats.missingGeoIdCount})`);

    if (!vOld.ok || !vNew.ok) {
      const allErrors = [...vOld.errors, ...vNew.errors];
      setSummary(report.join("<br/>") + `<br/><br/><b>Fix these:</b><br/>- ` + allErrors.join("<br/>- "), true);
      ui.analyzeBtn.disabled = true;
      return;
    }

    const allWarnings = [...vOld.warnings, ...vNew.warnings];
    if (allWarnings.length) report.push(`<br/><b>Warnings</b><br/>- ${allWarnings.join("<br/>- ")}`);

    // Rebuild maps if token was changed / first run
    destroyMaps();
    createMaps();

    ui.analyzeBtn.disabled = false;
    setSummary(report.join("<br/>") + `<br/><br/>Datasets loaded. Click “Build Newer‑base Lineage + Download”.`);
  } catch (err) {
    console.error(err);
    setSummary(err.message || "Unknown error while loading datasets.", true);
    ui.analyzeBtn.disabled = true;
    clearDownloadLink();
  }
}

function runLineage() {
  try {
    if (!dataOlder || !dataNewer) throw new Error("Load datasets first.");

    lineageNewerBase = buildLineageNewerBase();
    upsertLineageLayer(lineageNewerBase);
    setDownloadLink(lineageNewerBase, "lineage_newer_base.geojson");

    const counts = { merged: 0, split: 0, changed: 0, associated: 0, unmatched: 0 };
    for (const f of lineageNewerBase.features) {
      const s = f.properties?.lineage_status || "unmatched";
      counts[s] = (counts[s] || 0) + 1;
    }

    setSummary(
      `<b>Lineage Results</b><br/>
       merged: ${counts.merged}<br/>
       split: ${counts.split}<br/>
       changed: ${counts.changed}<br/>
       associated: ${counts.associated}<br/>
       unmatched: ${counts.unmatched}<br/>
       <span style="display:inline-block;margin-top:6px;">
         Stable columns: merged 1..${FIXED_MERGED_COLS}, split 1..${FIXED_SPLIT_COLS}, associated 1..${FIXED_ASSOC_COLS}
       </span>`
    );
  } catch (err) {
    console.error(err);
    setSummary(err.message || "Unknown error while building lineage.", true);
  }
}

/* =========================
   Wire up + init
========================= */
function init() {
  // token boot
  const stored = loadTokenFromStorage();
  if (stored) applyToken(stored);

  // modal
  ui.tokenHelpBtn.addEventListener("click", openTokenModal);
  ui.closeTokenModalBtn.addEventListener("click", closeTokenModal);
  ui.tokenModal.addEventListener("click", (e) => {
    if (e.target === ui.tokenModal) closeTokenModal();
  });

  // save token
  ui.saveTokenBtn.addEventListener("click", () => {
    const token = ui.mapboxToken.value.trim();
    saveTokenToStorage(token);
    const check = validateTokenFormat(token);
    setSummary(check.msg ? check.msg : "Token saved. Click “Load datasets”.", !check.ok);
  });

  // mode dropdowns
  ui.olderMode.addEventListener("change", () => {
    setModeUI("older");
  });
  ui.newerMode.addEventListener("change", () => {
    setModeUI("newer");
  });
  setModeUI("older");
  setModeUI("newer");

  // actions
  ui.loadBtn.addEventListener("click", loadDatasets);
  ui.analyzeBtn.addEventListener("click", runLineage);

  // friendly initial state
  ui.analyzeBtn.disabled = true;
  clearDownloadLink();
  const check = validateTokenFormat(ui.mapboxToken.value.trim());
  if (!check.ok) setSummary(check.msg, true);
}

function setModeUI(which) {
  if (which === "older") {
    const mode = ui.olderMode.value;
    ui.olderUrlWrap.style.display = mode === "url" ? "block" : "none";
    ui.olderFileWrap.style.display = mode === "file" ? "block" : "none";
  } else {
    const mode = ui.newerMode.value;
    ui.newerUrlWrap.style.display = mode === "url" ? "block" : "none";
    ui.newerFileWrap.style.display = mode === "file" ? "block" : "none";
  }
}

function loadTokenFromStorage() {
  const t = localStorage.getItem(STORAGE_KEY_TOKEN) || "";
  ui.mapboxToken.value = t;
  return t;
}

function saveTokenToStorage(token) {
  localStorage.setItem(STORAGE_KEY_TOKEN, token);
}

function validateTokenFormat(token) {
  if (!token) return { ok: false, msg: "No Mapbox token set. Click “How do I get a token?” to learn how." };
  if (!token.startsWith("pk.")) return { ok: true, msg: "Warning: token does not start with pk. Ensure it's a public token." };
  return { ok: true, msg: "" };
}

function applyToken(token) {
  mapboxgl.accessToken = token;
}

function openTokenModal() { ui.tokenModal.style.display = "flex"; ui.tokenModal.setAttribute("aria-hidden", "false"); }
function closeTokenModal() { ui.tokenModal.style.display = "none"; ui.tokenModal.setAttribute("aria-hidden", "true"); }

function destroyMaps() {
  mapOlder?.remove(); mapNewer?.remove(); mapLineage?.remove();
  mapOlder = null; mapNewer = null; mapLineage = null;
}

function createMaps() {
  mapOlder = new mapboxgl.Map({ container: "map2019", style: STYLE, center: DEFAULT_VIEW.center, zoom: DEFAULT_VIEW.zoom });
  addNav(mapOlder);

  mapNewer = new mapboxgl.Map({ container: "map2024", style: STYLE, center: DEFAULT_VIEW.center, zoom: DEFAULT_VIEW.zoom });
  addNav(mapNewer);

  mapLineage = new mapboxgl.Map({ container: "mapChanges", style: STYLE, center: DEFAULT_VIEW.center, zoom: DEFAULT_VIEW.zoom });
  addNav(mapLineage);

  mapOlder.on("load", () => {
    mapOlder.addSource("older", { type: "geojson", data: dataOlder });
    mapOlder.addLayer({ id: "older-outline", type: "line", source: "older", paint: { "line-color": "#1f4fff", "line-width": 1 } });
  });

  mapNewer.on("load", () => {
    mapNewer.addSource("newer", { type: "geojson", data: dataNewer });
    mapNewer.addLayer({ id: "newer-outline", type: "line", source: "newer", paint: { "line-color": "#ff2d2d", "line-width": 1 } });
  });

  mapLineage.on("load", () => {
    mapLineage.addSource("older", { type: "geojson", data: dataOlder });
    mapLineage.addLayer({ id: "older-outline-faint", type: "line", source: "older", paint: { "line-color": "#1f4fff", "line-width": 0.7, "line-opacity": 0.25 } });

    mapLineage.addSource("newer", { type: "geojson", data: dataNewer });
    mapLineage.addLayer({ id: "newer-outline-faint", type: "line", source: "newer", paint: { "line-color": "#ff2d2d", "line-width": 0.7, "line-opacity": 0.25 } });
  });

  window.setTimeout(safeResizeAll, 250);
  window.addEventListener("resize", safeResizeAll);
}

function addNav(map) {
  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
}
function safeResizeAll() {
  mapOlder?.resize(); mapNewer?.resize(); mapLineage?.resize();
}

init();
``