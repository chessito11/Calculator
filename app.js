(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("dxfCanvas");
  const ctx = canvas.getContext("2d");

  const WALL_TYPE_STORAGE_KEY = "atlasTakeoffWallTypesV1";

  function loadWallTypes() {
    try {
      const raw = localStorage.getItem(WALL_TYPE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function persistWallTypes() {
    try {
      localStorage.setItem(WALL_TYPE_STORAGE_KEY, JSON.stringify(state.wallTypes));
    } catch (err) {
      // The app still works if private browsing/storage blocks persistence.
    }
  }

  const state = {
    fileName: "",
    segments: [],
    selectedId: null,
    walls: new Map(),
    detectedUnits: null,
    calibration: { activePoint: null, points: [null, null], feetPerUnit: null },
    toolMode: "wall",
    wallTypes: loadWallTypes(),
    activeWallType: "",
    trace: { lastPoint: null },
    history: [],
    view: { scale: 1, offsetX: 0, offsetY: 0 },
    bounds: null,
    dragging: false,
    moved: false,
    dragStart: null,
    pointers: new Map(),
    pinchStartDistance: null,
    pinchStartScale: null
  };

  const INSUNITS = {
    1: "in",
    2: "ft",
    4: "mm",
    5: "cm",
    6: "m"
  };

  function pairDXF(text) {
    const raw = text.replace(/\r/g, "").split("\n");
    const pairs = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      pairs.push({ code: Number(raw[i].trim()), value: raw[i + 1].trim() });
    }
    return pairs;
  }

  function detectInsUnits(pairs) {
    for (let i = 0; i < pairs.length - 2; i++) {
      if (pairs[i].code === 9 && pairs[i].value === "$INSUNITS") {
        for (let j = i + 1; j < Math.min(i + 6, pairs.length); j++) {
          if (pairs[j].code === 70) return INSUNITS[Number(pairs[j].value)] || null;
        }
      }
    }
    return null;
  }

  function parseDXF(text) {
    const pairs = pairDXF(text);
    const segments = [];
    const detectedUnits = detectInsUnits(pairs);

    let inEntities = false;
    let id = 1;
    let polyline = null;

    const addSegment = (x1, y1, x2, y2, sourceType) => {
      const nums = [x1, y1, x2, y2].map(Number);
      if (nums.some(v => !Number.isFinite(v))) return;
      const dx = nums[2] - nums[0], dy = nums[3] - nums[1];
      if (Math.hypot(dx, dy) < 1e-9) return;
      segments.push({
        id: id++,
        x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3],
        sourceType
      });
    };

    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];

      if (p.code === 0 && p.value === "SECTION" && pairs[i + 1]?.code === 2 && pairs[i + 1]?.value === "ENTITIES") {
        inEntities = true;
        i++;
        continue;
      }
      if (inEntities && p.code === 0 && p.value === "ENDSEC") {
        inEntities = false;
        polyline = null;
        continue;
      }
      if (!inEntities || p.code !== 0) continue;

      if (p.value === "LINE") {
        let x1, y1, x2, y2;
        let j = i + 1;
        for (; j < pairs.length && pairs[j].code !== 0; j++) {
          const q = pairs[j];
          if (q.code === 10) x1 = q.value;
          else if (q.code === 20) y1 = q.value;
          else if (q.code === 11) x2 = q.value;
          else if (q.code === 21) y2 = q.value;
        }
        addSegment(x1, y1, x2, y2, "LINE");
        i = j - 1;
      }

      else if (p.value === "LWPOLYLINE") {
        const verts = [];
        let flags = 0;
        let current = null;
        let j = i + 1;
        for (; j < pairs.length && pairs[j].code !== 0; j++) {
          const q = pairs[j];
          if (q.code === 70) flags = Number(q.value);
          else if (q.code === 10) {
            current = { x: Number(q.value), y: null };
            verts.push(current);
          } else if (q.code === 20 && current) {
            current.y = Number(q.value);
          }
        }
        for (let k = 0; k < verts.length - 1; k++) {
          addSegment(verts[k].x, verts[k].y, verts[k + 1].x, verts[k + 1].y, "LWPOLYLINE");
        }
        if ((flags & 1) && verts.length > 2) {
          const a = verts[verts.length - 1], b = verts[0];
          addSegment(a.x, a.y, b.x, b.y, "LWPOLYLINE");
        }
        i = j - 1;
      }

      else if (p.value === "POLYLINE") {
        let flags = 0;
        let j = i + 1;
        for (; j < pairs.length && pairs[j].code !== 0; j++) {
          if (pairs[j].code === 70) flags = Number(pairs[j].value);
        }
        polyline = { verts: [], closed: !!(flags & 1) };
        i = j - 1;
      }

      else if (p.value === "VERTEX" && polyline) {
        let x, y;
        let j = i + 1;
        for (; j < pairs.length && pairs[j].code !== 0; j++) {
          if (pairs[j].code === 10) x = Number(pairs[j].value);
          else if (pairs[j].code === 20) y = Number(pairs[j].value);
        }
        if (Number.isFinite(x) && Number.isFinite(y)) polyline.verts.push({ x, y });
        i = j - 1;
      }

      else if (p.value === "SEQEND" && polyline) {
        for (let k = 0; k < polyline.verts.length - 1; k++) {
          const a = polyline.verts[k], b = polyline.verts[k + 1];
          addSegment(a.x, a.y, b.x, b.y, "POLYLINE");
        }
        if (polyline.closed && polyline.verts.length > 2) {
          const a = polyline.verts[polyline.verts.length - 1], b = polyline.verts[0];
          addSegment(a.x, a.y, b.x, b.y, "POLYLINE");
        }
        polyline = null;
      }
    }

    return { segments, detectedUnits };
  }

  function computeBounds(segments) {
    if (!segments.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of segments) {
      minX = Math.min(minX, s.x1, s.x2);
      minY = Math.min(minY, s.y1, s.y2);
      maxX = Math.max(maxX, s.x1, s.x2);
      maxY = Math.max(maxY, s.y1, s.y2);
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function fitDrawing() {
    if (!state.bounds) return;
    const rect = canvas.getBoundingClientRect();
    const pad = 35;
    const worldW = Math.max(state.bounds.width, 1);
    const worldH = Math.max(state.bounds.height, 1);
    const sx = (rect.width - pad * 2) / worldW;
    const sy = (rect.height - pad * 2) / worldH;
    state.view.scale = Math.max(0.0001, Math.min(sx, sy));
    state.view.offsetX = pad - state.bounds.minX * state.view.scale;
    state.view.offsetY = pad + state.bounds.maxY * state.view.scale;
    draw();
  }

  function worldToScreen(x, y) {
    return {
      x: x * state.view.scale + state.view.offsetX,
      y: state.view.offsetY - y * state.view.scale
    };
  }

  function screenToWorld(x, y) {
    return {
      x: (x - state.view.offsetX) / state.view.scale,
      y: (state.view.offsetY - y) / state.view.scale
    };
  }

  function draw() {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = "#090b0e";
    ctx.fillRect(0, 0, rect.width, rect.height);

    if (!state.segments.length) return;

    ctx.lineCap = "round";
    for (const s of state.segments) {
      const a = worldToScreen(s.x1, s.y1);
      const b = worldToScreen(s.x2, s.y2);
      const isSelected = s.id === state.selectedId;
      const wall = state.walls.get(s.id);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = isSelected ? 4 : (wall ? 2.4 : 1);
      ctx.strokeStyle = isSelected ? "#ffd166" : (wall ? "#4da3ff" : "#d8dde5");
      ctx.stroke();

      if (wall) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.font = "12px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const text = wall.wallNumber;
        const metrics = ctx.measureText(text);
        const w = metrics.width + 10;
        ctx.fillStyle = "#11151b";
        ctx.fillRect(mx - w/2, my - 9, w, 18);
        ctx.fillStyle = "#9fd0ff";
        ctx.fillText(text, mx, my);
      }
    }

    drawCalibrationOverlay();
    drawTraceOverlay();
  }

  function drawTraceOverlay() {
    if (state.toolMode !== "trace" || !state.trace.lastPoint) return;
    const p = worldToScreen(state.trace.lastPoint.x, state.trace.lastPoint.y);
    ctx.save();
    ctx.fillStyle = "#ff9f43";
    ctx.strokeStyle = "#11151b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#11151b";
    ctx.font = "bold 10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("•", p.x, p.y);
    ctx.restore();
  }

  function drawCalibrationOverlay() {
    const pts = state.calibration.points;
    const entries = pts
      .map((p, i) => p ? { p, index: i } : null)
      .filter(Boolean);
    if (!entries.length) return;

    ctx.save();
    ctx.strokeStyle = "#50e3c2";
    ctx.fillStyle = "#50e3c2";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);

    if (pts[0] && pts[1]) {
      const a = worldToScreen(pts[0].x, pts[0].y);
      const b = worldToScreen(pts[1].x, pts[1].y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    entries.forEach(({ p, index }) => {
      const s = worldToScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#081310";
      ctx.font = "bold 11px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(index + 1), s.x, s.y);
      ctx.fillStyle = "#50e3c2";
    });
    ctx.restore();
  }

  function baseFeetPerUnit() {
    return unitToFeetFactor(currentUnit());
  }

  function activeFeetPerUnit() {
    return state.calibration.feetPerUnit || baseFeetPerUnit();
  }

  function rawPointDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function nearestCalibrationPoint(screenX, screenY) {
    let bestEndpoint = null;
    let endpointDistance = 18;
    let bestOnLine = null;
    let lineDistance = 16;

    for (const s of state.segments) {
      const a = worldToScreen(s.x1, s.y1);
      const b = worldToScreen(s.x2, s.y2);

      const da = Math.hypot(screenX - a.x, screenY - a.y);
      if (da < endpointDistance) {
        endpointDistance = da;
        bestEndpoint = { x: s.x1, y: s.y1 };
      }
      const db = Math.hypot(screenX - b.x, screenY - b.y);
      if (db < endpointDistance) {
        endpointDistance = db;
        bestEndpoint = { x: s.x2, y: s.y2 };
      }

      const abx = b.x - a.x, aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      if (len2 > 0) {
        let t = ((screenX - a.x) * abx + (screenY - a.y) * aby) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = a.x + t * abx, py = a.y + t * aby;
        const d = Math.hypot(screenX - px, screenY - py);
        if (d < lineDistance) {
          lineDistance = d;
          bestOnLine = {
            x: s.x1 + t * (s.x2 - s.x1),
            y: s.y1 + t * (s.y2 - s.y1)
          };
        }
      }
    }

    return bestEndpoint || bestOnLine || screenToWorld(screenX, screenY);
  }

  function nearestWallEndpoint(screenX, screenY) {
    let best = null;
    let bestDistance = 24;

    for (const s of state.segments) {
      if (s.sourceType === "MANUAL_WALL") continue;
      const candidates = [
        { x: s.x1, y: s.y1 },
        { x: s.x2, y: s.y2 }
      ];
      for (const p of candidates) {
        const sp = worldToScreen(p.x, p.y);
        const d = Math.hypot(screenX - sp.x, screenY - sp.y);
        if (d < bestDistance) {
          bestDistance = d;
          best = p;
        }
      }
    }
    return best;
  }

  function wallTemplateFromForm() {
    return {
      height: Number($("wallHeight").value),
      studSize: $("studSize").value,
      gauge: $("gauge").value,
      spacing: Number($("spacing").value),
      topTrack: $("topTrack").value,
      bottomTrack: $("bottomTrack").value,
      doubleEnds: $("doubleEnds").checked,
      wastePercent: Number($("wastePercent").value) || 0
    };
  }

  function applyWallTemplate(template) {
    if (!template) return;
    $("wallHeight").value = String(template.height ?? 10);
    $("studSize").value = template.studSize || '3-5/8"';
    $("gauge").value = template.gauge || "20ga";
    $("spacing").value = String(template.spacing ?? 16);
    $("topTrack").value = template.topTrack || "Standard";
    $("bottomTrack").value = template.bottomTrack || "Standard";
    $("doubleEnds").checked = !!template.doubleEnds;
    $("wastePercent").value = Number(template.wastePercent ?? 0);
    updateCalcPreview();
  }

  function setActiveWallType(name, applyToCurrent = false) {
    state.activeWallType = name && state.wallTypes[name] ? name : "";
    $("activeWallTypeSelect").value = state.activeWallType;

    if (applyToCurrent && state.selectedId) {
      $("wallTypeSelect").value = state.activeWallType;
      if (state.activeWallType) applyWallTemplate(state.wallTypes[state.activeWallType]);
    }
  }

  function refreshWallTypeUI() {
    const names = Object.keys(state.wallTypes).sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
    const selects = [$("activeWallTypeSelect"), $("wallTypeSelect")];

    for (const select of selects) {
      if (!select) continue;
      const current = select.id === "activeWallTypeSelect"
        ? state.activeWallType
        : select.value;
      select.innerHTML = '<option value="">Unassigned</option>';
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      select.value = names.includes(current) ? current : "";
    }

    $("wallTypeCountBadge").textContent = `${names.length} type${names.length === 1 ? "" : "s"}`;

    const list = $("wallTypeLibraryList");
    if (!names.length) {
      list.className = "summary-list muted";
      list.textContent = "No wall types saved yet.";
      return;
    }

    list.className = "summary-list";
    list.innerHTML = "";
    for (const name of names) {
      const t = state.wallTypes[name];
      const group = document.createElement("div");
      group.className = "summary-group type-card";
      group.innerHTML = `
        <div class="summary-title">${escapeHtml(name)}</div>
        <div class="summary-item"><span>Stud</span><span>${escapeHtml(t.studSize)} ${escapeHtml(t.gauge)} @ ${t.spacing}" O.C.</span></div>
        <div class="summary-item"><span>Height</span><span>${escapeHtml(String(t.height))}'</span></div>
        <div class="summary-item"><span>Track</span><span>${escapeHtml(t.bottomTrack)} / ${escapeHtml(t.topTrack)}</span></div>`;
      group.addEventListener("click", () => {
        $("wallTypeName").value = name;
        setActiveWallType(name, !!state.selectedId);
        if (state.selectedId) {
          $("wallTypeSelect").value = name;
          applyWallTemplate(t);
        }
      });
      list.appendChild(group);
    }
  }

  function saveWallTypeFromForm() {
    const name = $("wallTypeName").value.trim();
    if (!name) {
      alert("Enter a wall type name first.");
      return;
    }
    state.wallTypes[name] = wallTemplateFromForm();
    persistWallTypes();
    state.activeWallType = name;
    refreshWallTypeUI();
    setActiveWallType(name, !!state.selectedId);
    if (state.selectedId) $("wallTypeSelect").value = name;
  }

  function deleteWallType() {
    const name = $("wallTypeName").value.trim() || state.activeWallType;
    if (!name || !state.wallTypes[name]) {
      alert("Choose a saved wall type first.");
      return;
    }
    if (!confirm(`Delete wall type ${name}? Existing walls keep their saved takeoff data.`)) return;
    delete state.wallTypes[name];
    if (state.activeWallType === name) state.activeWallType = "";
    persistWallTypes();
    $("wallTypeName").value = "";
    refreshWallTypeUI();
  }

  function nextManualSegmentId() {
    let max = 0;
    for (const s of state.segments) max = Math.max(max, Number(s.id) || 0);
    return max + 1;
  }

  function updateTraceUI() {
    $("traceWallsBtn").classList.toggle("active-tool", state.toolMode === "trace");
    if (state.toolMode !== "trace") return;

    const typeText = state.activeWallType ? ` — active type: ${state.activeWallType}` : " — active type: Unassigned";
    if (!state.trace.lastPoint) {
      $("hintbar").textContent = `TRACE WALLS: Tap the first corner. Only DXF endpoints are used${typeText}.`;
    } else {
      $("hintbar").textContent = `TRACE WALLS: Tap the next corner to create a wall. Keep tapping corner-to-corner${typeText}.`;
    }
  }

  function activateTraceMode() {
    if (!state.segments.length) {
      alert("Open a DXF drawing first.");
      return;
    }
    if (state.toolMode === "trace") {
      state.trace.lastPoint = null;
      activateWallMode(false);
      return;
    }
    state.toolMode = "trace";
    state.calibration.activePoint = null;
    state.trace.lastPoint = null;
    hideCalibrationPanel();
    closeMoreMenu();
    selectSegment(null, { preserveMode: true });
    updateToolUI();
    updateCalibrationUI();
    updateTraceUI();
    draw();
  }

  function traceWallPoint(screenX, screenY) {
    const point = nearestWallEndpoint(screenX, screenY);
    if (!point) {
      $("hintbar").textContent = "TRACE WALLS: No DXF corner found there. Tap closer to the corner/end point you want.";
      return;
    }

    if (!state.trace.lastPoint) {
      state.trace.lastPoint = { x: point.x, y: point.y };
      updateTraceUI();
      draw();
      return;
    }

    const a = state.trace.lastPoint;
    const b = point;
    if (rawPointDistance(a, b) < 1e-9) {
      $("hintbar").textContent = "TRACE WALLS: Choose a different corner for the next wall.";
      return;
    }

    pushTakeoffHistory();

    const seg = {
      id: nextManualSegmentId(),
      x1: a.x, y1: a.y,
      x2: b.x, y2: b.y,
      sourceType: "MANUAL_WALL"
    };
    state.segments.push(seg);
    state.trace.lastPoint = { x: b.x, y: b.y };

    selectSegment(seg.id, { preserveMode: true });
    if (state.activeWallType) {
      $("wallTypeSelect").value = state.activeWallType;
      applyWallTemplate(state.wallTypes[state.activeWallType]);
    } else {
      $("wallTypeSelect").value = "";
    }
    saveWallFromForm({ preserveMode: true, skipHistory: true });
    state.toolMode = "trace";
    updateToolUI();
    updateTraceUI();
    draw();
  }

  function closeMoreMenu() {
    const menu = $("moreMenu");
    if (menu) menu.open = false;
  }

  function showCalibrationPanel() {
    $("calibrationPanel").classList.remove("setup-panel-hidden");
  }

  function hideCalibrationPanel() {
    $("calibrationPanel").classList.add("setup-panel-hidden");
  }

  function updateToolUI() {
    const wallActive = state.toolMode === "wall";
    const traceActive = state.toolMode === "trace";
    $("wallModeBtn").classList.toggle("active-tool", wallActive);
    $("traceWallsBtn").classList.toggle("active-tool", traceActive);
    $("selectedWallPanel").classList.toggle("tool-priority", wallActive || traceActive);
    $("calibrationPanel").classList.toggle("tool-priority", !wallActive);

    // Scale buttons still show their own active point state.
    if (wallActive) {
      $("scale1Btn").classList.remove("active-tool");
      $("scale2Btn").classList.remove("active-tool");
    }
  }

  function activateWallMode(scrollPanel = false) {
    state.toolMode = "wall";
    state.trace.lastPoint = null;
    state.calibration.activePoint = null;
    hideCalibrationPanel();
    closeMoreMenu();
    updateToolUI();
    updateCalibrationUI();

    if (scrollPanel && window.innerWidth <= 980) {
      $("selectedWallPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function updateCalibrationUI() {
    const cal = state.calibration;
    const status = $("calibrationStatus");
    const reset = $("resetCalibrationBtn");
    const badge = $("scaleBadge");
    const hint = $("hintbar");
    const has1 = !!cal.points[0];
    const has2 = !!cal.points[1];
    const hasBoth = has1 && has2;

    $("scale1Btn").classList.toggle("active-tool", state.toolMode === "scale" && cal.activePoint === 0);
    $("scale2Btn").classList.toggle("active-tool", state.toolMode === "scale" && cal.activePoint === 1);
    $("scale1Btn").classList.toggle("point-set", has1);
    $("scale2Btn").classList.toggle("point-set", has2);

    $("scale1Status").textContent = has1 ? "Set" : "Not set";
    $("scale2Status").textContent = has2 ? "Set" : "Not set";
    $("applyCalibrationBtn").disabled = !hasBoth;

    if (hasBoth) {
      const raw = rawPointDistance(cal.points[0], cal.points[1]);
      const measured = raw * baseFeetPerUnit();
      $("calibrationMeasured").textContent = formatFeetInches(measured);
    } else {
      $("calibrationMeasured").textContent = "—";
    }

    if (cal.activePoint === 0) {
      status.textContent = "Scale 1 is active. Tap the first point of the known dimension.";
      hint.textContent = "SCALE 1 ACTIVE: Tap point 1. Drag to pan or pinch to zoom.";
    } else if (cal.activePoint === 1) {
      status.textContent = "Scale 2 is active. Tap the second point of the known dimension.";
      hint.textContent = "SCALE 2 ACTIVE: Tap point 2. Drag to pan or pinch to zoom.";
    } else if (hasBoth) {
      status.textContent = cal.feetPerUnit
        ? "Scale 1 and Scale 2 are set. Change the known dimension or either point and Apply again if needed."
        : "Both scale points are set. Enter the known dimension and press Apply Calibration.";
      hint.textContent = "Tap a line to select it. Scale 1 and Scale 2 can be reset independently.";
    } else if (has1 || has2) {
      status.textContent = "One scale point is set. Activate the other Scale button and tap its point.";
      hint.textContent = "Set the remaining scale point, or tap a wall line when no Scale button is active.";
    } else {
      status.textContent = "Set Scale 1 and Scale 2 on a known dimension, then enter the real distance.";
      hint.textContent = "Tap a line to select it. Drag to pan. Pinch or mouse-wheel to zoom.";
    }

    if (cal.feetPerUnit) {
      reset.classList.remove("hidden");
      badge.textContent = "Scale: Calibrated";
      badge.classList.add("calibrated");
    } else {
      reset.classList.toggle("hidden", !(has1 || has2));
      badge.textContent = "Scale: DXF units";
      badge.classList.remove("calibrated");
    }

    updateToolUI();
    draw();
  }

  function activateScalePoint(index) {
    if (!state.segments.length) {
      alert("Open a DXF drawing first.");
      return;
    }
    state.toolMode = "scale";
    state.trace.lastPoint = null;
    showCalibrationPanel();
    closeMoreMenu();
    state.calibration.activePoint =
      state.calibration.activePoint === index ? null : index;
    selectSegment(null);
    updateCalibrationUI();
  }

  function cancelCalibration() {
    state.calibration.activePoint = null;
    updateCalibrationUI();
  }

  function applyCalibration() {
    if (!state.calibration.points[0] || !state.calibration.points[1]) {
      alert("Set both Scale 1 and Scale 2 first.");
      return;
    }
    const feet = Math.max(0, Number($("calibrationFeet").value) || 0);
    const inches = Math.max(0, Number($("calibrationInches").value) || 0);
    const actualFeet = feet + inches / 12;
    if (!(actualFeet > 0)) {
      alert("Enter an actual distance greater than zero.");
      return;
    }
    const raw = rawPointDistance(state.calibration.points[0], state.calibration.points[1]);
    if (!(raw > 0)) {
      alert("Scale 1 and Scale 2 are too close together.");
      return;
    }
    state.calibration.feetPerUnit = actualFeet / raw;
    state.calibration.activePoint = null;
    state.toolMode = "wall";
    hideCalibrationPanel();
    recalcAllWallsForUnits();
    updateCalibrationUI();
  }

  function resetCalibration() {
    state.calibration.activePoint = null;
    state.calibration.points = [null, null];
    state.calibration.feetPerUnit = null;
    state.toolMode = "wall";
    hideCalibrationPanel();
    recalcAllWallsForUnits();
    updateCalibrationUI();
  }

  function currentUnit() {
    const selected = $("unitSelect").value;
    return selected === "auto" ? (state.detectedUnits || "in") : selected;
  }

  function unitToFeetFactor(unit) {
    return {
      in: 1 / 12,
      ft: 1,
      mm: 1 / 304.8,
      cm: 1 / 30.48,
      m: 3.280839895
    }[unit] || 1 / 12;
  }

  function segmentLengthFeet(segment) {
    const raw = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
    return raw * activeFeetPerUnit();
  }

  function formatFeetInches(feet) {
    if (!Number.isFinite(feet)) return "—";
    let totalInches = feet * 12;
    let wholeFeet = Math.floor(totalInches / 12);
    let inches = totalInches - wholeFeet * 12;
    inches = Math.round(inches * 16) / 16;
    if (inches >= 12) { wholeFeet += 1; inches = 0; }
    const wholeIn = Math.floor(inches);
    const frac = inches - wholeIn;
    const fractions = [
      [0, ""], [1/16, "1/16"], [1/8, "1/8"], [3/16, "3/16"], [1/4, "1/4"],
      [5/16, "5/16"], [3/8, "3/8"], [7/16, "7/16"], [1/2, "1/2"],
      [9/16, "9/16"], [5/8, "5/8"], [11/16, "11/16"], [3/4, "3/4"],
      [13/16, "13/16"], [7/8, "7/8"], [15/16, "15/16"]
    ];
    let fracText = "";
    for (const [v, txt] of fractions) if (Math.abs(frac - v) < 0.001) fracText = txt;
    const inchText = fracText ? `${wholeIn || ""}${wholeIn ? " " : ""}${fracText}` : `${wholeIn}`;
    return `${wholeFeet}'-${inchText}"`;
  }

  function calcWall(segment) {
    const lengthFt = segmentLengthFeet(segment);
    const spacing = Number($("spacing").value);
    const lengthIn = lengthFt * 12;
    const base = Math.ceil(lengthIn / spacing) + 1;
    const extraEnds = $("doubleEnds").checked ? 2 : 0;
    const waste = Math.max(0, Number($("wastePercent").value) || 0) / 100;
    const studQty = Math.ceil((base + extraEnds) * (1 + waste));
    const trackFt = lengthFt * (1 + waste);
    return { lengthFt, studQty, trackFt };
  }

  function updateCalcPreview() {
    const s = state.segments.find(x => x.id === state.selectedId);
    if (!s) return;
    const c = calcWall(s);
    $("wallLength").value = formatFeetInches(c.lengthFt);
    $("calcStuds").textContent = `${c.studQty} pcs`;
    $("calcBottom").textContent = $("bottomTrack").value === "None" ? "None" : `${c.trackFt.toFixed(2)} LF`;
    $("calcTop").textContent = $("topTrack").value === "None" ? "None" : `${c.trackFt.toFixed(2)} LF`;
  }

  function nextWallNumber() {
    let max = 0;
    for (const wall of state.walls.values()) {
      const m = String(wall.wallNumber).match(/(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `W-${String(max + 1).padStart(3, "0")}`;
  }

  function selectSegment(id, options = {}) {
    state.selectedId = id;
    const seg = state.segments.find(s => s.id === id);
    if (!seg) {
      $("wallForm").classList.add("hidden");
      $("selectionEmpty").classList.remove("hidden");
      draw();
      return;
    }
    if (!options.preserveMode) {
      state.toolMode = "wall";
      state.trace.lastPoint = null;
      state.calibration.activePoint = null;
    }
    $("wallForm").classList.remove("hidden");
    $("selectionEmpty").classList.add("hidden");
    updateToolUI();

    const wall = state.walls.get(id);
    if (wall) {
      $("wallNumber").value = wall.wallNumber;
      $("wallTypeSelect").value = wall.wallType || "";
      $("wallHeight").value = String(wall.height);
      $("studSize").value = wall.studSize;
      $("gauge").value = wall.gauge;
      $("spacing").value = String(wall.spacing);
      $("topTrack").value = wall.topTrack;
      $("bottomTrack").value = wall.bottomTrack;
      $("doubleEnds").checked = wall.doubleEnds;
      $("wastePercent").value = wall.wastePercent;
    } else {
      $("wallNumber").value = nextWallNumber();
      $("wallTypeSelect").value = state.activeWallType || "";
      $("wallHeight").value = "10";
      $("studSize").value = '3-5/8"';
      $("gauge").value = "20ga";
      $("spacing").value = "16";
      $("topTrack").value = "Standard";
      $("bottomTrack").value = "Standard";
      $("doubleEnds").checked = false;
      $("wastePercent").value = "0";
      if (state.activeWallType && state.wallTypes[state.activeWallType]) {
        applyWallTemplate(state.wallTypes[state.activeWallType]);
      }
    }
    updateCalcPreview();
    draw();
    updateMarkupSelectionHighlight();
  }

  function updateMarkupSelectionHighlight() {
    document.querySelectorAll("#wallTable tbody tr").forEach(tr => {
      tr.classList.toggle("selected-markup", Number(tr.dataset.segmentId) === state.selectedId);
    });
  }

  function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const len2 = abx*abx + aby*aby;
    if (len2 === 0) return Math.hypot(px-ax, py-ay);
    let t = (apx*abx + apy*aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t*abx, y = ay + t*aby;
    return Math.hypot(px-x, py-y);
  }

  function pickSegment(screenX, screenY) {
    let best = null, bestD = 14;
    for (const s of state.segments) {
      const a = worldToScreen(s.x1, s.y1), b = worldToScreen(s.x2, s.y2);
      const d = pointSegmentDistance(screenX, screenY, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) {
      selectSegment(best.id);
      if (window.innerWidth <= 980) {
        $("selectedWallPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }

  function snapshotTakeoff() {
    return {
      walls: [...state.walls.entries()].map(([id, wall]) => [id, { ...wall }]),
      manualSegments: state.segments
        .filter(s => s.sourceType === "MANUAL_WALL")
        .map(s => ({ ...s })),
      selectedId: state.selectedId
    };
  }

  function pushTakeoffHistory() {
    state.history.push(snapshotTakeoff());
    if (state.history.length > 50) state.history.shift();
    updateUndoButton();
  }

  function updateUndoButton() {
    const btn = $("undoLastBtn");
    if (!btn) return;
    btn.disabled = state.history.length === 0;
    btn.textContent = state.history.length ? `Undo Last (${state.history.length})` : "Undo Last";
  }

  function undoLastTakeoff() {
    const snap = state.history.pop();
    if (!snap) return;

    state.walls = new Map(snap.walls.map(([id, wall]) => [Number(id), { ...wall }]));
    state.segments = state.segments.filter(s => s.sourceType !== "MANUAL_WALL");
    for (const s of snap.manualSegments) state.segments.push({ ...s });

    state.selectedId = null;
    state.trace.lastPoint = null;
    refreshTables();

    if (snap.selectedId && state.segments.some(s => s.id === snap.selectedId)) {
      selectSegment(snap.selectedId);
    } else {
      selectSegment(null);
    }
    updateUndoButton();
    draw();
  }

  function focusWallSegment(id) {
    const seg = state.segments.find(s => s.id === id);
    if (!seg) return;

    state.toolMode = "wall";
    state.trace.lastPoint = null;
    selectSegment(id);

    const rect = canvas.getBoundingClientRect();
    const mx = (seg.x1 + seg.x2) / 2;
    const my = (seg.y1 + seg.y2) / 2;
    state.view.offsetX = rect.width / 2 - mx * state.view.scale;
    state.view.offsetY = rect.height / 2 + my * state.view.scale;
    draw();

    if (window.innerWidth <= 980) {
      $("selectedWallPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function deleteWallById(id, ask = false) {
    const wall = state.walls.get(id);
    if (!wall) return;

    if (ask && !confirm(`Delete ${wall.wallNumber}${wall.wallType ? ` (${wall.wallType})` : ""}?`)) return;

    pushTakeoffHistory();

    const seg = state.segments.find(s => s.id === id);
    state.walls.delete(id);

    if (seg && seg.sourceType === "MANUAL_WALL") {
      state.segments = state.segments.filter(s => s.id !== id);
    }

    if (state.selectedId === id) {
      state.selectedId = null;
      selectSegment(null);
    }

    refreshTables();
    draw();
  }

  function refreshMarkupsFilter(walls) {
    const filter = $("markupsTypeFilter");
    if (!filter) return;
    const current = filter.value;
    const types = [...new Set(walls.map(w => w.wallType || "Unassigned"))]
      .sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));

    filter.innerHTML = '<option value="">All types</option>';
    for (const type of types) {
      const opt = document.createElement("option");
      opt.value = type;
      opt.textContent = type;
      filter.appendChild(opt);
    }
    filter.value = types.includes(current) ? current : "";
  }

  function refreshTables() {
    const tbody = $("wallTable").querySelector("tbody");
    tbody.innerHTML = "";

    const walls = [...state.walls.values()].sort((a,b) => {
      const ta = a.wallType || "ZZZ-Unassigned";
      const tb = b.wallType || "ZZZ-Unassigned";
      return ta.localeCompare(tb, undefined, {numeric:true}) ||
        a.wallNumber.localeCompare(b.wallNumber, undefined, {numeric:true});
    });

    refreshMarkupsFilter(walls);
    const filterValue = $("markupsTypeFilter")?.value || "";
    const visibleWalls = filterValue
      ? walls.filter(w => (w.wallType || "Unassigned") === filterValue)
      : walls;

    for (const w of visibleWalls) {
      const tr = document.createElement("tr");
      tr.dataset.segmentId = String(w.segmentId);
      if (w.segmentId === state.selectedId) tr.classList.add("selected-markup");

      tr.innerHTML = `
        <td><strong>${escapeHtml(w.wallNumber)}</strong></td>
        <td>${escapeHtml(w.wallType || "—")}</td>
        <td>${escapeHtml(formatFeetInches(w.lengthFt))}</td>
        <td>${escapeHtml(String(w.height))}'</td>
        <td>${escapeHtml(w.studSize)} ${escapeHtml(w.gauge)}</td>
        <td>${w.studQty}</td>
        <td class="markup-actions">
          <button class="markup-locate" type="button" title="Locate wall">Locate</button>
          <button class="markup-delete" type="button" title="Delete wall">Delete</button>
        </td>`;

      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        focusWallSegment(w.segmentId);
      });

      tr.querySelector(".markup-locate").addEventListener("click", (e) => {
        e.stopPropagation();
        focusWallSegment(w.segmentId);
      });

      tr.querySelector(".markup-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteWallById(w.segmentId, true);
      });

      tbody.appendChild(tr);
    }

    $("wallCountBadge").textContent = `${walls.length} wall${walls.length === 1 ? "" : "s"}`;
    $("markupsCountBadge").textContent = filterValue
      ? `${visibleWalls.length} of ${walls.length}`
      : `${walls.length} item${walls.length === 1 ? "" : "s"}`;

    updateUndoButton();
    refreshWallTypeTotals(walls);
    refreshMaterialSummary(walls);
  }

  function refreshWallTypeTotals(walls) {
    const el = $("wallTypeTotals");
    if (!walls.length) {
      el.className = "summary-list muted";
      el.textContent = "No walls saved yet.";
      return;
    }

    const groups = new Map();
    for (const w of walls) {
      const name = w.wallType || "Unassigned";
      if (!groups.has(name)) {
        groups.set(name, { count: 0, lengthFt: 0, studs: 0, topFt: 0, bottomFt: 0 });
      }
      const g = groups.get(name);
      g.count += 1;
      g.lengthFt += w.lengthFt;
      g.studs += w.studQty;
      if (w.topTrack !== "None") g.topFt += w.trackFt;
      if (w.bottomTrack !== "None") g.bottomFt += w.trackFt;
    }

    el.className = "summary-list";
    el.innerHTML = "";
    const names = [...groups.keys()].sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
    for (const name of names) {
      const g = groups.get(name);
      const group = document.createElement("div");
      group.className = "summary-group wall-type-total";
      group.innerHTML = `
        <div class="summary-title">${escapeHtml(name)}</div>
        <div class="summary-item"><span>Walls</span><span>${g.count}</span></div>
        <div class="summary-item"><span>Total wall length</span><span>${formatFeetInches(g.lengthFt)} (${g.lengthFt.toFixed(2)} LF)</span></div>
        <div class="summary-item"><span>Total studs</span><span>${g.studs} pcs</span></div>
        <div class="summary-item"><span>Top track</span><span>${g.topFt.toFixed(2)} LF</span></div>
        <div class="summary-item"><span>Bottom track</span><span>${g.bottomFt.toFixed(2)} LF</span></div>`;
      el.appendChild(group);
    }
  }

  function refreshMaterialSummary(walls) {
    const el = $("materialSummary");
    if (!walls.length) {
      el.className = "summary-list muted";
      el.textContent = "No walls saved yet.";
      return;
    }
    el.className = "summary-list";
    const studs = new Map(), tracks = new Map();

    for (const w of walls) {
      const skey = `${w.studSize} ${w.gauge} × ${w.height}'`;
      studs.set(skey, (studs.get(skey) || 0) + w.studQty);

      if (w.bottomTrack !== "None") {
        const key = `${w.studSize} ${w.gauge} — Bottom ${w.bottomTrack}`;
        tracks.set(key, (tracks.get(key) || 0) + w.trackFt);
      }
      if (w.topTrack !== "None") {
        const key = `${w.studSize} ${w.gauge} — Top ${w.topTrack}`;
        tracks.set(key, (tracks.get(key) || 0) + w.trackFt);
      }
    }

    el.innerHTML = "";
    el.appendChild(makeSummaryGroup("STUDS", [...studs.entries()].map(([k,v]) => [k, `${v} pcs`])));
    el.appendChild(makeSummaryGroup("TRACK", [...tracks.entries()].map(([k,v]) => [k, `${v.toFixed(2)} LF`])));
  }

  function makeSummaryGroup(title, items) {
    const group = document.createElement("div");
    group.className = "summary-group";
    const head = document.createElement("div");
    head.className = "summary-title";
    head.textContent = title;
    group.appendChild(head);
    for (const [label, value] of items) {
      const row = document.createElement("div");
      row.className = "summary-item";
      const a = document.createElement("span"), b = document.createElement("span");
      a.textContent = label; b.textContent = value;
      row.append(a,b);
      group.appendChild(row);
    }
    return group;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function saveWallFromForm(options = {}) {
    const s = state.segments.find(x => x.id === state.selectedId);
    if (!s) return;
    const c = calcWall(s);
    const wallNumber = $("wallNumber").value.trim() || nextWallNumber();

    for (const [id, w] of state.walls.entries()) {
      if (id !== s.id && w.wallNumber.toLowerCase() === wallNumber.toLowerCase()) {
        alert(`Wall number ${wallNumber} is already in use.`);
        return;
      }
    }

    if (!options.skipHistory) pushTakeoffHistory();

    state.walls.set(s.id, {
      segmentId: s.id,
      wallNumber,
      wallType: $("wallTypeSelect").value || "",
      lengthFt: c.lengthFt,
      height: Number($("wallHeight").value),
      studSize: $("studSize").value,
      gauge: $("gauge").value,
      spacing: Number($("spacing").value),
      topTrack: $("topTrack").value,
      bottomTrack: $("bottomTrack").value,
      doubleEnds: $("doubleEnds").checked,
      wastePercent: Number($("wastePercent").value) || 0,
      studQty: c.studQty,
      trackFt: c.trackFt
    });

    refreshTables();
    if (!options.preserveMode) state.toolMode = "wall";
    draw();
  }

  function recalcAllWallsForUnits() {
    for (const [id, wall] of state.walls.entries()) {
      const s = state.segments.find(x => x.id === id);
      if (!s) continue;
      const oldSelected = state.selectedId;
      state.selectedId = id;

      $("spacing").value = String(wall.spacing);
      $("doubleEnds").checked = wall.doubleEnds;
      $("wastePercent").value = wall.wastePercent;
      const c = calcWall(s);
      wall.lengthFt = c.lengthFt;
      wall.studQty = c.studQty;
      wall.trackFt = c.trackFt;
      state.selectedId = oldSelected;
    }
    if (state.selectedId) selectSegment(state.selectedId);
    refreshTables();
    draw();
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    return `"${s.replace(/"/g, '""')}"`;
  }

  function exportCSV() {
    const walls = [...state.walls.values()].sort((a,b) => a.wallNumber.localeCompare(b.wallNumber, undefined, {numeric:true}));
    if (!walls.length) {
      alert("Save at least one wall before exporting.");
      return;
    }
    const rows = [[
      "Wall Number","Wall Type","Length (ft)","Length (ft-in)","Height (ft)","Stud Size","Gauge",
      "Spacing (in OC)","Stud Qty","Top Track","Bottom Track","Track LF","Double Ends","Waste %"
    ]];
    for (const w of walls) {
      rows.push([
        w.wallNumber, w.wallType || "", w.lengthFt.toFixed(4), formatFeetInches(w.lengthFt), w.height,
        w.studSize, w.gauge, w.spacing, w.studQty, w.topTrack, w.bottomTrack,
        w.trackFt.toFixed(2), w.doubleEnds ? "Yes" : "No", w.wastePercent
      ]);
    }
    const csv = rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.fileName || "atlas-takeoff").replace(/\.dxf$/i,"")}-wall-takeoff.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.addEventListener("pointerdown", (e) => {
    const menu = $("moreMenu");
    if (menu && menu.open && !menu.contains(e.target)) {
      menu.open = false;
    }
  });

  $("openDxfBtn").addEventListener("click", () => {
    const input = $("dxfFile");
    input.value = "";
    input.click();
  });

  $("dxfFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!/\.dxf$/i.test(file.name)) {
      alert("Please choose a DXF file. On iPhone/iPad, use Browse in the Files picker if the DXF is stored in iCloud Drive or Downloads.");
      return;
    }

    const text = await file.text();
    const parsed = parseDXF(text);

    state.fileName = file.name;
    state.segments = parsed.segments;
    state.detectedUnits = parsed.detectedUnits;
    state.calibration = { activePoint: null, points: [null, null], feetPerUnit: null };
    state.toolMode = "wall";
    state.trace.lastPoint = null;
    state.bounds = computeBounds(parsed.segments);
    state.walls.clear();
    state.history = [];
    state.selectedId = null;

    $("emptyState").style.display = parsed.segments.length ? "none" : "flex";
    $("fileStatus").textContent = parsed.segments.length
      ? `${file.name} — ${parsed.segments.length.toLocaleString()} selectable line segments${parsed.detectedUnits ? ` — units detected: ${parsed.detectedUnits}` : ""}`
      : `${file.name} — no LINE/LWPOLYLINE/POLYLINE geometry found`;

    refreshTables();
    selectSegment(null);
    updateCalibrationUI();
    fitDrawing();
  });

  $("fitBtn").addEventListener("click", () => {
    fitDrawing();
    closeMoreMenu();
  });
  $("exportCsvBtn").addEventListener("click", () => {
    exportCSV();
    closeMoreMenu();
  });
  $("unitSelect").addEventListener("change", () => {
    if (state.calibration.feetPerUnit) {
      state.calibration.feetPerUnit = null;
      state.calibration.points = [null, null];
      state.calibration.activePoint = null;
    }
    recalcAllWallsForUnits();
    updateCalibrationUI();
  });

  $("wallModeBtn").addEventListener("click", () => activateWallMode(true));
  $("traceWallsBtn").addEventListener("click", activateTraceMode);
  $("scale1Btn").addEventListener("click", () => activateScalePoint(0));
  $("scale2Btn").addEventListener("click", () => activateScalePoint(1));
  $("applyCalibrationBtn").addEventListener("click", applyCalibration);
  $("cancelCalibrationBtn").addEventListener("click", cancelCalibration);
  $("resetCalibrationBtn").addEventListener("click", resetCalibration);

  $("activeWallTypeSelect").addEventListener("change", (e) => {
    setActiveWallType(e.target.value, false);
    updateTraceUI();
  });

  $("wallTypeSelect").addEventListener("change", (e) => {
    const name = e.target.value;
    if (name && state.wallTypes[name]) {
      state.activeWallType = name;
      $("activeWallTypeSelect").value = name;
      $("wallTypeName").value = name;
      applyWallTemplate(state.wallTypes[name]);
    }
  });

  $("saveWallTypeBtn").addEventListener("click", saveWallTypeFromForm);
  $("deleteWallTypeBtn").addEventListener("click", deleteWallType);

  $("undoLastBtn").addEventListener("click", undoLastTakeoff);
  $("markupsTypeFilter").addEventListener("change", refreshTables);

  $("wallForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveWallFromForm();
  });

  for (const id of ["wallHeight","studSize","gauge","spacing","topTrack","bottomTrack","doubleEnds","wastePercent"]) {
    $(id).addEventListener("input", updateCalcPreview);
    $(id).addEventListener("change", updateCalcPreview);
  }

  $("deleteWallBtn").addEventListener("click", () => {
    if (!state.selectedId || !state.walls.has(state.selectedId)) return;
    deleteWallById(state.selectedId, true);
  });

  $("clearWallsBtn").addEventListener("click", () => {
    if (!state.walls.size) return;
    if (!confirm("Clear ALL takeoff wall markups? You can use Undo Last immediately afterward.")) return;
    pushTakeoffHistory();
    state.walls.clear();
    state.segments = state.segments.filter(s => s.sourceType !== "MANUAL_WALL");
    state.trace.lastPoint = null;
    state.selectedId = null;
    refreshTables();
    selectSegment(null);
    draw();
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const before = screenToWorld(mx, my);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.view.scale = Math.max(0.00001, Math.min(1e7, state.view.scale * factor));
    state.view.offsetX = mx - before.x * state.view.scale;
    state.view.offsetY = my + before.y * state.view.scale;
    draw();
  }, {passive:false});

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    state.pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if (state.pointers.size === 1) {
      state.dragging = true;
      state.moved = false;
      state.dragStart = {x:e.clientX,y:e.clientY, ox:state.view.offsetX, oy:state.view.offsetY};
    } else if (state.pointers.size === 2) {
      const pts = [...state.pointers.values()];
      state.pinchStartDistance = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
      state.pinchStartScale = state.view.scale;
      state.dragging = false;
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!state.pointers.has(e.pointerId)) return;
    state.pointers.set(e.pointerId, {x:e.clientX,y:e.clientY});

    if (state.pointers.size === 2) {
      const pts = [...state.pointers.values()];
      const d = Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
      if (state.pinchStartDistance && state.pinchStartScale) {
        const rect = canvas.getBoundingClientRect();
        const mx = ((pts[0].x + pts[1].x)/2) - rect.left;
        const my = ((pts[0].y + pts[1].y)/2) - rect.top;
        const before = screenToWorld(mx,my);
        state.view.scale = Math.max(0.00001, Math.min(1e7, state.pinchStartScale * (d/state.pinchStartDistance)));
        state.view.offsetX = mx - before.x * state.view.scale;
        state.view.offsetY = my + before.y * state.view.scale;
        draw();
      }
      return;
    }

    if (state.dragging && state.dragStart) {
      const dx = e.clientX - state.dragStart.x;
      const dy = e.clientY - state.dragStart.y;
      if (Math.hypot(dx,dy) > 4) state.moved = true;
      state.view.offsetX = state.dragStart.ox + dx;
      state.view.offsetY = state.dragStart.oy + dy;
      draw();
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    const rect = canvas.getBoundingClientRect();
    const hadOne = state.pointers.size === 1;
    state.pointers.delete(e.pointerId);

    if (hadOne && !state.moved) {
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (state.calibration.activePoint !== null) {
        const pointIndex = state.calibration.activePoint;
        const p = nearestCalibrationPoint(sx, sy);
        state.calibration.points[pointIndex] = p;
        state.calibration.activePoint = null;
        // Changing either point invalidates the previous calibration until Apply is pressed again.
        state.calibration.feetPerUnit = null;
        recalcAllWallsForUnits();
        updateCalibrationUI();
      } else if (state.toolMode === "trace") {
        traceWallPoint(sx, sy);
      } else {
        pickSegment(sx, sy);
      }
    }

    if (state.pointers.size < 2) {
      state.pinchStartDistance = null;
      state.pinchStartScale = null;
    }
    if (state.pointers.size === 0) {
      state.dragging = false;
      state.dragStart = null;
    }
  });

  canvas.addEventListener("pointercancel", (e) => {
    state.pointers.delete(e.pointerId);
    if (!state.pointers.size) {
      state.dragging = false;
      state.dragStart = null;
    }
  });

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  refreshWallTypeUI();
  refreshTables();
  updateCalibrationUI();
  updateTraceUI();
})();
