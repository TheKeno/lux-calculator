(function () {
  const LIB = window.FIXTURES || [];
  const STORAGE_KEY = "lux-calculator-setup-v1";
  const $ = (id) => document.getElementById(id);

  // Traditional false-colour lux scale (as in DIALux/Relux plots): dark blue → cyan → green → yellow → red.
  const RAMP = ["#00007f", "#0000ff", "#007fff", "#00ffff", "#7fff7f", "#ffff00", "#ff7f00", "#ff0000", "#7f0000"];

  // ---------- state ----------

  function defaultTruss(scene, index, total) {
    const alongX = scene.orientation === "x";
    const alongLen = alongX ? scene.width : scene.depth;
    const acrossLen = alongX ? scene.depth : scene.width;
    // Whole metres, so the truss runs along a grid line rather than over a row of values.
    const across = Math.round(((index + 1) * acrossLen) / (total + 1));
    return {
      height: 6,
      length: Math.max(1, Math.round(alongLen - 2)),
      cx: alongX ? scene.width / 2 : across,
      cy: alongX ? across : scene.depth / 2,
      count: 4,
      dimmer: 100,
      fixtureId: LIB[0] ? LIB[0].id : "",
    };
  }

  function defaultScene() {
    const s = {
      width: 20, depth: 14,
      orientation: "x", fixtureDrop: 0.3, heatOpacity: 1, minSpacing: 0.5, designLux: 650, panTilt: false, trusses: [],
    };
    for (let i = 0; i < 3; i++) s.trusses.push(defaultTruss(s, i, 3));
    return s;
  }

  // The setup this browser last used; on a first visit, the project's defaults (see fetchDefaults).
  let firstVisit = false;
  function loadScene() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Object.assign(defaultScene(), JSON.parse(raw));
    } catch (e) { /* storage unavailable or corrupt: fall back to defaults */ }
    firstVisit = true;
    if (window.DEFAULT_SETUP) return Object.assign(defaultScene(), structuredClone(window.DEFAULT_SETUP));
    return defaultScene();
  }

  let scene = loadScene();
  let floorplan = null; // HTMLImageElement, not persisted in the setup (lives only in this session)
  const DEFAULT_FLOORPLAN = "floorplan.png"; // loaded from the project folder at startup, if present
  let result = null;
  let activeTruss = -1;
  let tool = "move"; // "move" | "aim"; only meaningful while scene.panTilt is on

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scene)); } catch (e) { /* ignore */ }
  }

  // ---------- sidebar ----------

  const roomFields = {
    "room-width": "width", "room-depth": "depth", "fixture-drop": "fixtureDrop", "min-spacing": "minSpacing", "design-lux": "designLux",
  };

  function syncRoomInputs() {
    for (const [id, key] of Object.entries(roomFields)) $(id).value = scene[key];
    $("orientation").value = scene.orientation;
    $("truss-count").value = scene.trusses.length;
    $("heat-opacity").value = scene.heatOpacity;
    $("room-area").textContent = `Floor area: ${(scene.width * scene.depth).toFixed(1)} m²`;
  }

  for (const [id, key] of Object.entries(roomFields)) {
    $(id).addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      scene[key] = v;
      $("room-area").textContent = `Floor area: ${(scene.width * scene.depth).toFixed(1)} m²`;
      update();
    });
  }

  $("heat-opacity").addEventListener("input", (e) => { scene.heatOpacity = parseFloat(e.target.value); save(); draw(); });

  $("truss-count").addEventListener("input", (e) => {
    const n = Math.max(0, Math.min(50, parseInt(e.target.value, 10)));
    if (!Number.isFinite(n)) return;
    while (scene.trusses.length > n) scene.trusses.pop();
    while (scene.trusses.length < n) scene.trusses.push(defaultTruss(scene, scene.trusses.length, n));
    renderTrussList();
    update();
  });

  $("orientation").addEventListener("change", (e) => {
    const next = e.target.value;
    if (next === scene.orientation) return;
    // Keep each truss at the same relative position across the room; locked axes stay put.
    for (const t of scene.trusses) {
      const rx = t.cx / scene.width, ry = t.cy / scene.depth;
      if (!t.lockX) t.cx = +(ry * scene.width).toFixed(2);
      if (!t.lockY) t.cy = +(rx * scene.depth).toFixed(2);
    }
    scene.orientation = next;
    renderTrussList();
    update();
  });

  // Rated power (W) of a truss's fixtures, at full output.
  function trussPower(t) {
    const fx = LIB.find((f) => f.id === t.fixtureId);
    return fx ? t.count * (fx.powerW || 0) : 0;
  }

  function trussSummary(t) {
    const fx = LIB.find((f) => f.id === t.fixtureId);
    return `${t.count} × ${fx ? fx.name : "?"} @ ${t.height} m`;
  }

  function renderTrussList() {
    const list = $("truss-list");
    const openState = [...list.querySelectorAll("details")].map((d) => d.open);
    list.innerHTML = "";
    const tpl = $("truss-template");
    scene.trusses.forEach((t, i) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      if (openState[i] === false || (openState[i] === undefined && scene.trusses.length > 3)) node.open = false;
      node.querySelector(".truss-name").textContent = `Truss ${i + 1}`;
      node.querySelector(".truss-summary").textContent = trussSummary(t);
      const sel = node.querySelector("select");
      for (const f of LIB) sel.add(new Option(`${f.name} (${Math.round(f.lumens)} lm)`, f.id));
      for (const input of node.querySelectorAll("[data-k]")) {
        const k = input.dataset.k;
        input.value = t[k];
        input.addEventListener("input", () => {
          if (k === "fixtureId") t[k] = input.value;
          else {
            const v = parseFloat(input.value);
            if (!Number.isFinite(v)) return;
            if (k === "count") {
              setFixtureCount(t, Math.max(0, Math.round(v)));
            } else if (k === "length") {
              // Locked fixtures keep their spot; free ones stay at the same relative spot.
              if (v <= 0) return;
              const locks = Photometry.fixtureLocks(t);
              t.positions = Photometry.fixturePositions(t).map((p, f) =>
                +(locks[f] ? Math.min(p, v) : (p / t.length) * v).toFixed(2));
              t.length = v;
            } else t[k] = v;
          }
          node.querySelector(".truss-summary").textContent = trussSummary(t);
          refreshPositions(i);
          update();
        });
      }
      for (const btn of node.querySelectorAll(".lock")) {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          t[btn.dataset.lock] = !t[btn.dataset.lock];
          refreshLocks(i);
          save();
        });
      }
      node.querySelector(".spread").addEventListener("click", () => {
        t.positions = Photometry.spreadPositions(t.length, Photometry.fixturePositions(t), Photometry.fixtureLocks(t));
        refreshPositions(i);
        update();
      });
      node.querySelector(".remove").addEventListener("click", (e) => {
        e.preventDefault();
        scene.trusses.splice(i, 1);
        $("truss-count").value = scene.trusses.length;
        renderTrussList();
        update();
      });
      node.addEventListener("mouseenter", () => { activeTruss = i; draw(); });
      node.addEventListener("mouseleave", () => { activeTruss = -1; draw(); });
      list.appendChild(node);
      refreshPositions(i);
      refreshLocks(i);
    });
  }

  // Reflects a truss's axis locks on its toggle buttons and position inputs.
  function refreshLocks(i) {
    const node = $("truss-list").children[i];
    if (!node) return;
    const t = scene.trusses[i];
    for (const [axis, k, name] of [["lockX", "cx", "X"], ["lockY", "cy", "Y"]]) {
      const locked = !!t[axis];
      const btn = node.querySelector(`[data-lock="${axis}"]`);
      btn.setAttribute("aria-pressed", locked);
      btn.title = `${locked ? "Unlock" : "Lock"} ${name} position`;
      node.querySelector(`[data-k="${k}"]`).disabled = locked;
    }
  }

  function refreshTrussInputs(i) {
    const node = $("truss-list").children[i];
    if (!node) return;
    node.querySelector('[data-k="cx"]').value = scene.trusses[i].cx;
    node.querySelector('[data-k="cy"]').value = scene.trusses[i].cy;
  }

  // Changes a truss's fixture count, keeping locked fixtures (removing free ones first)
  // and re-spreading the free ones around them.
  function setFixtureCount(t, n) {
    const locks = Photometry.fixtureLocks(t);
    const aims = Photometry.fixtureAims(t);
    const items = Photometry.fixturePositions(t).map((p, f) => ({ p, locked: locks[f], aim: aims[f] }));
    for (let f = items.length - 1; f >= 0 && items.length > n; f--) if (!items[f].locked) items.splice(f, 1);
    items.length = Math.min(items.length, n);
    while (items.length < n) items.push({ p: t.length, locked: false, aim: null });
    t.count = n;
    t.locks = items.map((it) => it.locked);
    t.aims = items.map((it) => it.aim);
    t.positions = Photometry.spreadPositions(t.length, items.map((it) => it.p), t.locks);
  }

  // Tilt in degrees per fixture of truss i (0 = straight down / not aimed).
  function fixtureTilts(i) {
    const t = scene.trusses[i];
    const alongX = scene.orientation === "x";
    const z = t.height - scene.fixtureDrop;
    const aims = Photometry.fixtureAims(t);
    return Photometry.fixturePositions(t).map((s, f) => {
      if (!aims[f]) return 0;
      const a = (alongX ? t.cx : t.cy) - t.length / 2 + s;
      const pos = alongX ? [a, t.cy, z] : [t.cx, a, z];
      return Photometry.tiltTowards(pos, aims[f]);
    });
  }

  function refreshPositions(i) {
    const node = $("truss-list").children[i];
    if (!node) return;
    const t = scene.trusses[i];
    const pos = Photometry.fixturePositions(t);
    const locks = Photometry.fixtureLocks(t);
    const tilts = scene.panTilt ? fixtureTilts(i) : [];
    node.querySelector(".positions").textContent = pos.length
      ? `At ${pos.map((p, f) => p.toFixed(2) + (tilts[f] ? ` (${Math.round(tilts[f])}°)` : "") + (locks[f] ? " 🔒" : "")).join(", ")} m`
      : "No fixtures";
    node.querySelector(".positions").title = "Fixture positions, measured from the truss start";
  }

  function renderLibrary() {
    const el = $("fixture-library");
    if (!LIB.length) { el.innerHTML = "<p class='hint'>No fixtures found — run the extractor.</p>"; return; }
    el.innerHTML = LIB.map((f) =>
      `<div class="fixture-card"><strong>${f.name}</strong> <span>${f.manufacturer}</span><br>
       <span>${Math.round(f.lumens)} lm · ${f.powerW} W · beam ${f.beamAngle}° / field ${f.fieldAngle}° · ${Math.round(f.maxIntensityCd)} cd max</span></div>`
    ).join("");
  }

  // ---------- floor plan ----------

  $("file-floorplan").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => { floorplan = img; draw(); };
    img.src = URL.createObjectURL(file);
    e.target.value = "";
  });
  $("btn-clear-floorplan").addEventListener("click", () => { floorplan = null; draw(); });

  // ---------- save / load ----------

  $("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lux-setup.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("file-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      applySetup(JSON.parse(await file.text()));
    } catch (err) {
      alert("Could not read that file: " + err.message);
    }
    e.target.value = "";
  });

  function applySetup(setup) {
    scene = Object.assign(defaultScene(), setup);
    syncRoomInputs();
    renderTrussList();
    syncPanTiltUi();
    update();
  }

  // Reads defaults.json. Browsers block that read when the page is opened from disk, so fall back
  // to defaults.js, a copy generated from it by `node tools/build-defaults.mjs`.
  async function fetchDefaults() {
    try {
      const res = await fetch("defaults.json", { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch (e) { /* file:// or offline: use the generated copy */ }
    return window.DEFAULT_SETUP ? structuredClone(window.DEFAULT_SETUP) : null;
  }

  $("btn-defaults").addEventListener("click", async () => {
    const setup = await fetchDefaults();
    if (!setup) {
      alert("No defaults found. Save a setup as defaults.json in the project folder, then run: node tools/build-defaults.mjs");
      return;
    }
    applySetup(setup);
  });

  // Moves unlocked fixtures for the most even light between the trusses, keeping each truss
  // symmetric about its centre (see optimiseCoverage).
  $("btn-optimise").addEventListener("click", () => {
    const out = $("optimise-result");
    const r = Photometry.optimiseCoverage(scene, LIB);
    if (!r) { out.textContent = "All fixtures are locked, so there is nothing to move."; return; }
    scene.trusses.forEach((t, i) => { t.positions = r.positions[i]; });
    scene.trusses.forEach((_, i) => refreshPositions(i));
    update();
    const names = (list) => list.map((i) => `Truss ${i + 1}`).join(", ");
    let note = "";
    if (r.asymmetric.length) note += ` · ${names(r.asymmetric)} can't be symmetric because of locked fixtures`;
    if (r.crowded.length) note += ` · ${names(r.crowded)} too short to keep ${scene.minSpacing} m between fixtures`;
    out.textContent = (r.moved
      ? `Min/avg ${r.before.u0.toFixed(2)} → ${r.after.u0.toFixed(2)} · moved ${r.moved} fixture${r.moved === 1 ? "" : "s"}`
      : `Already as even as it gets (min/avg ${r.after.u0.toFixed(2)})`) + note;
  });

  // Decides fixture counts and positions for the target average lux (see designForTarget).
  $("btn-design").addEventListener("click", () => {
    const btn = $("btn-design"), out = $("design-result");
    const target = scene.designLux;
    if (!(target > 0)) { out.textContent = "Enter a target lux first."; return; }
    btn.disabled = true;
    out.textContent = "Working…";
    // Let the browser paint "Working…" before the (up to a few seconds) search blocks the page.
    setTimeout(() => {
      const r = Photometry.designForTarget(scene, LIB, target);
      scene.trusses.forEach((t, i) => Object.assign(t, r.trusses[i]));
      renderTrussList();
      update();
      const total = r.trusses.reduce((s, t) => s + t.count, 0);
      const perTruss = r.trusses.map((t) => t.count).join(" / ");
      const lead = r.reached ? "" : `Can't reach ${target} lx with these trusses at ${scene.minSpacing} m spacing. `;
      out.textContent = lead +
        `${total} fixtures (${perTruss}) · avg ${Math.round(r.stats.mean)} lx · min ${Math.round(r.stats.min)} lx`;
      btn.disabled = false;
    }, 20);
  });

  // ---------- pan/tilt toolbar ----------

  function syncPanTiltUi() {
    const on = !!scene.panTilt;
    if (!on) tool = "move";
    $("btn-pantilt").setAttribute("aria-pressed", on);
    $("tool-switch").hidden = !on;
    $("btn-reset-aims").hidden = !on;
    for (const b of $("tool-switch").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.tool === tool);
    $("tool-hint").textContent = !on ? ""
      : tool === "aim" ? "Drag from a fixture to where it should point · double-click a fixture to point it straight down"
      : "Aimed fixtures keep pointing at their spot when moved";
    scene.trusses.forEach((_, i) => refreshPositions(i));
  }

  $("btn-pantilt").addEventListener("click", () => {
    scene.panTilt = !scene.panTilt;
    syncPanTiltUi();
    update();
  });
  for (const b of $("tool-switch").querySelectorAll("button")) {
    b.addEventListener("click", () => { tool = b.dataset.tool; syncPanTiltUi(); draw(); });
  }
  $("btn-reset-aims").addEventListener("click", () => {
    for (const t of scene.trusses) t.aims = [];
    syncPanTiltUi();
    update();
  });

  // ---------- calculation ----------

  function update() {
    save();
    result = Photometry.computeGrid(scene, LIB);
    renderTotals();
    draw();
  }

  // Tiles above the heatmap: total fixture count, then each truss's rated power.
  function renderTotals() {
    const total = scene.trusses.reduce((s, t) => s + t.count, 0);
    const tile = (label, value, unit = "") =>
      `<div class="stat"><div class="label">${label}</div><div class="value">${value} <small>${unit}</small></div></div>`;
    $("stats").innerHTML = [
      tile("Fixtures", total),
      ...scene.trusses.map((t, i) => {
        const w = trussPower(t);
        return w >= 1000 ? tile(`Truss ${i + 1} power`, (w / 1000).toFixed(2), "kW") : tile(`Truss ${i + 1} power`, Math.round(w), "W");
      }),
    ].join("");
  }

  // ---------- drawing ----------

  const canvas = $("plan");
  const ctx = canvas.getContext("2d");
  const MIN_CELL_PX = 30; // keeps the value in each 1 m square readable
  const PAD = { l: 34, t: 24, r: 14, b: 28 }; // top leaves room for tags of trusses along Y
  let view = { scale: 1, ox: 0, oy: 0 };

  function hexToRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  const RAMP_RGB = RAMP.map(hexToRgb);
  function rampColor(t) {
    t = Math.max(0, Math.min(1, t)) * (RAMP_RGB.length - 1);
    const i = Math.min(RAMP_RGB.length - 2, Math.floor(t)), f = t - i;
    const a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }


  function niceStep(max, target = 6) {
    const raw = max / target;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  }

  function scaleMax() {
    return Math.max(1, result.max);
  }

  const toPx = (x, y) => [view.ox + x * view.scale, view.oy + y * view.scale];
  const toWorld = (px, py) => [(px - view.ox) / view.scale, (py - view.oy) / view.scale];

  function draw() {
    if (!result) return;
    const wrap = $("plan-wrap");
    const fit = Math.min((wrap.clientWidth - PAD.l - PAD.r) / scene.width, (window.innerHeight * 0.68 - PAD.t - PAD.b) / scene.depth);
    // Never shrink a 1 m square below MIN_CELL_PX; large rooms scroll inside the plan instead.
    const scale = Math.max(fit, MIN_CELL_PX);
    const cssW = Math.max(wrap.clientWidth, Math.ceil(scene.width * scale + PAD.l + PAD.r));
    const cssH = Math.round(scene.depth * scale + PAD.t + PAD.b);
    view = { scale, ox: PAD.l, oy: PAD.t };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const W = scene.width * scale, H = scene.depth * scale;

    // 1 m cells coloured by the illuminance at their centre, value printed inside.
    const { nx, ny, xs, ys, values } = result;
    const max = scaleMax();
    // Text is sized from a full 1 m square; each square then shows its value only if it fits,
    // so narrow clipped squares at the walls don't hide the labels everywhere else.
    const fontPx = Math.max(9, Math.min(14, scale * 0.3));
    const covered = []; // labels with no clear spot in their square; drawn on top of the trusses
    const obstacles = labelObstacles();
    // The plan underneath shows through as the heatmap is faded; only the colour fills take the opacity.
    if (floorplan) ctx.drawImage(floorplan, view.ox, view.oy, W, H);
    ctx.save();
    ctx.globalAlpha = scene.heatOpacity;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const [r, g, b] = rampColor(values[j * nx + i] / max);
        const [x0, y0] = toPx(xs[i], ys[j]);
        const [x1, y1] = toPx(xs[i + 1], ys[j + 1]);
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    ctx.restore();

    // Plan lines again on top with multiply (white vanishes), so walls stay visible at any opacity.
    if (floorplan) {
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(floorplan, view.ox, view.oy, W, H);
      ctx.restore();
    }

    // Grid lines on the 1 m boundaries.
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of xs.slice(1, -1)) { const [px] = toPx(x, 0); ctx.moveTo(px, view.oy); ctx.lineTo(px, view.oy + H); }
    for (const y of ys.slice(1, -1)) { const [, py] = toPx(0, y); ctx.moveTo(view.ox, py); ctx.lineTo(view.ox + W, py); }
    ctx.stroke();

    // Every cell gets its value.
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = values[j * nx + i];
        const [x0, y0] = toPx(xs[i], ys[j]);
        const [x1, y1] = toPx(xs[i + 1], ys[j + 1]);
        const text = String(Math.round(v));
        const tw = ctx.measureText(text).width;
        if (tw + 4 <= x1 - x0 && fontPx + 4 <= y1 - y0) {
          // Slide the label clear of trusses; if it doesn't fit beside one, shrink it until it does.
          // As a last resort (e.g. a fixture sitting mid-square) slide along the truss instead.
          let spot = null;
          for (const vertical of [scene.orientation === "x", scene.orientation !== "x"]) {
            for (let size = fontPx; size >= 8 && !spot; size--) {
              ctx.font = `600 ${size}px system-ui, sans-serif`;
              spot = placeLabel(ctx.measureText(text).width, size, x0, y0, x1, y1, obstacles, vertical);
            }
            if (spot) break;
          }
          if (spot) {
            drawLuxText(text, spot[0], spot[1]);
          } else {
            covered.push({ text, x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
          }
          ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
        }
      }
    }

    // Room outline and ruler.
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(view.ox + 0.5, view.oy + 0.5, W - 1, H - 1);
    drawRuler(W, H);

    drawTrusses();

    // Squares fully covered by a fixture: put the value on a white patch above everything.
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    for (const c of covered) {
      const tw = ctx.measureText(c.text).width + 6, th = fontPx + 4;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(c.x - tw / 2, c.y - th / 2, tw, th);
      drawLuxText(c.text, c.x, c.y);
    }

    if (scene.panTilt) drawAimArrows();
    if (drag && drag.kind === "fixture" && drag.moved) drawDistanceArrows(drag.index, drag.fixture);
    if (drag && drag.kind === "truss" && drag.moved) drawTrussWallArrows(drag.index);

  }

  // Pixel shapes drawn over the grid (trusses and fixture markers) that cell labels should avoid.
  function labelObstacles() {
    const rects = scene.trusses.map((t) => {
      const alongX = scene.orientation === "x";
      const wid = Math.max(10, TRUSS_W * view.scale) + 6; // casing and corner couplers
      const [ax, ay] = alongX ? toPx(t.cx - t.length / 2, t.cy) : toPx(t.cx, t.cy - t.length / 2);
      const len = t.length * view.scale + 6;
      return alongX ? { x: ax - 3, y: ay - wid / 2, w: len, h: wid } : { x: ax - wid / 2, y: ay - 3, w: wid, h: len };
    });
    scene.trusses.forEach((t, i) => rects.push(tagRect(t, i)));
    const circles = result.placed.map((p) => {
      const [cx, cy] = toPx(p.pos[0], p.pos[1]);
      return { cx, cy, r: FIXTURE_R + 3 }; // + hover growth
    });
    return { rects, circles };
  }

  // Centre of a tw×th label inside the cell: the middle if it's clear, otherwise the nearest
  // clear spot sliding across the truss direction (up/down for X trusses, left/right for Y).
  // Returns null if no clear spot exists.
  function placeLabel(tw, th, x0, y0, x1, y1, obs, vertical = scene.orientation === "x") {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const hits = (cx, cy) => {
      const l = cx - tw / 2 - 1, r = cx + tw / 2 + 1, t = cy - th / 2 - 1, b = cy + th / 2 + 1;
      for (const o of obs.rects) if (l < o.x + o.w && r > o.x && t < o.y + o.h && b > o.y) return true;
      for (const c of obs.circles) {
        const dx = c.cx - Math.max(l, Math.min(c.cx, r)), dy = c.cy - Math.max(t, Math.min(c.cy, b));
        if (dx * dx + dy * dy < c.r * c.r) return true;
      }
      return false;
    };
    if (!hits(mx, my)) return [mx, my];
    const reach = vertical ? (y1 - y0 - th) / 2 - 1 : (x1 - x0 - tw) / 2 - 1;
    for (let d = 1; d <= reach; d++) {
      for (const sgn of [-1, 1]) {
        const cx = vertical ? mx : mx + sgn * d, cy = vertical ? my + sgn * d : my;
        if (!hits(cx, cy)) return [cx, cy];
      }
    }
    return null; // nowhere clear at this text size
  }

  // Black lux value with a light grey outline, so it reads on the darkest squares too.
  function drawLuxText(text, x, y) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#d4d4d4";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#000000";
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawRuler(W, H) {
    const s = Math.max(1, niceStep(Math.max(scene.width, scene.depth), 20));
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let x = 0; x <= scene.width + 1e-6; x += s) {
      const [px] = toPx(x, 0);
      ctx.beginPath(); ctx.moveTo(px, view.oy + H); ctx.lineTo(px, view.oy + H + 4); ctx.stroke();
      ctx.fillText(+x.toFixed(2) + (x === 0 ? " m" : ""), px, view.oy + H + 7);
    }
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let y = 0; y <= scene.depth + 1e-6; y += s) {
      const [, py] = toPx(0, y);
      ctx.beginPath(); ctx.moveTo(view.ox - 4, py); ctx.lineTo(view.ox, py); ctx.stroke();
      ctx.fillText(+y.toFixed(2), view.ox - 7, py);
    }
  }

  const FIXTURE_R = 15; // fixture marker radius in px
  const TRUSS_W = 0.29; // standard 290 mm box truss, in metres

  function trussRect(t) {
    const alongX = scene.orientation === "x";
    const w = alongX ? t.length : TRUSS_W, h = alongX ? TRUSS_W : t.length;
    return { x: t.cx - w / 2, y: t.cy - h / 2, w, h };
  }

  // Top view of a box truss: two main chords, zigzag lacing between them, and an end
  // frame with corner couplers at each end. Drawn in the truss's own frame (x along its length).
  function drawTrussShape(t, active) {
    const len = t.length * view.scale;
    const wid = Math.max(10, TRUSS_W * view.scale); // stays visible when zoomed out
    const [sx, sy] = scene.orientation === "x" ? toPx(t.cx - t.length / 2, t.cy) : toPx(t.cx, t.cy - t.length / 2);
    const half = wid / 2;
    const bays = Math.max(1, Math.round(len / wid)); // ~45° diagonals, like real lacing

    const path = () => {
      ctx.beginPath();
      ctx.moveTo(0, -half); ctx.lineTo(len, -half); // chords
      ctx.moveTo(0, half); ctx.lineTo(len, half);
      ctx.moveTo(0, -half); ctx.lineTo(0, half);   // end frames
      ctx.moveTo(len, -half); ctx.lineTo(len, half);
    };
    const lacing = () => {
      ctx.beginPath();
      ctx.moveTo(0, half);
      for (let k = 1; k <= bays; k++) ctx.lineTo((k * len) / bays, k % 2 ? -half : half);
    };

    ctx.save();
    ctx.translate(sx, sy);
    if (scene.orientation === "y") ctx.rotate(Math.PI / 2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Black truss; orange while hovered or dragged.
    const metal = active ? "#f09a2a" : "#000000";
    ctx.strokeStyle = metal;
    ctx.lineWidth = 1.5; lacing(); ctx.stroke();
    ctx.lineWidth = 2.5; path(); ctx.stroke();

    // Corner couplers.
    ctx.fillStyle = metal;
    for (const cx of [0, len]) for (const cy of [-half, half]) ctx.fillRect(cx - 3, cy - 3, 6, 6);
    ctx.restore();
  }

  const TAG_FONT = "600 11px system-ui, sans-serif";

  // Pixel box of a truss's "T1" tag, just outside its start end.
  function tagRect(t, i) {
    const r = trussRect(t);
    const [x, y] = toPx(r.x, r.y);
    const w = r.w * view.scale, h = r.h * view.scale;
    ctx.save();
    ctx.font = TAG_FONT;
    const tw = ctx.measureText(`T${i + 1}`).width + 8, th = 16;
    ctx.restore();
    const lx = scene.orientation === "x" ? x - tw - 3 : x + w / 2 - tw / 2;
    const ly = scene.orientation === "x" ? y + h / 2 - th / 2 : y - th - 3;
    return { x: lx, y: ly, w: tw, h: th };
  }

  function drawTrusses() {
    ctx.font = TAG_FONT;
    scene.trusses.forEach((t, i) => {
      const active = i === activeTruss || (drag && drag.kind !== "aim" && drag.index === i);
      drawTrussShape(t, active);
      // Tag on a solid pill just outside the truss's start end, so it stays readable over values.
      const label = `T${i + 1}`;
      const { x: lx, y: ly, w: tw, h: th } = tagRect(t, i);
      ctx.fillStyle = active ? "#f09a2a" : "#141416";
      ctx.fillRect(lx, ly, tw, th);
      ctx.fillStyle = active ? "#141416" : "#f2f1ec";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + tw / 2, ly + th / 2 + 0.5);
    });
    for (const p of result.placed) {
      const [px, py] = toPx(p.pos[0], p.pos[1]);
      const dragged = drag && drag.kind === "fixture" && drag.index === p.truss && drag.fixture === p.index;
      const hovered = hover && hover.truss === p.truss && hover.fixture === p.index;
      ctx.beginPath();
      ctx.arc(px, py, dragged || hovered ? FIXTURE_R + 3 : FIXTURE_R, 0, Math.PI * 2);
      ctx.fillStyle = dragged ? "#f09a2a" : "#fff";
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#141416";
      ctx.stroke();
      // Locked fixtures always show a closed padlock; hovering an unlocked one shows an open one.
      if (p.locked || hovered) drawPadlock(px, py, p.locked);
    }
  }

  const DIM_BLUE = "#1f6feb";

  // Strokes a path white (wider) then blue, so dimension lines read on blue heatmap squares too.
  function strokeCased(build, width) {
    for (const [color, w] of [["#ffffff", width + 2.5], [DIM_BLUE, width]]) {
      ctx.strokeStyle = color; ctx.lineWidth = w; build(); ctx.stroke();
    }
  }

  // Blue dimension arrow from p0 to p1 (screen px) with its head at p1, labelled with `dist` metres.
  // The label sits mid-arrow, or beside the arrow's middle when the arrow is too short to hold it
  // (placing it past p1 could push it outside the room or off the canvas).
  function drawDimArrow(p0, p1, dist) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    const u = len ? [dx / len, dy / len] : [1, 0];
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (len > 0.5) {
      const head = Math.min(8, len), w = 4.5;
      const hx = p1[0] - u[0] * head, hy = p1[1] - u[1] * head;
      strokeCased(() => {
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
        ctx.moveTo(hx - u[1] * w, hy + u[0] * w); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(hx + u[1] * w, hy - u[0] * w);
      }, 2);
    }
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = `${dist.toFixed(2)} m`;
    const tw = ctx.measureText(text).width + 10, th = 18;
    const horizontal = Math.abs(u[0]) > Math.abs(u[1]);
    const need = horizontal ? tw : th; // label extent along the arrow
    let lx = p0[0] + dx / 2, ly = p0[1] + dy / 2;
    if (len - 10 < need) {
      // Beside the arrow: above a horizontal one, right of a vertical one.
      if (horizontal) ly -= th / 2 + 6; else lx += tw / 2 + 6;
    }
    ctx.fillStyle = DIM_BLUE;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(lx - tw / 2, ly - th / 2, tw, th, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, lx, ly + 0.5);
    ctx.restore();
  }

  // While a fixture is dragged: arrows from it to both truss ends on one side of the truss, and
  // arrows to its nearest neighbouring fixture each way on the other side.
  function drawDistanceArrows(ti, fi) {
    const t = scene.trusses[ti];
    const s = Photometry.fixturePositions(t)[fi];
    const alongX = scene.orientation === "x";
    const [sx, sy] = alongX ? toPx(t.cx - t.length / 2, t.cy) : toPx(t.cx, t.cy - t.length / 2);
    const a = alongX ? [1, 0] : [0, 1];   // along the truss
    const n = alongX ? [0, -1] : [-1, 0]; // towards the side the arrows sit on
    const off = FIXTURE_R + 16;
    const pt = (u, o = off) => [sx + a[0] * u + n[0] * o, sy + a[1] * u + n[1] * o];
    const fu = s * view.scale, len = t.length * view.scale;

    // Extension lines from the truss centreline out to the dimension line.
    ctx.save();
    ctx.lineCap = "round";
    strokeCased(() => {
      ctx.beginPath();
      for (const u of [0, fu, len]) {
        const [x0, y0] = pt(u, u === fu ? FIXTURE_R + 3 : 4);
        const [x1, y1] = pt(u, off + 5);
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
    }, 1);
    ctx.restore();

    drawDimArrow(pt(fu), pt(0), s);
    drawDimArrow(pt(fu), pt(len), t.length - s);

    // Nearest fixture before and after this one along the truss.
    const others = Photometry.fixturePositions(t).filter((_, f) => f !== fi);
    const before = Math.max(-Infinity, ...others.filter((p) => p <= s));
    const after = Math.min(Infinity, ...others.filter((p) => p > s));
    const neighbours = [before, after].filter(Number.isFinite);
    if (!neighbours.length) return;
    ctx.save();
    ctx.lineCap = "round";
    strokeCased(() => {
      ctx.beginPath();
      for (const u of [s, ...neighbours].map((p) => p * view.scale)) {
        const [x0, y0] = pt(u, -(FIXTURE_R + 3));
        const [x1, y1] = pt(u, -(off + 5));
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
    }, 1);
    ctx.restore();
    for (const p of neighbours) drawDimArrow(pt(fu, -off), pt(p * view.scale, -off), Math.abs(p - s));
  }

  // While a truss is dragged: arrows to all four walls, plus to the nearest truss on each side.
  // Along the truss they run from each end to the wall; across it they run from the truss edge
  // to the side walls and to the neighbouring trusses (distances are centreline to centreline).
  function drawTrussWallArrows(ti) {
    const t = scene.trusses[ti];
    const alongX = scene.orientation === "x";
    const halfW = Math.max(10, TRUSS_W * view.scale) / 2 + 3; // clear of the drawn truss
    const start = (alongX ? t.cx : t.cy) - t.length / 2, end = start + t.length;
    const across = alongX ? t.cy : t.cx;
    const alongMax = alongX ? scene.width : scene.depth, acrossMax = alongX ? scene.depth : scene.width;
    // World (along, across) to screen, with an optional pixel nudge across the truss.
    const P = (u, v, nudge = 0) => {
      const [x, y] = alongX ? toPx(u, v) : toPx(v, u);
      return alongX ? [x, y + nudge] : [x + nudge, y];
    };
    // Across-arrows sit in the widest gap between fixtures, so none is covered: wall arrows at a
    // third of the way along it, neighbour-truss arrows at two thirds.
    const stops = [0, ...Photometry.fixturePositions(t).slice().sort((p, q) => p - q), t.length];
    let gap = 0;
    for (let g = 1; g < stops.length; g++) if (stops[g] - stops[g - 1] > stops[gap + 1] - stops[gap]) gap = g - 1;
    const at = (f) => start + stops[gap] + f * (stops[gap + 1] - stops[gap]);
    const wallAt = at(1 / 3), trussAt = at(2 / 3);
    drawDimArrow(P(start, across), P(0, across), start);
    drawDimArrow(P(end, across), P(alongMax, across), alongMax - end);
    drawDimArrow(P(wallAt, across, -halfW), P(wallAt, 0), across);
    drawDimArrow(P(wallAt, across, halfW), P(wallAt, acrossMax), acrossMax - across);

    const others = scene.trusses.filter((_, j) => j !== ti).map((o) => (alongX ? o.cy : o.cx));
    const before = Math.max(-Infinity, ...others.filter((v) => v <= across));
    const after = Math.min(Infinity, ...others.filter((v) => v > across));
    if (Number.isFinite(before)) drawDimArrow(P(trussAt, across, -halfW), P(trussAt, before, halfW), across - before);
    if (Number.isFinite(after)) drawDimArrow(P(trussAt, across, halfW), P(trussAt, after, -halfW), after - across);
  }

  // Pan/tilt on: a faint arrow from each aimed fixture to its aim spot, labelled with the tilt.
  // The one being aimed is drawn in solid blue.
  function drawAimArrows() {
    for (const p of result.placed) {
      if (!p.aim) continue;
      const active = drag && drag.kind === "aim" && drag.index === p.truss && drag.fixture === p.index;
      const [fx, fy] = toPx(p.pos[0], p.pos[1]);
      const [ax, ay] = toPx(p.aim[0], p.aim[1]);
      const len = Math.hypot(ax - fx, ay - fy);
      const label = `${Math.round(p.tilt)}°`;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (len > FIXTURE_R + 6) {
        const u = [(ax - fx) / len, (ay - fy) / len];
        const sx = fx + u[0] * (FIXTURE_R + 2), sy = fy + u[1] * (FIXTURE_R + 2);
        const head = 9, w = 5;
        const hx = ax - u[0] * head, hy = ay - u[1] * head;
        const path = () => {
          ctx.beginPath();
          ctx.moveTo(sx, sy); ctx.lineTo(ax, ay);
          ctx.moveTo(hx - u[1] * w, hy + u[0] * w); ctx.lineTo(ax, ay); ctx.lineTo(hx + u[1] * w, hy - u[0] * w);
        };
        const casing = active ? "#ffffff" : "rgba(0,0,0,0.35)";
        const stroke = active ? DIM_BLUE : "rgba(255,255,255,0.75)";
        ctx.strokeStyle = casing; ctx.lineWidth = active ? 4.5 : 3.5; path(); ctx.stroke();
        ctx.strokeStyle = stroke; ctx.lineWidth = active ? 2 : 1.5; path(); ctx.stroke();
        // Tilt label just past the arrowhead.
        drawAimLabel(label, ax + u[0] * 16, ay + u[1] * 16, active);
      } else {
        drawAimLabel(label, fx + FIXTURE_R + 14, fy - FIXTURE_R, active);
      }
      ctx.restore();
    }
  }

  function drawAimLabel(text, x, y, active) {
    ctx.font = `600 ${active ? 13 : 11}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width + 8, th = active ? 18 : 15;
    ctx.fillStyle = active ? DIM_BLUE : "rgba(20,20,22,0.7)";
    ctx.beginPath();
    ctx.roundRect(x - tw / 2, y - th / 2, tw, th, 4);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x, y + 0.5);
  }

  function drawPadlock(cx, cy, locked) {
    const color = locked ? "#141416" : "#7a7a80";
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (locked) {
      ctx.moveTo(cx - 3.5, cy - 1);
      ctx.arc(cx, cy - 4.5, 3.5, Math.PI, 0);
      ctx.lineTo(cx + 3.5, cy - 1);
    } else {
      // Shackle raised with its right leg free of the body.
      ctx.moveTo(cx - 3.5, cy - 1);
      ctx.arc(cx, cy - 6.5, 3.5, Math.PI, 0);
      ctx.lineTo(cx + 3.5, cy - 4.5);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(cx - 5.5, cy - 1.5, 11, 8.5, 1.5);
    ctx.fill();
    ctx.restore();
  }

  // ---------- interaction ----------

  let drag = null;  // { kind: "truss" | "fixture", index, fixture?, offX?, offY?, startX?, startY?, moved? }
  let hover = null; // { truss, fixture } under the pointer
  const tooltip = $("tooltip");

  function eventPos(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function hitFixture(px, py) {
    let best = null, bestD = FIXTURE_R + 3; // px radius
    for (const p of result.placed) {
      const [fx, fy] = toPx(p.pos[0], p.pos[1]);
      const d = Math.hypot(fx - px, fy - py);
      if (d <= bestD) { bestD = d; best = { truss: p.truss, fixture: p.index }; }
    }
    return best;
  }

  function hitTruss(wx, wy) {
    const tol = 6 / view.scale; // a few px of slack around thin trusses
    for (let i = scene.trusses.length - 1; i >= 0; i--) {
      const r = trussRect(scene.trusses[i]);
      if (wx >= r.x - tol && wx <= r.x + r.w + tol && wy >= r.y - tol && wy <= r.y + r.h + tol) return i;
    }
    return -1;
  }

  function showTooltip(html, px, py) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const wrap = $("plan-wrap");
    const flip = px - wrap.scrollLeft > wrap.clientWidth - 170;
    tooltip.style.left = (flip ? px - 12 - tooltip.offsetWidth : px + 14) + "px";
    tooltip.style.top = py + 14 + "px";
  }

  // Cursor over a truss hints which way it can still move.
  function trussCursor(i) {
    if (i < 0) return "crosshair";
    const t = scene.trusses[i];
    if (t.lockX && t.lockY) return "not-allowed";
    if (t.lockX) return "ns-resize";
    if (t.lockY) return "ew-resize";
    return "grab";
  }

  canvas.addEventListener("pointerdown", (e) => {
    const [px, py] = eventPos(e);
    const [wx, wy] = toWorld(px, py);
    const f = hitFixture(px, py);
    if (scene.panTilt && tool === "aim") {
      if (!f) return;
      drag = { kind: "aim", index: f.truss, fixture: f.fixture, startX: px, startY: py, moved: false };
      tooltip.hidden = true;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "crosshair";
      return;
    }
    if (f) {
      // A fixture press is a click (toggle lock) until the pointer moves a few px, then a drag.
      drag = { kind: "fixture", index: f.truss, fixture: f.fixture, startX: px, startY: py, moved: false };
    } else {
      const i = hitTruss(wx, wy);
      if (i < 0) return;
      const t = scene.trusses[i];
      drag = { kind: "truss", index: i, offX: wx - t.cx, offY: wy - t.cy };
      tooltip.hidden = true;
    }
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });

  let pending = false;
  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; update(); });
  }

  canvas.addEventListener("pointermove", (e) => {
    const [px, py] = eventPos(e);
    const [wx, wy] = toWorld(px, py);
    if (drag && drag.kind === "aim") {
      if (!drag.moved && Math.hypot(px - drag.startX, py - drag.startY) < 4) return;
      drag.moved = true;
      const t = scene.trusses[drag.index];
      const snap = (v, hi) => Math.round(Math.max(0, Math.min(hi, v)) * 10) / 10; // 10 cm, inside the room
      t.aims = Photometry.fixtureAims(t);
      t.aims[drag.fixture] = [snap(wx, scene.width), snap(wy, scene.depth)];
      refreshPositions(drag.index);
      scheduleUpdate();
      return;
    }
    if (drag && drag.kind === "truss") {
      const t = scene.trusses[drag.index];
      drag.moved = true;
      const snap = (v) => Math.round(v * 10) / 10; // 10 cm steps
      if (!t.lockX) t.cx = snap(Math.max(0, Math.min(scene.width, wx - drag.offX)));
      if (!t.lockY) t.cy = snap(Math.max(0, Math.min(scene.depth, wy - drag.offY)));
      refreshTrussInputs(drag.index);
      scheduleUpdate();
      return;
    }
    if (drag && drag.kind === "fixture") {
      const t = scene.trusses[drag.index];
      if (!drag.moved && Math.hypot(px - drag.startX, py - drag.startY) < 4) return;
      drag.moved = true;
      if (Photometry.fixtureLocks(t)[drag.fixture]) {
        tooltip.hidden = true;
        draw(); // shows the distance arrows; the locked fixture itself stays put
        return;
      }
      // Project the pointer onto the truss axis; offsets are measured from the truss start.
      const start = scene.orientation === "x" ? t.cx - t.length / 2 : t.cy - t.length / 2;
      const along = (scene.orientation === "x" ? wx : wy) - start;
      const s = Math.round(Math.max(0, Math.min(t.length, along)) * 20) / 20; // 5 cm steps
      t.positions = Photometry.fixturePositions(t);
      t.positions[drag.fixture] = s;
      refreshPositions(drag.index);
      tooltip.hidden = true; // the distance arrows show the position
      scheduleUpdate();
      return;
    }
    const f = hitFixture(px, py);
    const changed = (f && f.truss) !== (hover && hover.truss) || (f && f.fixture) !== (hover && hover.fixture);
    hover = f;
    if (changed) draw();
    if (f && scene.panTilt && tool === "aim") {
      const tilt = fixtureTilts(f.truss)[f.fixture];
      canvas.style.cursor = "crosshair";
      showTooltip(`<b>T${f.truss + 1} · fixture ${f.fixture + 1}</b> · ${tilt ? `tilt ${Math.round(tilt)}°` : "straight down"}<br>` +
        "Drag to aim · double-click to point straight down", px, py);
      return;
    }
    if (f) {
      const t = scene.trusses[f.truss];
      const locked = Photometry.fixtureLocks(t)[f.fixture];
      const at = Photometry.fixturePositions(t)[f.fixture];
      canvas.style.cursor = locked ? "pointer" : scene.orientation === "y" ? "ns-resize" : "ew-resize";
      const tilt = scene.panTilt ? fixtureTilts(f.truss)[f.fixture] : 0;
      showTooltip(`<b>T${f.truss + 1} · fixture ${f.fixture + 1}</b> · ${at.toFixed(2)} m${tilt ? ` · tilt ${Math.round(tilt)}°` : ""}${locked ? " · locked" : ""}<br>` +
        (locked ? "Click to unlock" : "Click to lock · drag to move"), px, py);
      return;
    }
    canvas.style.cursor = scene.panTilt && tool === "aim" ? "default" : trussCursor(hitTruss(wx, wy));
    if (wx < 0 || wy < 0 || wx > scene.width || wy > scene.depth) { tooltip.hidden = true; return; }
    const lux = Photometry.illuminanceAt(result.placed, [wx, wy, 0]);
    showTooltip(`<b>${Math.round(lux)} lx</b><br>x ${wx.toFixed(2)} m · y ${wy.toFixed(2)} m`, px, py);
  });

  const endDrag = () => { if (drag) { drag = null; canvas.style.cursor = ""; update(); } };
  canvas.addEventListener("pointerup", () => {
    if (drag && drag.kind === "fixture" && !drag.moved && !(scene.panTilt && tool === "aim")) {
      const t = scene.trusses[drag.index];
      t.locks = Photometry.fixtureLocks(t);
      t.locks[drag.fixture] = !t.locks[drag.fixture];
      refreshPositions(drag.index);
      tooltip.hidden = true;
    }
    endDrag();
  });
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("dblclick", (e) => {
    if (!scene.panTilt || tool !== "aim") return;
    const [px, py] = eventPos(e);
    const f = hitFixture(px, py);
    if (!f) return;
    const t = scene.trusses[f.truss];
    t.aims = Photometry.fixtureAims(t);
    t.aims[f.fixture] = null;
    refreshPositions(f.truss);
    update();
  });
  canvas.addEventListener("pointerleave", () => { tooltip.hidden = true; if (hover) { hover = null; draw(); } });

  window.addEventListener("resize", draw);

  // ---------- init ----------

  // Auto-load the project's floor plan; silently skipped if the file isn't there.
  const defaultPlan = new Image();
  defaultPlan.onload = () => { if (!floorplan) { floorplan = defaultPlan; draw(); } };
  defaultPlan.src = DEFAULT_FLOORPLAN;

  renderLibrary();
  syncRoomInputs();
  renderTrussList();
  syncPanTiltUi();
  update();

  // First visit in this browser: use the live defaults.json, which may be newer than defaults.js.
  if (firstVisit) fetchDefaults().then((setup) => { if (setup) applySetup(setup); });
})();
