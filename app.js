(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("dxfCanvas");
  const ctx = canvas.getContext("2d");

  const state = {
    fileName: "",
    segments: [],
    selectedId: null,
    walls: new Map(),
    detectedUnits: null,
    calibration: { activePoint: null, points: [null, null], feetPerUnit: null },
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

  function updateCalibrationUI() {
    const cal = state.calibration;
    const status = $("calibrationStatus");
    const reset = $("resetCalibrationBtn");
    const badge = $("scaleBadge");
    const hint = $("hintbar");
    const has1 = !!cal.points[0];
    const has2 = !!cal.points[1];
    const hasBoth = has1 && has2;

    $("scale1Btn").classList.toggle("active-tool", cal.activePoint === 0);
    $("scale2Btn").classList.toggle("active-tool", cal.activePoint === 1);
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

    draw();
  }

  function activateScalePoint(index) {
    if (!state.segments.length) {
      alert("Open a DXF drawing first.");
      return;
    }
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
    recalcAllWallsForUnits();
    updateCalibrationUI();
  }

  function resetCalibration() {
    state.calibration.activePoint = null;
    state.calibration.points = [null, null];
    state.calibration.feetPerUnit = null;
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

  function selectSegment(id) {
    state.selectedId = id;
    const seg = state.segments.find(s => s.id === id);
    if (!seg) {
      $("wallForm").classList.add("hidden");
      $("selectionEmpty").classList.remove("hidden");
      draw();
      return;
    }
    $("wallForm").classList.remove("hidden");
    $("selectionEmpty").classList.add("hidden");

    const wall = state.walls.get(id);
    if (wall) {
      $("wallNumber").value = wall.wallNumber;
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
      $("wallHeight").value = "10";
      $("studSize").value = '3-5/8"';
      $("gauge").value = "20ga";
      $("spacing").value = "16";
      $("topTrack").value = "Standard";
      $("bottomTrack").value = "Standard";
      $("doubleEnds").checked = false;
      $("wastePercent").value = "0";
    }
    updateCalcPreview();
    draw();
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
    if (best) selectSegment(best.id);
  }

  function refreshTables() {
    const tbody = $("wallTable").querySelector("tbody");
    tbody.innerHTML = "";

    const walls = [...state.walls.values()].sort((a,b) => a.wallNumber.localeCompare(b.wallNumber, undefined, {numeric:true}));
    for (const w of walls) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(w.wallNumber)}</td>
        <td>${escapeHtml(formatFeetInches(w.lengthFt))}</td>
        <td>${escapeHtml(String(w.height))}'</td>
        <td>${escapeHtml(w.studSize)} ${escapeHtml(w.gauge)}</td>
        <td>${w.studQty}</td>`;
      tr.addEventListener("click", () => selectSegment(w.segmentId));
      tbody.appendChild(tr);
    }

    $("wallCountBadge").textContent = `${walls.length} wall${walls.length === 1 ? "" : "s"}`;
    refreshMaterialSummary(walls);
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

  function saveWallFromForm() {
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

    state.walls.set(s.id, {
      segmentId: s.id,
      wallNumber,
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
      "Wall Number","Length (ft)","Length (ft-in)","Height (ft)","Stud Size","Gauge",
      "Spacing (in OC)","Stud Qty","Top Track","Bottom Track","Track LF","Double Ends","Waste %"
    ]];
    for (const w of walls) {
      rows.push([
        w.wallNumber, w.lengthFt.toFixed(4), formatFeetInches(w.lengthFt), w.height,
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
    state.bounds = computeBounds(parsed.segments);
    state.walls.clear();
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

  $("fitBtn").addEventListener("click", fitDrawing);
  $("exportCsvBtn").addEventListener("click", exportCSV);
  $("unitSelect").addEventListener("change", () => {
    if (state.calibration.feetPerUnit) {
      state.calibration.feetPerUnit = null;
      state.calibration.points = [null, null];
      state.calibration.activePoint = null;
    }
    recalcAllWallsForUnits();
    updateCalibrationUI();
  });

  $("scale1Btn").addEventListener("click", () => activateScalePoint(0));
  $("scale2Btn").addEventListener("click", () => activateScalePoint(1));
  $("applyCalibrationBtn").addEventListener("click", applyCalibration);
  $("cancelCalibrationBtn").addEventListener("click", cancelCalibration);
  $("resetCalibrationBtn").addEventListener("click", resetCalibration);

  $("wallForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveWallFromForm();
  });

  for (const id of ["wallHeight","studSize","gauge","spacing","topTrack","bottomTrack","doubleEnds","wastePercent"]) {
    $(id).addEventListener("input", updateCalcPreview);
    $(id).addEventListener("change", updateCalcPreview);
  }

  $("deleteWallBtn").addEventListener("click", () => {
    if (!state.selectedId) return;
    state.walls.delete(state.selectedId);
    refreshTables();
    selectSegment(state.selectedId);
  });

  $("clearWallsBtn").addEventListener("click", () => {
    if (!state.walls.size) return;
    if (!confirm("Clear all saved wall takeoff items?")) return;
    state.walls.clear();
    refreshTables();
    if (state.selectedId) selectSegment(state.selectedId);
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
  refreshTables();
  updateCalibrationUI();
})();
