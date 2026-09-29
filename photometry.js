// Point-by-point illuminance from Type C photometric data (inverse-square + cosine law).
//
// World frame: x to the right, y down the plan (as drawn on screen), z up. Metres.
// A fixture's gamma 0 points along its aim axis; C0 lies along its truss.

(function () {
  // Index i and fraction t such that value lies between arr[i] and arr[i+1].
  function locate(arr, value) {
    const n = arr.length;
    if (value <= arr[0]) return [0, 0];
    if (value >= arr[n - 1]) return [n - 2, 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= value) lo = mid; else hi = mid;
    }
    return [lo, (value - arr[lo]) / (arr[hi] - arr[lo])];
  }

  // Candela at (C, gamma) in degrees, bilinear between measured planes.
  function intensity(fx, cDeg, gammaDeg) {
    if (gammaDeg > fx.gammas[fx.gammas.length - 1]) return 0;
    let c = cDeg % 360;
    if (c < 0) c += 360;
    const [ci, ct] = locate(fx.cPlanes, c);
    const [gi, gt] = locate(fx.gammas, gammaDeg);
    const a = fx.candela[ci], b = fx.candela[ci + 1];
    const ia = a[gi] + (a[gi + 1] - a[gi]) * gt;
    const ib = b[gi] + (b[gi + 1] - b[gi]) * gt;
    return ia + (ib - ia) * ct;
  }

  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

  // Fixtures spread evenly along a truss: offsets (m) from the truss start, at segment centres.
  function evenPositions(length, count) {
    return Array.from({ length: count }, (_, i) => +(((i + 0.5) * length) / count).toFixed(2));
  }

  // A truss's fixture offsets from its start, falling back to an even spread
  // when none are stored (or they don't match the fixture count).
  function fixturePositions(t) {
    if (Array.isArray(t.positions) && t.positions.length === t.count) {
      return t.positions.map((p) => Math.max(0, Math.min(t.length, p)));
    }
    return evenPositions(t.length, t.count);
  }

  // Per-fixture lock flags for a truss, always `count` long.
  function fixtureLocks(t) {
    return Array.from({ length: t.count }, (_, i) => !!(t.locks && t.locks[i]));
  }

  // Even spread that keeps locked fixtures in place. The free fixtures are shared out over the
  // gaps between locked ones (and the truss ends) so spacing is as uniform as possible: a gap
  // between two locked fixtures holding k free ones has spacing gap/(k+1); a gap at a truss end
  // uses half a spacing to the end, like evenPositions, so gap/(k+0.5). Free fixtures go one by
  // one to whichever gap currently has the widest spacing.
  function spreadPositions(length, positions, locks) {
    const count = positions.length;
    const anchors = positions.filter((_, i) => locks[i]).sort((a, b) => a - b);
    const free = count - anchors.length;
    if (!anchors.length) return evenPositions(length, count);

    const edges = [0, ...anchors, length];
    const gaps = edges.slice(1).map((b, g) => ({
      from: edges[g], to: b, k: 0,
      startEnd: g === 0, stopEnd: g === edges.length - 2,
    }));
    const spacing = (gap) => {
      const ends = (gap.startEnd ? 0.5 : 0) + (gap.stopEnd ? 0.5 : 0);
      return (gap.to - gap.from) / (gap.k + 1 - ends || 0.5);
    };
    for (let n = 0; n < free; n++) {
      gaps.reduce((best, g) => (spacing(g) > spacing(best) ? g : best)).k++;
    }

    const placed = [];
    for (const gap of gaps) {
      if (!gap.k) continue;
      const s = spacing(gap);
      const first = gap.startEnd ? gap.to - gap.k * s : gap.from + s;
      for (let j = 0; j < gap.k; j++) placed.push(+(first + j * s).toFixed(2));
    }

    // Locked fixtures keep their slot; free ones take the new positions in their existing order.
    const freeIdx = positions.map((p, i) => [p, i]).filter(([, i]) => !locks[i]).sort((a, b) => a[0] - b[0]);
    const out = positions.slice();
    freeIdx.forEach(([, i], j) => { out[i] = placed[j]; });
    return out;
  }

  // Expands a scene into a flat list of placed fixtures, all aimed straight down.
  // scene: { orientation: "x"|"y", fixtureDrop, trusses: [{ cx, cy, height, length, count,
  //          positions, fixtureId, dimmer }] }
  function placeFixtures(scene, library) {
    const out = [];
    const along = scene.orientation === "y" ? [0, 1, 0] : [1, 0, 0];
    const axis = [0, 0, -1];
    const u = along;
    const v = cross(axis, u);
    for (const [ti, t] of scene.trusses.entries()) {
      const fx = library.find((f) => f.id === t.fixtureId);
      if (!fx || t.count < 1) continue;
      const z = t.height - scene.fixtureDrop;
      const positions = fixturePositions(t);
      const locks = fixtureLocks(t);
      for (let i = 0; i < t.count; i++) {
        const s = -t.length / 2 + positions[i];
        out.push({
          truss: ti,
          index: i,
          locked: locks[i],
          fx,
          pos: [t.cx + along[0] * s, t.cy + along[1] * s, z],
          axis, u, v,
          scale: t.dimmer / 100,
        });
      }
    }
    return out;
  }

  // Horizontal illuminance (lux) at point p = [x, y, z].
  function illuminanceAt(placed, p) {
    let e = 0;
    for (const f of placed) {
      const d = [p[0] - f.pos[0], p[1] - f.pos[1], p[2] - f.pos[2]];
      const height = -d[2];
      if (height <= 0) continue;
      const r2 = dot(d, d);
      const r = Math.sqrt(r2);
      const cosG = dot(d, f.axis) / r;
      const gamma = (Math.acos(Math.max(-1, Math.min(1, cosG))) * 180) / Math.PI;
      const c = (Math.atan2(dot(d, f.v), dot(d, f.u)) * 180) / Math.PI;
      e += (f.scale * intensity(f.fx, c, gamma) * height) / (r2 * r);
    }
    return e;
  }

  // Splits [0, total] into cells of `size`; the last cell is clipped at the wall.
  function cellEdges(total, size) {
    const edges = [0];
    while (edges[edges.length - 1] < total - 1e-9) edges.push(Math.min(total, edges[edges.length - 1] + size));
    return edges;
  }

  // Illuminance on the floor at the centre of each grid cell (1 m by default).
  // Averages are weighted by cell area so clipped edge cells count proportionally.
  function computeGrid(scene, library, cellSize = 1) {
    const placed = placeFixtures(scene, library);
    const xs = cellEdges(scene.width, cellSize);
    const ys = cellEdges(scene.depth, cellSize);
    const nx = xs.length - 1, ny = ys.length - 1;
    const values = new Float32Array(nx * ny);
    let min = Infinity, max = 0, sum = 0, area = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
        const e = illuminanceAt(placed, [cx, cy, 0]);
        const a = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
        values[j * nx + i] = e;
        if (e < min) min = e;
        if (e > max) max = e;
        sum += e * a;
        area += a;
      }
    }
    return { nx, ny, xs, ys, values, min, max, avg: sum / area, placed };
  }

  // Total luminous flux (lm) by integrating the candela table over the sphere — used as a sanity check.
  function integrateFlux(fx) {
    let flux = 0;
    const steps = 360;
    for (let k = 0; k < steps; k++) {
      const c = (k + 0.5) * (360 / steps);
      for (let g = 0; g < fx.gammas.length - 1; g++) {
        const g0 = (fx.gammas[g] * Math.PI) / 180, g1 = (fx.gammas[g + 1] * Math.PI) / 180;
        const gm = (fx.gammas[g] + fx.gammas[g + 1]) / 2;
        const solid = (Math.cos(g0) - Math.cos(g1)) * ((2 * Math.PI) / steps);
        flux += intensity(fx, c, gm) * solid;
      }
    }
    return flux;
  }

  const api = { intensity, evenPositions, fixturePositions, fixtureLocks, spreadPositions, placeFixtures, illuminanceAt, computeGrid, integrateFlux };
  if (typeof module !== "undefined") module.exports = api;
  else window.Photometry = api;
})();
