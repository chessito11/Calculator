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
    projectName: "",
    savedProjectId: null,
    projectDirty: false,
    fullscreenFallback: false,
    fullscreenPersistent: false,
    segments: [],
    labels: [],
    selectedId: null,
    walls: new Map(),
    detectedUnits: null,
    calibration: { activePoint: null, points: [null, null], feetPerUnit: null },
    toolMode: "wall",
    wallTypes: loadWallTypes(),
    activeWallType: "",
    editingWallTypeOriginalName: "",
    trace: { lastPoint: null, locked: false, ortho: false },
    markupCollapsedGroups: new Set(),
    tempArea: {
      selecting: false,
      closed: false,
      points: [],
      wallIds: new Set()
    },
    history: [],
    view: { scale: 1, offsetX: 0, offsetY: 0 },
    bounds: null,
    dragging: false,
    moved: false,
    dragStart: null,
    pointers: new Map(),
    pinchStartDistance: null,
    pinchStartScale: null,
    pdfImport: {
      fileName: "",
      bytes: null,
      doc: null,
      pageCount: 0,
      conversion: null,
      library: null
    }
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
    const labels = [];
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


      else if (p.value === "TEXT" || p.value === "MTEXT") {
        let x, y, height = 0.15, rotation = 0;
        const parts = [];
        let j = i + 1;
        for (; j < pairs.length && pairs[j].code !== 0; j++) {
          const q = pairs[j];
          if (q.code === 10) x = Number(q.value);
          else if (q.code === 20) y = Number(q.value);
          else if (q.code === 40) height = Number(q.value);
          else if (q.code === 50) rotation = Number(q.value);
          else if (q.code === 1 || q.code === 3) parts.push(q.value);
        }
        const text = parts.join("").replace(/\\P/g, "\n").trim();
        if (Number.isFinite(x) && Number.isFinite(y) && text) {
          labels.push({
            x, y,
            height: Number.isFinite(height) && height > 0 ? height : 0.15,
            rotation: Number.isFinite(rotation) ? rotation : 0,
            text,
            sourceType: p.value
          });
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

    return { segments, labels, detectedUnits };
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


  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      const intersect = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function onSegment(a, b, p) {
    return Math.min(a.x,b.x) - 1e-9 <= p.x && p.x <= Math.max(a.x,b.x) + 1e-9 &&
      Math.min(a.y,b.y) - 1e-9 <= p.y && p.y <= Math.max(a.y,b.y) + 1e-9;
  }

  function segmentsIntersect(a, b, c, d) {
    const o1 = orient(a,b,c), o2 = orient(a,b,d), o3 = orient(c,d,a), o4 = orient(c,d,b);
    if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) &&
        (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) return true;
    if (Math.abs(o1) < 1e-9 && onSegment(a,b,c)) return true;
    if (Math.abs(o2) < 1e-9 && onSegment(a,b,d)) return true;
    if (Math.abs(o3) < 1e-9 && onSegment(c,d,a)) return true;
    if (Math.abs(o4) < 1e-9 && onSegment(c,d,b)) return true;
    return false;
  }

  function wallInsideTemporaryArea(segment, polygon) {
    const a = {x: segment.x1, y: segment.y1};
    const b = {x: segment.x2, y: segment.y2};
    const mid = {x: (a.x+b.x)/2, y: (a.y+b.y)/2};

    if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon) || pointInPolygon(mid, polygon)) {
      return true;
    }

    for (let i = 0; i < polygon.length; i++) {
      const c = polygon[i];
      const d = polygon[(i+1) % polygon.length];
      if (segmentsIntersect(a,b,c,d)) return true;
    }
    return false;
  }

  function updateTemporaryAreaWalls() {
    state.tempArea.wallIds = new Set();
    if (!state.tempArea.closed || state.tempArea.points.length < 3) return;

    for (const [id] of state.walls) {
      const segment = state.segments.find(s => s.id === id);
      if (segment && wallInsideTemporaryArea(segment, state.tempArea.points)) {
        state.tempArea.wallIds.add(id);
      }
    }
  }

  function updateTemporaryAreaUI() {
    const count = state.tempArea.points.length;
    const closed = state.tempArea.closed;

    $("areaSelectBtn").classList.toggle("active-tool", state.tempArea.selecting);
    $("areaSelectBtn").textContent = state.tempArea.selecting ? `POINT ${Math.min(count+1,4)} / 4` : "AREA SELECT";
    $("closeAreaBtn").disabled = count < 3 || closed;
    $("clearTempAreaBtn").disabled = !count && !closed;

    $("fsAreaSelectBtn").classList.toggle("active-tool", state.tempArea.selecting);
    $("fsAreaSelectBtn").textContent = state.tempArea.selecting ? `POINT ${Math.min(count+1,4)} / 4` : "AREA SELECT";
    $("fsCloseAreaBtn").disabled = count < 3 || closed;
    $("fsClearTempAreaBtn").disabled = !count && !closed;
  }

  function startTemporaryAreaSelection() {
    if (!state.segments.length) {
      alert("Open a DXF drawing first.");
      return;
    }
    state.tempArea = {
      selecting: true,
      closed: false,
      points: [],
      wallIds: new Set()
    };
    if ($("viewerOptionsMenu")) $("viewerOptionsMenu").open = false;
    $("hintbar").textContent = "AREA SELECT: tap corner 1 of 4.";
    updateTemporaryAreaUI();
    refreshTemporaryAreaTotals();
    draw();
  }

  function addTemporaryAreaPoint(screenX, screenY) {
    if (!state.tempArea.selecting || state.tempArea.closed) return false;
    if (state.tempArea.points.length >= 4) return true;

    const world = screenToWorld(screenX, screenY);
    state.tempArea.points.push({x: world.x, y: world.y});

    const count = state.tempArea.points.length;
    if (count < 4) {
      $("hintbar").textContent = `AREA SELECT: tap corner ${count+1} of 4.`;
    } else {
      state.tempArea.selecting = false;
      $("hintbar").textContent = "4 area points selected • press CLOSE AREA for temporary totals.";
    }

    updateTemporaryAreaUI();
    draw();
    return true;
  }

  function closeTemporaryArea() {
    if (state.tempArea.points.length < 3) return;
    state.tempArea.closed = true;
    state.tempArea.selecting = false;
    updateTemporaryAreaWalls();
    updateTemporaryAreaUI();
    refreshTables();
    refreshTemporaryAreaTotals();
    draw();

    const count = state.tempArea.wallIds.size;
    $("hintbar").textContent = `AREA CLOSED • ${count} saved wall${count === 1 ? "" : "s"} included in temporary totals.`;
  }

  function clearTemporaryArea() {
    state.tempArea = {
      selecting: false,
      closed: false,
      points: [],
      wallIds: new Set()
    };
    updateTemporaryAreaUI();
    refreshTables();
    refreshTemporaryAreaTotals();
    draw();
    $("hintbar").textContent = "Temporary area cleared • full takeoff totals restored.";
  }

  function getTemporaryAreaWalls(walls) {
    if (!state.tempArea.closed) return walls;
    updateTemporaryAreaWalls();
    return walls.filter(w => state.tempArea.wallIds.has(w.segmentId));
  }

  function refreshTemporaryAreaTotals() {
    const el = $("temporaryAreaTotals");
    if (!el) return;

    if (!state.tempArea.closed) {
      el.className = "temporary-area-totals muted";
      el.textContent = state.tempArea.points.length
        ? `${state.tempArea.points.length} area point${state.tempArea.points.length === 1 ? "" : "s"} selected • press CLOSE AREA`
        : "No temporary area closed.";
      return;
    }

    const walls = getTemporaryAreaWalls([...state.walls.values()]);
    let studs = 0;
    let lf = 0;
    for (const w of walls) {
      studs += Number(w.studQty || 0);
      lf += Number(w.lengthFt || 0);
    }

    el.className = "temporary-area-totals";
    el.innerHTML = `
      <div class="temp-total-card"><span>Walls</span><strong>${walls.length}</strong></div>
      <div class="temp-total-card"><span>Studs</span><strong>${studs}</strong></div>
      <div class="temp-total-card"><span>Linear Feet</span><strong>${lf.toFixed(1)} LF</strong></div>
    `;
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
      const inTempArea = state.tempArea.closed && state.tempArea.wallIds.has(s.id);
      ctx.lineWidth = isSelected ? 4 : (wall ? (inTempArea ? 3.2 : 2.4) : 1);
      ctx.strokeStyle = isSelected ? "#ffd166" : (wall ? (inTempArea ? "#65d68a" : "#4da3ff") : "#d8dde5");
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

    drawPdfLabels();
    drawTemporaryAreaOverlay();
    drawCalibrationOverlay();
    drawTraceOverlay();
  }


  function drawPdfLabels() {
    if (!state.labels?.length) return;

    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#aeb8c5";

    // Avoid turning a dense PDF note sheet into a solid block of text.
    const maxLabels = 3500;
    const step = state.labels.length > maxLabels
      ? Math.ceil(state.labels.length / maxLabels)
      : 1;

    for (let i = 0; i < state.labels.length; i += step) {
      const label = state.labels[i];
      if (!label?.text) continue;

      const p = worldToScreen(label.x, label.y);
      const rawPx = Math.abs((Number(label.height) || 0.08) * state.view.scale);
      const fontPx = Math.max(7, Math.min(18, rawPx || 9));

      // Skip labels that are extremely tiny at the current zoom.
      if (fontPx <= 7 && state.view.scale < 25) continue;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-(Number(label.rotation) || 0) * Math.PI / 180);
      ctx.font = `${fontPx}px system-ui`;
      ctx.textAlign = "left";

      const lines = String(label.text).split(/\r?\n/).slice(0, 4);
      lines.forEach((line, lineIndex) => {
        ctx.fillText(line, 0, lineIndex * fontPx * 1.08);
      });
      ctx.restore();
    }
    ctx.restore();
  }

  function drawTemporaryAreaOverlay() {
    const pts = state.tempArea.points;
    if (!pts.length) return;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = state.tempArea.closed ? "#65d68a" : "#f4c95d";
    ctx.fillStyle = state.tempArea.closed ? "rgba(101,214,138,.10)" : "rgba(244,201,93,.06)";
    ctx.setLineDash(state.tempArea.closed ? [] : [7,5]);

    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = worldToScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });

    if (state.tempArea.closed && pts.length >= 3) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
    ctx.setLineDash([]);

    pts.forEach((p, i) => {
      const s = worldToScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI*2);
      ctx.fillStyle = "#11151b";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = state.tempArea.closed ? "#65d68a" : "#f4c95d";
      ctx.stroke();

      ctx.font = "bold 10px system-ui";
      ctx.fillStyle = state.tempArea.closed ? "#8ef0aa" : "#ffe399";
      ctx.fillText(String(i+1), s.x+7, s.y-7);
    });

    ctx.restore();
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

  function updateCurrentTypeBadge() {
    const name = state.activeWallType || "Unassigned";
    const el = $("currentTypeBadge");
    el.textContent = `TYPE: ${name}`;
    const t = state.wallTypes[state.activeWallType];
    el.title = t
      ? `${name} • ${t.studSize} ${t.gauge} @ ${t.spacing}" O.C. • Height ${t.height}'`
      : "No saved wall type selected; trace walls will be unassigned.";
    el.classList.toggle("type-assigned", !!t);
    $("fsCurrentTypeBadge").textContent = `TYPE: ${name}`;
    $("fsCurrentTypeBadge").title = el.title;
    $("fsCurrentTypeBadge").classList.toggle("type-assigned", !!t);
  }

  function setActiveWallType(name, applyToCurrent = false) {
    state.activeWallType = name && state.wallTypes[name] ? name : "";
    $("activeWallTypeSelect").value = state.activeWallType;
    updateCurrentTypeBadge();

    if (applyToCurrent && state.selectedId) {
      $("wallTypeSelect").value = state.activeWallType;
      if (state.activeWallType) applyWallTemplate(state.wallTypes[state.activeWallType]);
    }
  }

  function calculateWallFromTemplate(segment, template) {
    const lengthFt = segmentLengthFeet(segment);
    const spacing = Math.max(1, Number(template.spacing) || 16);
    const lengthIn = lengthFt * 12;
    const base = Math.ceil(lengthIn / spacing) + 1;
    const extraEnds = template.doubleEnds ? 2 : 0;
    const waste = Math.max(0, Number(template.wastePercent) || 0) / 100;
    return {
      lengthFt,
      studQty: Math.ceil((base + extraEnds) * (1 + waste)),
      trackFt: lengthFt * (1 + waste)
    };
  }

  function updateWallsUsingType(oldName, newName, template) {
    pushTakeoffHistory();
    for (const [id, wall] of state.walls.entries()) {
      if ((wall.wallType || "") !== oldName) continue;
      const seg = state.segments.find(s => s.id === id);
      if (!seg) continue;
      const c = calculateWallFromTemplate(seg, template);
      wall.wallType = newName;
      wall.height = Number(template.height);
      wall.studSize = template.studSize;
      wall.gauge = template.gauge;
      wall.spacing = Number(template.spacing);
      wall.topTrack = template.topTrack;
      wall.bottomTrack = template.bottomTrack;
      wall.doubleEnds = !!template.doubleEnds;
      wall.wastePercent = Number(template.wastePercent) || 0;
      wall.lengthFt = c.lengthFt;
      wall.studQty = c.studQty;
      wall.trackFt = c.trackFt;
    }
  }

  function openWallTypeEditor(name) {
    if ($("wallTypePanel") && "open" in $("wallTypePanel")) $("wallTypePanel").open = true;
    const t = state.wallTypes[name];
    if (!t) return;
    state.editingWallTypeOriginalName = name;
    $("editTypeName").value = name;
    $("editTypeHeight").value = String(t.height ?? 10);
    $("editTypeStudSize").value = t.studSize || '3-5/8"';
    $("editTypeGauge").value = t.gauge || "20ga";
    $("editTypeSpacing").value = String(t.spacing ?? 16);
    $("editTypeTopTrack").value = t.topTrack || "Standard";
    $("editTypeBottomTrack").value = t.bottomTrack || "Standard";
    $("editTypeDoubleEnds").checked = !!t.doubleEnds;
    $("editTypeWaste").value = Number(t.wastePercent ?? 0);
    $("editTypeUpdateExisting").checked = true;
    $("wallTypeEditorStatus").textContent = `${name} is ready to edit.`;
    $("wallTypeEditorDialog").classList.remove("hidden");
  }

  function closeWallTypeEditor() {
    $("wallTypeEditorDialog").classList.add("hidden");
    $("wallTypeEditorStatus").textContent = "";
  }

  function editorTemplateFromFields() {
    return {
      height: Number($("editTypeHeight").value),
      studSize: $("editTypeStudSize").value,
      gauge: $("editTypeGauge").value,
      spacing: Number($("editTypeSpacing").value),
      topTrack: $("editTypeTopTrack").value,
      bottomTrack: $("editTypeBottomTrack").value,
      doubleEnds: $("editTypeDoubleEnds").checked,
      wastePercent: Number($("editTypeWaste").value) || 0
    };
  }

  function saveWallTypeEditor() {
    const oldName = state.editingWallTypeOriginalName;
    if (!oldName || !state.wallTypes[oldName]) {
      $("wallTypeEditorStatus").textContent = "That wall type is no longer available.";
      return;
    }
    const newName = $("editTypeName").value.trim();
    if (!newName) {
      $("wallTypeEditorStatus").textContent = "Enter a wall type name.";
      return;
    }
    if (newName !== oldName && state.wallTypes[newName]) {
      $("wallTypeEditorStatus").textContent = `A wall type named ${newName} already exists.`;
      return;
    }

    const template = editorTemplateFromFields();
    const updateExisting = $("editTypeUpdateExisting").checked;

    if (newName !== oldName) delete state.wallTypes[oldName];
    state.wallTypes[newName] = template;

    if (updateExisting) {
      updateWallsUsingType(oldName, newName, template);
    } else if (newName !== oldName) {
      // A rename should still keep existing wall assignments meaningful even if
      // assembly values are not being pushed to them.
      for (const wall of state.walls.values()) {
        if ((wall.wallType || "") === oldName) wall.wallType = newName;
      }
    }

    if (state.activeWallType === oldName) state.activeWallType = newName;
    persistWallTypes();
    markProjectDirty();
    refreshWallTypeUI();
    refreshTables();
    setActiveWallType(state.activeWallType, !!state.selectedId);
    if (state.selectedId && state.walls.has(state.selectedId)) selectSegment(state.selectedId);
    closeWallTypeEditor();
  }

  function deleteWallTypeFromEditor() {
    const name = state.editingWallTypeOriginalName;
    if (!name || !state.wallTypes[name]) return;
    const usedCount = [...state.walls.values()].filter(w => (w.wallType || "") === name).length;
    const note = usedCount
      ? ` ${usedCount} existing wall${usedCount === 1 ? " is" : "s are"} assigned to it; those walls will keep their current saved framing values but become Unassigned.`
      : "";
    if (!confirm(`Delete wall type ${name}?${note}`)) return;

    delete state.wallTypes[name];
    for (const wall of state.walls.values()) {
      if ((wall.wallType || "") === name) wall.wallType = "";
    }
    if (state.activeWallType === name) state.activeWallType = "";
    persistWallTypes();
    markProjectDirty();
    refreshWallTypeUI();
    refreshTables();
    closeWallTypeEditor();
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

    updateCurrentTypeBadge();
    $("wallTypeCountBadge").textContent = `${names.length} type${names.length === 1 ? "" : "s"}`;
    $("editActiveWallTypeBtn").disabled = !state.activeWallType || !state.wallTypes[state.activeWallType];

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
        <div class="summary-title type-card-title"><span>${escapeHtml(name)}</span><button class="type-edit-btn" type="button">Edit</button></div>
        <div class="summary-item"><span>Stud</span><span>${escapeHtml(t.studSize)} ${escapeHtml(t.gauge)} @ ${t.spacing}" O.C.</span></div>
        <div class="summary-item"><span>Height</span><span>${escapeHtml(String(t.height))}'</span></div>
        <div class="summary-item"><span>Track</span><span>${escapeHtml(t.bottomTrack)} / ${escapeHtml(t.topTrack)}</span></div>`;
      group.addEventListener("click", (e) => {
        if (e.target.closest(".type-edit-btn")) return;
        $("wallTypeName").value = name;
        setActiveWallType(name, !!state.selectedId);
        if (state.selectedId) {
          $("wallTypeSelect").value = name;
          applyWallTemplate(t);
        }
      });
      group.querySelector(".type-edit-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        openWallTypeEditor(name);
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
    markProjectDirty();
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
    markProjectDirty();
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
    const traceActive = state.toolMode === "trace";
    $("traceWallsBtn").classList.toggle("active-tool", traceActive);
    $("traceLockBtn").classList.toggle("active-tool", !!state.trace.locked);
    $("traceLockBtn").classList.toggle("trace-paused", traceActive && !state.trace.locked);
    $("traceLockBtn").setAttribute("aria-pressed", state.trace.locked ? "true" : "false");
    $("traceLockBtn").textContent = state.trace.locked ? "LOCK ✓" : "LOCK";
    $("orthoLockBtn").classList.toggle("active-tool", !!state.trace.ortho);
    $("orthoLockBtn").setAttribute("aria-pressed", state.trace.ortho ? "true" : "false");
    $("orthoLockBtn").textContent = state.trace.ortho ? "ORTHO ✓" : "ORTHO";
    syncFullscreenTools();
    if (!traceActive) return;

    const typeText = state.activeWallType ? ` • ${state.activeWallType}` : " • Unassigned";
    const runText = state.trace.locked ? " • RECORDING" : " • PAUSED";
    const orthoText = state.trace.ortho ? " • ORTHO" : "";

    if (!state.trace.locked) {
      $("hintbar").textContent = `TRACE PAUSED${typeText}${orthoText} • LOCK ON starts a new chain`;
    } else if (!state.trace.lastPoint) {
      $("hintbar").textContent = `TRACE: Tap first corner${typeText}${runText}${orthoText}`;
    } else {
      $("hintbar").textContent = `TRACE: Tap next corner${typeText}${runText}${orthoText}`;
    }
  }

  function toggleTraceLock() {
    if (!state.segments.length) {
      alert("Open a DXF drawing first.");
      return;
    }

    state.trace.locked = !state.trace.locked;

    // LOCK OFF means: finish the current trace chain and pause.
    // Clear the last point so LOCK ON starts a brand-new chain elsewhere.
    if (!state.trace.locked) {
      state.trace.lastPoint = null;
    }

    // Remain in TRACE mode. LOCK controls recording only.
    if (state.toolMode !== "trace") {
      state.toolMode = "trace";
      state.calibration.activePoint = null;
      hideCalibrationPanel();
      closeMoreMenu();
    }

    updateToolUI();
    updateTraceUI();
    draw();
  }

  function toggleOrthoLock() {
    if (!state.segments.length) {
      alert("Open a DXF drawing first.");
      return;
    }
    state.trace.ortho = !state.trace.ortho;
    updateToolUI();
    updateTraceUI();
    draw();
  }

  function activateTraceMode() {
    if (!state.segments.length) {
      alert("Open a DXF drawing first.");
      return;
    }

    const enteringTrace = state.toolMode !== "trace";
    state.toolMode = "trace";
    state.trace.locked = true;
    state.calibration.activePoint = null;

    // Entering TRACE starts a new chain. Pressing TRACE while already in
    // trace mode simply resumes recording without destroying the last point.
    if (enteringTrace) state.trace.lastPoint = null;

    hideCalibrationPanel();
    closeMoreMenu();
    if (enteringTrace) selectSegment(null, { preserveMode: true });
    updateToolUI();
    updateCalibrationUI();
    updateTraceUI();
    draw();
  }

  function traceWallPoint(screenX, screenY) {
    if (!state.trace.locked) {
      updateTraceUI();
      return;
    }

    const point = nearestWallEndpoint(screenX, screenY);
    if (!point) {
      $("hintbar").textContent = "TRACE: No corner — tap closer to an endpoint.";
      return;
    }

    if (!state.trace.lastPoint) {
      state.trace.lastPoint = { x: point.x, y: point.y };
      updateTraceUI();
      draw();
      return;
    }

    const a = state.trace.lastPoint;
    const b = { x: point.x, y: point.y };

    // ORTHO LOCK: constrain the new wall to the dominant horizontal or
    // vertical direction from the previous trace point.
    if (state.trace.ortho) {
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dx >= dy) b.y = a.y;
      else b.x = a.x;
    }

    if (rawPointDistance(a, b) < 1e-9) {
      $("hintbar").textContent = "TRACE: Choose a different corner.";
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

    // Stay in TRACE after every wall. LOCK controls recording/pause only.
    state.toolMode = "trace";
    state.trace.lastPoint = { x: b.x, y: b.y };

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
    $("traceLockBtn").classList.toggle("active-tool", !!state.trace.locked);
    $("traceLockBtn").classList.toggle("trace-paused", traceActive && !state.trace.locked);
    $("traceLockBtn").setAttribute("aria-pressed", state.trace.locked ? "true" : "false");
    $("traceLockBtn").textContent = state.trace.locked ? "LOCK ✓" : "LOCK";
    $("orthoLockBtn").classList.toggle("active-tool", !!state.trace.ortho);
    $("orthoLockBtn").setAttribute("aria-pressed", state.trace.ortho ? "true" : "false");
    $("orthoLockBtn").textContent = state.trace.ortho ? "ORTHO ✓" : "ORTHO";
    syncFullscreenTools();
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
    state.trace.locked = false;
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
      hint.textContent = "SCALE 1: Tap first point";
    } else if (cal.activePoint === 1) {
      status.textContent = "Scale 2 is active. Tap the second point of the known dimension.";
      hint.textContent = "SCALE 2: Tap second point";
    } else if (hasBoth) {
      status.textContent = cal.feetPerUnit
        ? "Scale 1 and Scale 2 are set. Change the known dimension or either point and Apply again if needed."
        : "Both scale points are set. Enter the known dimension and press Apply Calibration.";
      hint.textContent = "Scale set • WALL to continue";
    } else if (has1 || has2) {
      status.textContent = "One scale point is set. Activate the other Scale button and tap its point.";
      hint.textContent = "Set remaining scale point";
    } else {
      status.textContent = "Set Scale 1 and Scale 2 on a known dimension, then enter the real distance.";
      hint.textContent = "Tap wall • Drag pan • Pinch zoom";
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
    state.trace.locked = false;
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
    markProjectDirty();
    state.calibration.feetPerUnit = actualFeet / raw;
    state.calibration.activePoint = null;
    state.toolMode = "wall";
    hideCalibrationPanel();
    recalcAllWallsForUnits();
    updateCalibrationUI();
  }

  function resetCalibration() {
    markProjectDirty();
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
      updateSelectedActionButtons();
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
    if ($("selectedWallPanel") && "open" in $("selectedWallPanel")) {
      $("selectedWallPanel").open = true;
    }
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
    updateSelectedActionButtons();
    draw();
    updateMarkupSelectionHighlight();
  }

  function updateSelectedActionButtons() {
    const hasSavedWall = !!state.selectedId && state.walls.has(state.selectedId);
    $("findSelectedBtn").disabled = !hasSavedWall;
    $("deleteSelectedBtn").disabled = !hasSavedWall;

    const wall = hasSavedWall ? state.walls.get(state.selectedId) : null;
    $("findSelectedBtn").title = wall ? `Find ${wall.wallNumber}` : "Select a saved wall first";
    $("deleteSelectedBtn").title = wall ? `Delete ${wall.wallNumber}` : "Select a saved wall first";
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
    markProjectDirty();
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
    markProjectDirty();
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
    const wall = state.walls.get(id);
    if (!seg || !wall) return;

    // Keep Trace Lock preference, but FIND itself switches interaction to WALL
    // only for the selected markup; it does not delete or alter the trace chain.
    const wasLocked = state.trace.locked;
    state.toolMode = "wall";
    state.trace.lastPoint = null;
    selectSegment(id, { preserveMode: true });
    state.trace.locked = wasLocked;

    const rect = canvas.getBoundingClientRect();
    const worldLength = Math.max(
      Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1),
      1e-9
    );

    // Put the selected wall at a useful Bluebeam-like viewing size:
    // about 55% of the viewer's smaller dimension, but never zoom out
    // below the current drawing-fit usability range unnecessarily.
    const targetPixels = Math.max(180, Math.min(rect.width, rect.height) * 0.55);
    const desiredScale = targetPixels / worldLength;

    // Allow FIND to zoom in/out, but cap extreme zoom values.
    state.view.scale = Math.max(0.00001, Math.min(1e7, desiredScale));

    const mx = (seg.x1 + seg.x2) / 2;
    const my = (seg.y1 + seg.y2) / 2;
    state.view.offsetX = rect.width / 2 - mx * state.view.scale;
    state.view.offsetY = rect.height / 2 + my * state.view.scale;

    $("hintbar").textContent = `FOUND: ${wall.wallNumber}${wall.wallType ? ` • ${wall.wallType}` : ""}`;
    updateToolUI();
    updateTraceUI();
    updateSelectedActionButtons();
    draw();
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
    updateSelectedActionButtons();
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

    const grouped = new Map();
    for (const wall of visibleWalls) {
      const type = wall.wallType || "Unassigned";
      if (!grouped.has(type)) grouped.set(type, []);
      grouped.get(type).push(wall);
    }

    for (const [type, groupWalls] of grouped) {
      const collapsed = state.markupCollapsedGroups.has(type);

      const groupRow = document.createElement("tr");
      groupRow.className = "markup-group-row";
      groupRow.dataset.group = type;
      groupRow.innerHTML = `
        <td colspan="7">
          <button class="markup-group-toggle" type="button" aria-expanded="${collapsed ? "false" : "true"}">
            <span class="markup-group-chevron">${collapsed ? "▶" : "▼"}</span>
            <strong>${escapeHtml(type)}</strong>
            <span>${groupWalls.length} wall${groupWalls.length === 1 ? "" : "s"}</span>
          </button>
        </td>`;

      groupRow.querySelector(".markup-group-toggle").addEventListener("click", () => {
        if (state.markupCollapsedGroups.has(type)) state.markupCollapsedGroups.delete(type);
        else state.markupCollapsedGroups.add(type);
        refreshTables();
      });

      tbody.appendChild(groupRow);

      if (collapsed) continue;

      for (const w of groupWalls) {
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
            <button class="markup-locate" type="button" title="Center wall in viewer">Find</button>
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
    }

    $("wallCountBadge").textContent = `${walls.length} wall${walls.length === 1 ? "" : "s"}`;
    $("markupsCountBadge").textContent = filterValue
      ? `${visibleWalls.length} of ${walls.length}`
      : `${walls.length} item${walls.length === 1 ? "" : "s"}`;

    updateUndoButton();
    refreshWallTypeTotals(walls);
    refreshMaterialSummary(walls);
    refreshTemporaryAreaTotals();
  }

  function refreshWallTypeTotals(walls) {
    walls = getTemporaryAreaWalls(walls);
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
    walls = getTemporaryAreaWalls(walls);
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


  const PDFJS_MODULE_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.mjs";
  const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.mjs";
  const PDF_POINTS_PER_FOOT = 72 * 12;

  function setPrintStatus(message, error = false) {
    const el = $("printConvertStatus");
    el.textContent = message;
    el.classList.toggle("error", !!error);
  }

  async function loadPdfJsLibrary() {
    if (state.pdfImport.library) return state.pdfImport.library;
    setPrintStatus("Loading PDF converter…");
    try {
      const pdfjsLib = await import(PDFJS_MODULE_URL);
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      state.pdfImport.library = pdfjsLib;
      return pdfjsLib;
    } catch (err) {
      throw new Error("Could not load the PDF converter. Internet access is required the first time PRINT is used.");
    }
  }

  function openPrintConverterDialog() {
    $("printConverterDialog").classList.remove("hidden");
    setPrintStatus(
      state.pdfImport.fileName
        ? `${state.pdfImport.fileName} ready. Choose a page to preview or convert.`
        : "Choose a PDF print."
    );
  }

  function closePrintConverterDialog() {
    $("printConverterDialog").classList.add("hidden");
  }

  function resetPdfImportUi() {
    state.pdfImport.fileName = "";
    state.pdfImport.bytes = null;
    state.pdfImport.doc = null;
    state.pdfImport.pageCount = 0;
    state.pdfImport.conversion = null;
    $("printFileName").textContent = "No PDF selected";
    $("printPageNumber").value = "1";
    $("printPageNumber").max = "1";
    $("printPageCount").textContent = "— pages";
    $("previewPrintPageBtn").disabled = true;
    $("convertLoadPrintBtn").disabled = true;
    $("downloadConvertedDxfBtn").disabled = true;
    const preview = $("printPreviewCanvas");
    preview.width = 1;
    preview.height = 1;
    $("printPreviewEmpty").style.display = "flex";
  }

  async function loadPdfPrintFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      alert("Please choose a PDF print.");
      return;
    }

    try {
      const pdfjsLib = await loadPdfJsLibrary();
      setPrintStatus("Opening PDF…");

      const bytes = new Uint8Array(await file.arrayBuffer());
      const task = pdfjsLib.getDocument({
        data: bytes,
        stopAtErrors: false
      });
      const doc = await task.promise;

      state.pdfImport.fileName = file.name;
      state.pdfImport.bytes = bytes;
      state.pdfImport.doc = doc;
      state.pdfImport.pageCount = doc.numPages;
      state.pdfImport.conversion = null;

      $("printFileName").textContent = file.name;
      $("printPageNumber").min = "1";
      $("printPageNumber").max = String(doc.numPages);
      $("printPageNumber").value = "1";
      $("printPageCount").textContent = `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`;
      $("previewPrintPageBtn").disabled = false;
      $("convertLoadPrintBtn").disabled = false;
      $("downloadConvertedDxfBtn").disabled = true;

      setPrintStatus(`PDF loaded • ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}.`);
      await previewPdfPage();
    } catch (err) {
      console.error(err);
      setPrintStatus(`Could not open PDF: ${err.message || err}`, true);
    }
  }

  function selectedPdfPageNumber() {
    const max = Math.max(1, state.pdfImport.pageCount || 1);
    const raw = Math.round(Number($("printPageNumber").value) || 1);
    const pageNumber = Math.min(max, Math.max(1, raw));
    $("printPageNumber").value = String(pageNumber);
    return pageNumber;
  }

  async function previewPdfPage() {
    if (!state.pdfImport.doc) return;
    try {
      const pageNumber = selectedPdfPageNumber();
      setPrintStatus(`Rendering page ${pageNumber} preview…`);
      const page = await state.pdfImport.doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const maxWidth = Math.min(900, Math.max(320, window.innerWidth - 90));
      const scale = Math.max(0.25, Math.min(1.35, maxWidth / Math.max(1, base.width)));
      const viewport = page.getViewport({ scale });

      const canvas = $("printPreviewCanvas");
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(viewport.width * ratio);
      canvas.height = Math.round(viewport.height * ratio);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;

      const context = canvas.getContext("2d", { alpha: false });
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, viewport.width, viewport.height);

      await page.render({
        canvasContext: context,
        viewport
      }).promise;

      $("printPreviewEmpty").style.display = "none";
      state.pdfImport.conversion = null;
      $("downloadConvertedDxfBtn").disabled = true;
      setPrintStatus(`Page ${pageNumber} preview ready.`);
    } catch (err) {
      console.error(err);
      setPrintStatus(`Preview error: ${err.message || err}`, true);
    }
  }

  function matrixMultiply(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5]
    ];
  }

  function matrixPoint(m, x, y) {
    return {
      x: m[0] * x + m[2] * y + m[4],
      y: m[1] * x + m[3] * y + m[5]
    };
  }

  function flattenNumeric(value, out = []) {
    if (value == null) return out;
    if (typeof value === "number") {
      out.push(value);
    } else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      for (const item of value) flattenNumeric(item, out);
    }
    return out;
  }

  function approximateCubic(p0, p1, p2, p3, steps = 8) {
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      pts.push({
        x: mt**3*p0.x + 3*mt**2*t*p1.x + 3*mt*t**2*p2.x + t**3*p3.x,
        y: mt**3*p0.y + 3*mt**2*t*p1.y + 3*mt*t**2*p2.y + t**3*p3.y
      });
    }
    return pts;
  }

  function approximateQuadratic(p0, p1, p2, steps = 7) {
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      pts.push({
        x: mt**2*p0.x + 2*mt*t*p1.x + t**2*p2.x,
        y: mt**2*p0.y + 2*mt*t*p1.y + t**2*p2.y
      });
    }
    return pts;
  }

  async function extractPdfConversion() {
    if (!state.pdfImport.doc) throw new Error("Choose a PDF print first.");

    const pageNumber = selectedPdfPageNumber();
    const page = await state.pdfImport.doc.getPage(pageNumber);
    const pdfjsLib = state.pdfImport.library || await loadPdfJsLibrary();
    const OPS = pdfjsLib.OPS;

    setPrintStatus(`Converting page ${pageNumber} vector linework…`);

    const opList = await page.getOperatorList();
    const rawSegments = [];
    const ctmStack = [];
    let ctm = [1, 0, 0, 1, 0, 0];

    const minLengthFt = $("skipTinyPrintLines").checked ? (1 / 8 / 12) : 0.00001;

    function addPdfSegment(p1, p2) {
      const a = matrixPoint(ctm, p1.x, p1.y);
      const b = matrixPoint(ctm, p2.x, p2.y);
      const x1 = a.x / PDF_POINTS_PER_FOOT;
      const y1 = a.y / PDF_POINTS_PER_FOOT;
      const x2 = b.x / PDF_POINTS_PER_FOOT;
      const y2 = b.y / PDF_POINTS_PER_FOOT;
      if (![x1,y1,x2,y2].every(Number.isFinite)) return;
      if (Math.hypot(x2-x1, y2-y1) < minLengthFt) return;
      rawSegments.push({ x1, y1, x2, y2, sourceType: "PDF_VECTOR" });
    }

    function decodePackedDrawPath(pathData) {
      const data = flattenNumeric(pathData);
      if (!data.length) return;

      let i = 0;
      let current = null;
      let start = null;

      while (i < data.length) {
        const cmd = data[i++];

        if (cmd === 0) { // DrawOPS.moveTo
          if (i + 1 >= data.length) break;
          current = { x: data[i++], y: data[i++] };
          start = { ...current };
        } else if (cmd === 1) { // DrawOPS.lineTo
          if (!current || i + 1 >= data.length) break;
          const next = { x: data[i++], y: data[i++] };
          addPdfSegment(current, next);
          current = next;
        } else if (cmd === 2) { // DrawOPS.curveTo
          if (!current || i + 5 >= data.length) break;
          const c1 = { x: data[i++], y: data[i++] };
          const c2 = { x: data[i++], y: data[i++] };
          const end = { x: data[i++], y: data[i++] };
          let prev = current;
          for (const next of approximateCubic(current, c1, c2, end)) {
            addPdfSegment(prev, next);
            prev = next;
          }
          current = end;
        } else if (cmd === 3) { // DrawOPS.quadraticCurveTo
          if (!current || i + 3 >= data.length) break;
          const c = { x: data[i++], y: data[i++] };
          const end = { x: data[i++], y: data[i++] };
          let prev = current;
          for (const next of approximateQuadratic(current, c, end)) {
            addPdfSegment(prev, next);
            prev = next;
          }
          current = end;
        } else if (cmd === 4) { // DrawOPS.closePath
          if (current && start) addPdfSegment(current, start);
          current = start ? { ...start } : current;
        } else {
          // Unknown packed operation. Stop this path rather than creating bad geometry.
          break;
        }
      }
    }

    function decodeLegacyConstructPath(args) {
      const ops = Array.from(args?.[0] || []);
      const coords = flattenNumeric(args?.[1]);
      let ci = 0;
      let current = null;
      let start = null;

      for (const op of ops) {
        if (op === OPS.moveTo) {
          current = { x: coords[ci++], y: coords[ci++] };
          start = { ...current };
        } else if (op === OPS.lineTo) {
          const next = { x: coords[ci++], y: coords[ci++] };
          if (current) addPdfSegment(current, next);
          current = next;
        } else if (op === OPS.rectangle) {
          const x = coords[ci++], y = coords[ci++], w = coords[ci++], h = coords[ci++];
          const p1={x,y}, p2={x:x+w,y}, p3={x:x+w,y:y+h}, p4={x,y:y+h};
          addPdfSegment(p1,p2); addPdfSegment(p2,p3); addPdfSegment(p3,p4); addPdfSegment(p4,p1);
          current = p1; start = p1;
        } else if (op === OPS.curveTo) {
          const c1={x:coords[ci++],y:coords[ci++]}, c2={x:coords[ci++],y:coords[ci++]}, end={x:coords[ci++],y:coords[ci++]};
          if (current) {
            let prev=current;
            for (const next of approximateCubic(current,c1,c2,end)) { addPdfSegment(prev,next); prev=next; }
          }
          current=end;
        } else if (op === OPS.closePath) {
          if (current && start) addPdfSegment(current,start);
          current=start;
        } else {
          // Consume old curveTo2 / curveTo3 approximately if they appear.
          if (op === OPS.curveTo2) {
            const c2={x:coords[ci++],y:coords[ci++]}, end={x:coords[ci++],y:coords[ci++]};
            if (current) {
              let prev=current;
              for (const next of approximateCubic(current,current,c2,end)) { addPdfSegment(prev,next); prev=next; }
            }
            current=end;
          } else if (op === OPS.curveTo3) {
            const c1={x:coords[ci++],y:coords[ci++]}, end={x:coords[ci++],y:coords[ci++]};
            if (current) {
              let prev=current;
              for (const next of approximateCubic(current,c1,end,end)) { addPdfSegment(prev,next); prev=next; }
            }
            current=end;
          }
        }
      }
    }

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] || [];

      if (fn === OPS.save) {
        ctmStack.push([...ctm]);
      } else if (fn === OPS.restore) {
        ctm = ctmStack.pop() || [1,0,0,1,0,0];
      } else if (fn === OPS.transform) {
        const m = flattenNumeric(args).slice(0,6);
        if (m.length === 6 && m.every(Number.isFinite)) ctm = matrixMultiply(ctm, m);
      } else if (fn === OPS.constructPath) {
        // PDF.js <=4: [ops, coords, minMax]
        // PDF.js 5/6: [paintOp, [packed DrawOPS path], minMax]
        const first = args?.[0];
        if (Array.isArray(first) || ArrayBuffer.isView(first)) {
          decodeLegacyConstructPath(args);
        } else {
          const packed = args?.[1]?.[0] ?? args?.[1];
          decodePackedDrawPath(packed);
        }
      }
    }

    // Deduplicate linework; architectural PDFs often repeat the same stroke.
    const unique = new Map();
    const keyPoint = (x,y) => `${x.toFixed(5)},${y.toFixed(5)}`;
    for (const s of rawSegments) {
      const a = keyPoint(s.x1,s.y1);
      const b = keyPoint(s.x2,s.y2);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!unique.has(key)) unique.set(key, s);
    }

    const segments = [...unique.values()].map((s, idx) => ({ ...s, id: idx + 1 }));

    const labels = [];
    if ($("includePrintText").checked) {
      setPrintStatus(`Extracting page ${pageNumber} legends and text…`);
      try {
        const textContent = await page.getTextContent();
        for (const item of textContent.items || []) {
          const text = String(item.str || "").trim();
          if (!text || !item.transform || item.transform.length < 6) continue;

          const t = item.transform;
          const x = Number(t[4]) / PDF_POINTS_PER_FOOT;
          const y = Number(t[5]) / PDF_POINTS_PER_FOOT;
          const heightPt = Math.max(
            Math.hypot(Number(t[2]) || 0, Number(t[3]) || 0),
            Math.hypot(Number(t[0]) || 0, Number(t[1]) || 0) * 0.7,
            4
          );

          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

          labels.push({
            x, y,
            height: heightPt / PDF_POINTS_PER_FOOT,
            rotation: Math.atan2(Number(t[1]) || 0, Number(t[0]) || 1) * 180 / Math.PI,
            text,
            sourceType: "PDF_TEXT"
          });
        }
      } catch (err) {
        console.warn("PDF text extraction failed:", err);
      }
    }

    const conversion = {
      pageNumber,
      segments,
      labels,
      sourceFileName: state.pdfImport.fileName
    };
    state.pdfImport.conversion = conversion;
    $("downloadConvertedDxfBtn").disabled = !segments.length;

    if (!segments.length) {
      setPrintStatus(
        labels.length
          ? `Page ${pageNumber}: text found, but no usable vector linework. This may be a scanned/raster sheet.`
          : `Page ${pageNumber}: no usable vector linework found. This may be a scanned/raster sheet.`,
        true
      );
    } else {
      setPrintStatus(
        `Converted page ${pageNumber} • ${segments.length.toLocaleString()} line segments • ${labels.length.toLocaleString()} text/legend labels.`
      );
    }
    return conversion;
  }

  function dxfNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(7)).toString() : "0";
  }

  function dxfText(value) {
    return String(value ?? "")
      .replace(/\r?\n/g, " ")
      .replace(/[^\x20-\x7E]/g, "?")
      .slice(0, 240);
  }

  function buildConvertedDxf(conversion) {
    const lines = [];
    const push = (...values) => lines.push(...values.map(String));

    push("0","SECTION","2","HEADER",
         "9","$ACADVER","1","AC1009",
         "9","$INSUNITS","70","2",
         "0","ENDSEC");

    push("0","SECTION","2","TABLES",
         "0","TABLE","2","LAYER","70","2",
         "0","LAYER","2","PDF_GEOMETRY","70","0","62","7","6","CONTINUOUS",
         "0","LAYER","2","PDF_TEXT","70","0","62","3","6","CONTINUOUS",
         "0","ENDTAB",
         "0","ENDSEC");

    push("0","SECTION","2","ENTITIES");

    for (const s of conversion.segments) {
      push("0","LINE","8","PDF_GEOMETRY",
           "10",dxfNumber(s.x1),"20",dxfNumber(s.y1),"30","0",
           "11",dxfNumber(s.x2),"21",dxfNumber(s.y2),"31","0");
    }

    for (const label of conversion.labels || []) {
      const height = Math.max(Number(label.height) || 0.08, 0.04);
      push("0","TEXT","8","PDF_TEXT",
           "10",dxfNumber(label.x),"20",dxfNumber(label.y),"30","0",
           "40",dxfNumber(height),
           "1",dxfText(label.text),
           "50",dxfNumber(label.rotation || 0),
           "7","STANDARD");
    }

    push("0","ENDSEC","0","EOF");
    return lines.join("\r\n") + "\r\n";
  }

  function convertedDxfFileName(conversion) {
    const base = (conversion?.sourceFileName || state.pdfImport.fileName || "print")
      .replace(/\.pdf$/i, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "print";
    return `${base}-P${conversion?.pageNumber || selectedPdfPageNumber()}-ATLAS.dxf`;
  }

  function downloadTextFile(text, fileName, type = "application/dxf") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function ensurePdfConversion() {
    const requestedPage = selectedPdfPageNumber();
    if (!state.pdfImport.conversion || state.pdfImport.conversion.pageNumber !== requestedPage) {
      return await extractPdfConversion();
    }
    return state.pdfImport.conversion;
  }

  async function downloadConvertedDxf() {
    try {
      const conversion = await ensurePdfConversion();
      if (!conversion.segments.length) return;
      const dxf = buildConvertedDxf(conversion);
      downloadTextFile(dxf, convertedDxfFileName(conversion));
      setPrintStatus(`DXF downloaded • ${conversion.segments.length.toLocaleString()} segments • ${conversion.labels.length.toLocaleString()} labels.`);
    } catch (err) {
      console.error(err);
      setPrintStatus(`DXF export failed: ${err.message || err}`, true);
    }
  }

  async function convertPdfAndLoadIntoTakeoff() {
    try {
      if (!confirmDiscardUnsaved()) return;
      const conversion = await ensurePdfConversion();
      if (!conversion.segments.length) {
        alert("This PDF page does not contain usable vector linework. It may be a scanned/image-only print.");
        return;
      }

      if (state.projectDirty && state.segments.length &&
          !confirm("Load this converted PDF page? Unsaved takeoff changes will be lost.")) return;

      const fileName = convertedDxfFileName(conversion);
      state.fileName = fileName;
      state.projectName = fileName.replace(/\.dxf$/i, "");
      state.savedProjectId = null;
      state.projectDirty = true;
      state.segments = conversion.segments.map(s => ({ ...s }));
      state.labels = (conversion.labels || []).map(l => ({ ...l }));
      state.detectedUnits = "ft";
      $("unitSelect").value = "ft";
      state.calibration = { activePoint: null, points: [null, null], feetPerUnit: null };
      state.toolMode = "wall";
      state.trace.lastPoint = null;
      state.bounds = computeBounds(state.segments);
      state.walls.clear();
      state.history = [];
      state.selectedId = null;
      state.tempArea = {
        selecting: false,
        closed: false,
        points: [],
        wallIds: new Set()
      };

      $("emptyState").style.display = "none";
      $("fileStatus").textContent =
        `${state.pdfImport.fileName} P${conversion.pageNumber} → ${state.segments.length.toLocaleString()} vector segments • ${state.labels.length.toLocaleString()} labels`;

      updateProjectTitle();
      refreshTables();
      selectSegment(null);
      updateCalibrationUI();
      updateToolUI();
      updateTraceUI();
      fitDrawing();
      closePrintConverterDialog();
    } catch (err) {
      console.error(err);
      setPrintStatus(`Conversion failed: ${err.message || err}`, true);
    }
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

  // Projects are stored in IndexedDB (larger drawings than localStorage can usually handle).
  // Downloadable .atlas-takeoff.json backup is the portable, user-controlled copy.
  const PROJECT_DB_NAME = "ATLAS_Takeoff_Projects";
  const PROJECT_STORE = "projects";
  const LAST_PROJECT_KEY = "atlasTakeoffLastProjectV2";
  let projectDbPromise = null;
  let restoringProject = false;

  function markProjectDirty() {
    if (restoringProject || !state.segments.length) return;
    state.projectDirty = true;
    updateProjectTitle();
  }

  function updateProjectTitle() {
    const title = state.projectName || state.fileName || "Untitled project";
    document.title = `${state.projectDirty ? "• " : ""}${title} — ATLAS Takeoff`;
    $("saveProjectBtn").textContent = state.projectDirty ? "Save Project *" : "Save Project";
  }

  function getProjectSnapshot(name = state.projectName || state.fileName.replace(/\.dxf$/i, "") || "New Project") {
    return {
      app: "ATLAS Takeoff", version: 2,
      projectName: String(name).trim(),
      fileName: state.fileName,
      savedAt: new Date().toISOString(),
      segments: state.segments.map(s => ({ ...s })),
      labels: state.labels.map(l => ({ ...l })),
      walls: [...state.walls.values()].map(w => ({ ...w })),
      wallTypes: structuredClone(state.wallTypes),
      activeWallType: state.activeWallType,
      detectedUnits: state.detectedUnits,
      unitSelect: $("unitSelect").value,
      calibration: {
        points: state.calibration.points,
        feetPerUnit: state.calibration.feetPerUnit,
        knownFeet: $("calibrationFeet").value,
        knownInches: $("calibrationInches").value
      },
      view: { ...state.view },
      selectedId: state.selectedId,
      traceLocked: state.trace.locked,
      traceOrtho: state.trace.ortho
    };
  }

  function assertProject(data) {
    if (!data || data.app !== "ATLAS Takeoff" || data.version !== 2 ||
        !Array.isArray(data.segments) || !Array.isArray(data.walls) ||
        !data.segments.every(s => Number.isFinite(s.x1) && Number.isFinite(s.y1) &&
            Number.isFinite(s.x2) && Number.isFinite(s.y2) && Number.isSafeInteger(s.id)) ||
        !data.walls.every(w => Number.isSafeInteger(w.segmentId) &&
            typeof w.wallNumber === "string")) {
      throw new Error("Not a valid ATLAS Takeoff v2 project backup.");
    }
    return data;
  }

  function projectDb() {
    if (!window.indexedDB) return Promise.reject(new Error("Saved projects are unavailable in this browser. Use Download Backup instead."));
    if (projectDbPromise) return projectDbPromise;
    projectDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(PROJECT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(PROJECT_STORE))
          req.result.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Could not open saved-project storage."));
    }).catch(err => { projectDbPromise = null; throw err; });
    return projectDbPromise;
  }

  async function projectOperation(mode, value) {
    const db = await projectDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE, mode === "put" || mode === "delete" ? "readwrite" : "readonly");
      const store = tx.objectStore(PROJECT_STORE);
      let req;
      if (mode === "put") req = store.put(value);
      else if (mode === "delete") req = store.delete(value);
      else if (mode === "get") req = store.get(value);
      else req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Project storage request failed."));
      tx.onabort = () => reject(tx.error || new Error("Project storage failed or is full."));
    });
  }

  function setProjectStatus(message, error = false) {
    $("projectStorageStatus").textContent = message;
    $("projectStorageStatus").classList.toggle("error", error);
  }

  function projectIdFromName(name) {
    return name.trim().toLowerCase();
  }

  async function refreshSavedProjectsList() {
    const list = $("savedProjectsList");
    list.textContent = "Loading saved projects…";
    try {
      const items = await projectOperation("list");
      items.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
      list.replaceChildren();
      if (!items.length) {
        list.textContent = "No saved projects on this device yet.";
        return;
      }
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "project-saved-row";
        const info = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = item.projectName;
        const detail = document.createElement("small");
        detail.textContent = `${item.walls.length} walls • ${new Date(item.savedAt).toLocaleString()}`;
        info.append(strong, detail);
        const open = document.createElement("button");
        open.className = "button";
        open.type = "button";
        open.textContent = "Open";
        open.addEventListener("click", () => openSavedProject(item.id));
        const remove = document.createElement("button");
        remove.className = "button danger";
        remove.type = "button";
        remove.textContent = "Delete";
        remove.addEventListener("click", async () => {
          if (!confirm(`Delete saved project “${item.projectName}” from this device?`)) return;
          try {
            await projectOperation("delete", item.id);
            if (state.savedProjectId === item.id) {
              state.savedProjectId = null;
              state.projectDirty = true;
              updateProjectTitle();
            }
            if (localStorage.getItem(LAST_PROJECT_KEY) === item.id) localStorage.removeItem(LAST_PROJECT_KEY);
            await refreshSavedProjectsList();
          } catch (err) { setProjectStatus(err.message, true); }
        });
        row.append(info, open, remove);
        list.appendChild(row);
      }
    } catch (err) {
      list.textContent = "Local saves are unavailable; use Download Backup to keep this project.";
      setProjectStatus(err.message, true);
    }
  }

  function showProjectDialog(preferSave = false) {
    $("projectDialog").classList.remove("hidden");
    $("projectNameInput").value = state.projectName || state.fileName.replace(/\.dxf$/i, "");
    $("projectStorageStatus").textContent = "";
    refreshSavedProjectsList();
    if (preferSave) $("projectNameInput").focus();
  }

  function closeProjectDialog() { $("projectDialog").classList.add("hidden"); }

  async function saveCurrentProject() {
    if (!state.segments.length) { alert("Open a DXF before saving a project."); return; }
    const name = $("projectNameInput").value.trim();
    if (!name) { setProjectStatus("Give this project a name before saving.", true); return; }
    const id = projectIdFromName(name);
    try {
      const existing = await projectOperation("get", id);
      if (existing && state.savedProjectId !== id &&
          !confirm(`Replace the existing saved project “${existing.projectName}”?`)) return;
      const data = getProjectSnapshot(name);
      await projectOperation("put", { ...data, id });
      state.projectName = name;
      state.savedProjectId = id;
      state.projectDirty = false;
      updateProjectTitle();
      localStorage.setItem(LAST_PROJECT_KEY, id);
      setProjectStatus(`Saved “${name}” with ${data.walls.length} walls and the complete drawing.`);
      await refreshSavedProjectsList();
    } catch (err) {
      setProjectStatus(`Couldn't save locally: ${err.message} Download a backup instead.`, true);
    }
  }

  function confirmDiscardUnsaved() {
    return !state.projectDirty || !state.segments.length ||
      confirm("You have unsaved changes. Open another project and discard those changes?");
  }

  function restoreProject(data, id = null) {
    const p = assertProject(data);
    restoringProject = true;
    try {
      state.fileName = p.fileName || "Saved project";
      state.projectName = p.projectName || "Imported project";
      state.savedProjectId = id;
      state.projectDirty = false;
      state.segments = p.segments.map(s => ({ ...s }));
      state.labels = Array.isArray(p.labels) ? p.labels.map(l => ({ ...l })) : [];
      state.walls = new Map(p.walls.map(w => [w.segmentId, { ...w }]));
      state.wallTypes = { ...state.wallTypes, ...(p.wallTypes || {}) };
      persistWallTypes();
      state.activeWallType = p.activeWallType && state.wallTypes[p.activeWallType] ? p.activeWallType : "";
      state.detectedUnits = p.detectedUnits || null;
      const validUnits = ["auto", "in", "ft", "mm", "cm", "m"];
      $("unitSelect").value = validUnits.includes(p.unitSelect) ? p.unitSelect : "auto";
      state.calibration = {
        activePoint: null,
        points: Array.isArray(p.calibration?.points) && p.calibration.points.length === 2
          ? p.calibration.points : [null, null],
        feetPerUnit: Number.isFinite(p.calibration?.feetPerUnit) && p.calibration.feetPerUnit > 0
          ? p.calibration.feetPerUnit : null
      };
      $("calibrationFeet").value = p.calibration?.knownFeet ?? "20";
      $("calibrationInches").value = p.calibration?.knownInches ?? "0";
      state.trace = { locked: !!p.traceLocked, ortho: !!p.traceOrtho, lastPoint: null };
      state.toolMode = state.trace.locked ? "trace" : "wall";
      state.history = [];
      state.bounds = computeBounds(state.segments);
      state.selectedId = null;
      state.tempArea = {
        selecting: false,
        closed: false,
        points: [],
        wallIds: new Set()
      };
      $("emptyState").style.display = state.segments.length ? "none" : "flex";
      $("fileStatus").textContent = `${state.fileName} • ${state.segments.length.toLocaleString()} segments`;
      refreshWallTypeUI();
      setActiveWallType(state.activeWallType);
      refreshTables();
      selectSegment(null, { preserveMode: true });
      hideCalibrationPanel();
      updateCalibrationUI();
      updateToolUI();
      updateTraceUI();
      updateSelectedActionButtons();
      updateProjectTitle();
      if (p.view && Number.isFinite(p.view.scale) && p.view.scale > 0 &&
          Number.isFinite(p.view.offsetX) && Number.isFinite(p.view.offsetY)) {
        state.view = { ...p.view };
        resizeCanvas();
      } else fitDrawing();
    } finally { restoringProject = false; }
  }

  async function openSavedProject(id) {
    if (!confirmDiscardUnsaved()) return;
    try {
      const data = await projectOperation("get", id);
      if (!data) { setProjectStatus("This saved project is no longer available.", true); return; }
      restoreProject(data, id);
      localStorage.setItem(LAST_PROJECT_KEY, id);
      closeProjectDialog();
    } catch (err) { setProjectStatus(err.message, true); }
  }

  function downloadProjectBackup() {
    if (!state.segments.length) { alert("Open a DXF before downloading a project backup."); return; }
    const name = $("projectNameInput").value.trim() || state.projectName || state.fileName.replace(/\.dxf$/i, "") || "takeoff";
    const json = JSON.stringify(getProjectSnapshot(name));
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.replace(/[^a-z0-9_-]+/gi, "-")}.atlas-takeoff.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setProjectStatus(`Downloaded backup for “${name}”. Keep it somewhere safe.`);
  }

  async function importProjectBackup(file) {
    if (!file || !confirmDiscardUnsaved()) return;
    try {
      const data = assertProject(JSON.parse(await file.text()));
      restoreProject(data, null);
      state.projectDirty = true; // Imported file still needs to be saved to local slots.
      updateProjectTitle();
      closeProjectDialog();
      alert(`Imported “${state.projectName}”. Use Save Project to keep it in this browser.`);
    } catch (err) { alert(`Could not import project: ${err.message}`); }
  }

  async function autoRestoreLastSaved() {
    let id;
    try { id = localStorage.getItem(LAST_PROJECT_KEY); } catch (_) { return; }
    if (!id || state.segments.length) return;
    try {
      const data = await projectOperation("get", id);
      if (data && !state.segments.length) restoreProject(data, id);
    } catch (_) { /* User can still open/import manually. */ }
  }

  // Persistent viewer focus mode.
  // We intentionally use the CSS fixed-position fullscreen implementation on every
  // device. Native browser fullscreen can be dismissed unexpectedly by iPad/Safari
  // after touch gestures or UI changes.
  const viewerCard = document.querySelector(".viewer-card");
  let fullscreenCenter = null;

  function isViewerFullscreen() {
    return !!state.fullscreenPersistent;
  }

  function captureViewerCenter() {
    const rect = canvas.getBoundingClientRect();
    return rect.width && rect.height
      ? screenToWorld(rect.width / 2, rect.height / 2)
      : null;
  }

  function reflowViewerAfterModeChange() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      if (fullscreenCenter && rect.width && rect.height) {
        state.view.offsetX = rect.width / 2 - fullscreenCenter.x * state.view.scale;
        state.view.offsetY = rect.height / 2 + fullscreenCenter.y * state.view.scale;
      }
      fullscreenCenter = null;
      resizeCanvas();
      syncFullscreenTools();
    }));
  }

  function syncFullscreenTools() {
    const active = isViewerFullscreen();
    $("fullscreenBtn").textContent = active ? "⛶ EXIT FULL SCREEN" : "⛶ FULL SCREEN";
    $("fullscreenBtn").setAttribute("aria-pressed", active ? "true" : "false");
    $("fsWallBtn").classList.toggle("active-tool", state.toolMode === "wall");
    $("fsTraceBtn").classList.toggle("active-tool", state.toolMode === "trace");
    $("fsLockBtn").classList.toggle("trace-on", state.trace.locked);
    $("fsLockBtn").classList.toggle("trace-paused", state.toolMode === "trace" && !state.trace.locked);
    $("fsLockBtn").textContent = state.trace.locked ? "TRACE LOCK ✓" : "TRACE LOCK";
    $("fsOrthoBtn").classList.toggle("trace-on", state.trace.ortho);
    $("fsOrthoBtn").textContent = state.trace.ortho ? "ORTHO ✓" : "ORTHO";
  }

  function applyPersistentFullscreen(active) {
    state.fullscreenPersistent = !!active;
    state.fullscreenFallback = !!active; // retained for project/state compatibility
    viewerCard.classList.toggle("fullscreen-fallback", !!active);
    document.documentElement.classList.toggle("viewer-focus-active", !!active);
    document.body.classList.toggle("viewer-focus-active", !!active);
    syncFullscreenTools();
  }

  async function toggleViewerFullscreen(forceState = null) {
    fullscreenCenter = captureViewerCenter();
    const next = forceState === null ? !isViewerFullscreen() : !!forceState;
    applyPersistentFullscreen(next);
    reflowViewerAfterModeChange();
  }

  // If Safari resizes, rotates, hides/reveals browser chrome, or returns from another
  // app while focus mode is active, re-assert the viewer class instead of exiting.
  function preservePersistentFullscreen() {
    if (!state.fullscreenPersistent) return;
    if (!viewerCard.classList.contains("fullscreen-fallback")) {
      viewerCard.classList.add("fullscreen-fallback");
    }
    document.documentElement.classList.add("viewer-focus-active");
    document.body.classList.add("viewer-focus-active");
    requestAnimationFrame(resizeCanvas);
  }

  window.addEventListener("resize", preservePersistentFullscreen);
  window.addEventListener("orientationchange", preservePersistentFullscreen);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) preservePersistentFullscreen();
  });

  $("fullscreenBtn").addEventListener("click", () => {
    const viewMenu = $("viewerOptionsMenu");
    if (viewMenu) viewMenu.open = false;
    toggleViewerFullscreen();
  });
  $("fsExitBtn").addEventListener("click", () => toggleViewerFullscreen(false));
  $("fsWallBtn").addEventListener("click", () => activateWallMode(false));
  $("fsTraceBtn").addEventListener("click", activateTraceMode);
  $("fsLockBtn").addEventListener("click", toggleTraceLock);
  $("fsOrthoBtn").addEventListener("click", toggleOrthoLock);
  $("fsFitBtn").addEventListener("click", fitDrawing);
  $("saveProjectBtn").addEventListener("click", () => showProjectDialog(true));
  $("openProjectBtn").addEventListener("click", () => {
    closeMoreMenu();
    showProjectDialog(false);
  });
  $("closeProjectDialogBtn").addEventListener("click", closeProjectDialog);
  $("projectDialog").addEventListener("click", e => {
    if (e.target === $("projectDialog")) closeProjectDialog();
  });
  $("confirmSaveProjectBtn").addEventListener("click", saveCurrentProject);
  $("backupProjectBtn").addEventListener("click", () => { closeMoreMenu(); showProjectDialog(true); downloadProjectBackup(); });
  $("dialogBackupProjectBtn").addEventListener("click", downloadProjectBackup);
  $("importProjectBtn").addEventListener("click", () => {
    closeMoreMenu();
    $("projectImportFile").value = "";
    $("projectImportFile").click();
  });
  $("projectImportFile").addEventListener("change", e => importProjectBackup(e.target.files?.[0]));
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("projectDialog").classList.contains("hidden")) closeProjectDialog();
    if (e.key === "Escape" && state.tempArea.selecting) {
      state.tempArea.selecting = false;
      state.tempArea.points = [];
      updateTemporaryAreaUI();
      refreshTemporaryAreaTotals();
      draw();
      return;
    }
    if (e.key === "Escape" && state.fullscreenPersistent) toggleViewerFullscreen(false);
  });
  window.addEventListener("beforeunload", e => {
    if (state.projectDirty && state.segments.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });


  function initializeCollapsiblePanelScrolling() {
    const bodies = document.querySelectorAll(".panel-scroll-body");

    bodies.forEach((body) => {
      const up = body.querySelector(".panel-scroll-up");
      const down = body.querySelector(".panel-scroll-down");

      const scrollAmount = () => Math.max(120, Math.round(body.clientHeight * 0.72));

      if (up) {
        up.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          body.scrollBy({ top: -scrollAmount(), behavior: "smooth" });
        });
      }

      if (down) {
        down.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          body.scrollBy({ top: scrollAmount(), behavior: "smooth" });
        });
      }

      // Explicit wheel handling prevents the parent options column from
      // stealing wheel movement when this panel can still scroll.
      body.addEventListener("wheel", (e) => {
        const max = body.scrollHeight - body.clientHeight;
        if (max <= 0) return;

        const movingDown = e.deltaY > 0;
        const movingUp = e.deltaY < 0;
        const canMoveDown = body.scrollTop < max - 1;
        const canMoveUp = body.scrollTop > 1;

        if ((movingDown && canMoveDown) || (movingUp && canMoveUp)) {
          e.preventDefault();
          e.stopPropagation();
          body.scrollTop += e.deltaY;
        }
      }, { passive: false });

      // Safari/iPad fallback: translate finger movement directly to scrollTop.
      let touchY = null;

      body.addEventListener("touchstart", (e) => {
        if (!e.touches || !e.touches.length) return;
        touchY = e.touches[0].clientY;
      }, { passive: true });

      body.addEventListener("touchmove", (e) => {
        if (touchY === null || !e.touches || !e.touches.length) return;

        const y = e.touches[0].clientY;
        const dy = touchY - y;
        const max = body.scrollHeight - body.clientHeight;

        if (max > 0) {
          const next = Math.max(0, Math.min(max, body.scrollTop + dy));
          if (next !== body.scrollTop) {
            e.preventDefault();
            e.stopPropagation();
            body.scrollTop = next;
          }
        }

        touchY = y;
      }, { passive: false });

      body.addEventListener("touchend", () => {
        touchY = null;
      }, { passive: true });

      body.addEventListener("touchcancel", () => {
        touchY = null;
      }, { passive: true });
    });
  }

  document.addEventListener("pointerdown", (e) => {
    const menu = $("moreMenu");
    if (menu && menu.open && !menu.contains(e.target)) {
      menu.open = false;
    }
    const viewMenu = $("viewerOptionsMenu");
    if (viewMenu && viewMenu.open && !viewMenu.contains(e.target)) {
      viewMenu.open = false;
    }
  });

  $("openPrintBtn").addEventListener("click", () => {
    openPrintConverterDialog();
  });

  $("choosePrintPdfBtn").addEventListener("click", () => {
    const input = $("pdfPrintFile");
    input.value = "";
    input.click();
  });

  $("pdfPrintFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await loadPdfPrintFile(file);
  });

  $("previewPrintPageBtn").addEventListener("click", previewPdfPage);
  $("printPageNumber").addEventListener("change", () => {
    state.pdfImport.conversion = null;
    $("downloadConvertedDxfBtn").disabled = true;
  });

  $("includePrintText").addEventListener("change", () => {
    state.pdfImport.conversion = null;
    $("downloadConvertedDxfBtn").disabled = true;
  });

  $("skipTinyPrintLines").addEventListener("change", () => {
    state.pdfImport.conversion = null;
    $("downloadConvertedDxfBtn").disabled = true;
  });

  $("convertLoadPrintBtn").addEventListener("click", convertPdfAndLoadIntoTakeoff);
  $("downloadConvertedDxfBtn").addEventListener("click", downloadConvertedDxf);

  $("closePrintConverterBtn").addEventListener("click", closePrintConverterDialog);
  $("cancelPrintConverterBtn").addEventListener("click", closePrintConverterDialog);
  $("printConverterDialog").addEventListener("click", (e) => {
    if (e.target === $("printConverterDialog")) closePrintConverterDialog();
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

    if (!confirmDiscardUnsaved()) {
      e.target.value = "";
      return;
    }
    if (state.projectDirty && state.segments.length &&
        !confirm("Open a different DXF? Unsaved takeoff changes will be lost.")) return;

    const text = await file.text();
    const parsed = parseDXF(text);

    state.fileName = file.name;
    state.projectName = file.name.replace(/\.dxf$/i, "");
    state.savedProjectId = null;
    state.projectDirty = true;
    updateProjectTitle();
    state.segments = parsed.segments;
    state.labels = parsed.labels || [];
    state.detectedUnits = parsed.detectedUnits;
    state.calibration = { activePoint: null, points: [null, null], feetPerUnit: null };
    state.toolMode = "wall";
    state.trace.lastPoint = null;
    state.bounds = computeBounds(parsed.segments);
    state.walls.clear();
    state.history = [];
    state.selectedId = null;
    state.tempArea = {
      selecting: false,
      closed: false,
      points: [],
      wallIds: new Set()
    };

    $("emptyState").style.display = parsed.segments.length ? "none" : "flex";
    $("fileStatus").textContent = parsed.segments.length
      ? `${file.name} — ${parsed.segments.length.toLocaleString()} selectable line segments${state.labels.length ? ` • ${state.labels.length.toLocaleString()} text labels` : ""}${parsed.detectedUnits ? ` — units detected: ${parsed.detectedUnits}` : ""}`
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
    markProjectDirty();
    if (state.calibration.feetPerUnit) {
      state.calibration.feetPerUnit = null;
      state.calibration.points = [null, null];
      state.calibration.activePoint = null;
    }
    recalcAllWallsForUnits();
    updateCalibrationUI();
  });

  function setAllSidePanels(open) {
    document.querySelectorAll(".side-panel details.collapsible-panel").forEach(panel => {
      panel.open = open;
    });
  }

  $("collapsePanelsBtn")?.addEventListener("click", () => setAllSidePanels(false));
  $("expandPanelsBtn")?.addEventListener("click", () => setAllSidePanels(true));

  $("areaSelectBtn").addEventListener("click", startTemporaryAreaSelection);
  $("closeAreaBtn").addEventListener("click", closeTemporaryArea);
  $("clearTempAreaBtn").addEventListener("click", clearTemporaryArea);

  $("fsAreaSelectBtn").addEventListener("click", startTemporaryAreaSelection);
  $("fsCloseAreaBtn").addEventListener("click", closeTemporaryArea);
  $("fsClearTempAreaBtn").addEventListener("click", clearTemporaryArea);

  $("findSelectedBtn").addEventListener("click", () => {
    if (state.selectedId && state.walls.has(state.selectedId)) {
      focusWallSegment(state.selectedId);
    }
    if ($("viewerOptionsMenu")) $("viewerOptionsMenu").open = false;
  });

  $("deleteSelectedBtn").addEventListener("click", () => {
    if (state.selectedId && state.walls.has(state.selectedId)) {
      deleteWallById(state.selectedId, true);
    }
    if ($("viewerOptionsMenu")) $("viewerOptionsMenu").open = false;
  });

  $("wallModeBtn").addEventListener("click", () => activateWallMode(true));
  $("traceWallsBtn").addEventListener("click", activateTraceMode);
  $("traceLockBtn").addEventListener("click", toggleTraceLock);
  $("orthoLockBtn").addEventListener("click", toggleOrthoLock);
  $("scale1Btn").addEventListener("click", () => activateScalePoint(0));
  $("scale2Btn").addEventListener("click", () => activateScalePoint(1));
  $("applyCalibrationBtn").addEventListener("click", applyCalibration);
  $("cancelCalibrationBtn").addEventListener("click", cancelCalibration);
  $("resetCalibrationBtn").addEventListener("click", resetCalibration);

  $("activeWallTypeSelect").addEventListener("change", (e) => {
    markProjectDirty();
    setActiveWallType(e.target.value, false);
    updateTraceUI();
  });

  $("wallTypeSelect").addEventListener("change", (e) => {
    const name = e.target.value;
    if (name && state.wallTypes[name]) {
      state.activeWallType = name;
      $("activeWallTypeSelect").value = name;
      updateCurrentTypeBadge();
      $("wallTypeName").value = name;
      applyWallTemplate(state.wallTypes[name]);
    }
  });

  $("saveWallTypeBtn").addEventListener("click", saveWallTypeFromForm);
  $("deleteWallTypeBtn").addEventListener("click", deleteWallType);
  $("editActiveWallTypeBtn").addEventListener("click", () => {
    if (state.activeWallType) openWallTypeEditor(state.activeWallType);
  });
  $("saveWallTypeEditorBtn").addEventListener("click", saveWallTypeEditor);
  $("deleteWallTypeEditorBtn").addEventListener("click", deleteWallTypeFromEditor);
  $("closeWallTypeEditorBtn").addEventListener("click", closeWallTypeEditor);
  $("cancelWallTypeEditorBtn").addEventListener("click", closeWallTypeEditor);
  $("wallTypeEditorDialog").addEventListener("pointerdown", (e) => {
    if (e.target === $("wallTypeEditorDialog")) closeWallTypeEditor();
  });

  $("undoLastBtn").addEventListener("click", undoLastTakeoff);
  $("markupsTypeFilter").addEventListener("change", refreshTables);

  $("collapseMarkupGroupsBtn").addEventListener("click", () => {
    const walls = [...state.walls.values()];
    for (const wall of walls) state.markupCollapsedGroups.add(wall.wallType || "Unassigned");
    refreshTables();
  });

  $("expandMarkupGroupsBtn").addEventListener("click", () => {
    state.markupCollapsedGroups.clear();
    refreshTables();
  });

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

  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (typing) return;

    if ((e.key === "Delete" || e.key === "Backspace") &&
        state.selectedId && state.walls.has(state.selectedId)) {
      e.preventDefault();
      deleteWallById(state.selectedId, true);
    }
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

    if (state.tempArea.selecting) {
      addTemporaryAreaPoint(e.clientX - rect.left, e.clientY - rect.top);
      state.pointers.delete(e.pointerId);
      return;
    }

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
  initializeCollapsiblePanelScrolling();
  refreshTables();
  updateCalibrationUI();
  updateTraceUI();
  updateSelectedActionButtons();
  updateTemporaryAreaUI();
  refreshTemporaryAreaTotals();
  updateCurrentTypeBadge();
  updateProjectTitle();
  syncFullscreenTools();
  autoRestoreLastSaved();
})();
