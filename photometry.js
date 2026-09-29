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

  // Floor points 0.5 m apart over the area the rig spans: along = union of truss extents,
  // across = between the outermost truss centrelines (a single truss gets a 1 m band), clamped
  // to the room.
  function rigSamples(scene) {
    const alongX = scene.orientation !== "y";
    const used = scene.trusses.filter((t) => t.length > 0);
    if (!used.length) return [];
    const alongMax = alongX ? scene.width : scene.depth, acrossMax = alongX ? scene.depth : scene.width;
    const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
    let a0 = Math.min(...used.map((t) => (alongX ? t.cx : t.cy) - t.length / 2));
    let a1 = Math.max(...used.map((t) => (alongX ? t.cx : t.cy) + t.length / 2));
    let c0 = Math.min(...used.map((t) => (alongX ? t.cy : t.cx)));
    let c1 = Math.max(...used.map((t) => (alongX ? t.cy : t.cx)));
    if (c1 - c0 < 1) { c0 -= 0.5; c1 += 0.5; }
    [a0, a1, c0, c1] = [clamp(a0, alongMax), clamp(a1, alongMax), clamp(c0, acrossMax), clamp(c1, acrossMax)];

    const STEP = 0.5;
    const samples = [];
    const na = Math.max(1, Math.round((a1 - a0) / STEP)), nc = Math.max(1, Math.round((c1 - c0) / STEP));
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < nc; j++) {
        const a = a0 + ((i + 0.5) * (a1 - a0)) / na, c = c0 + ((j + 0.5) * (c1 - c0)) / nc;
        samples.push(alongX ? [a, c, 0] : [c, a, 0]);
      }
    }
    return samples;
  }

  // Average and lowest lux over the rig area (see rigSamples).
  function rigStats(scene, library) {
    const placed = placeFixtures(scene, library);
    const samples = rigSamples(scene);
    if (!samples.length) return { mean: 0, min: 0, u0: 0 };
    let sum = 0, min = Infinity;
    for (const p of samples) { const e = illuminanceAt(placed, p); sum += e; if (e < min) min = e; }
    const mean = sum / samples.length;
    return { mean, min, u0: mean > 0 ? min / mean : 0 };
  }

  // Decides how many fixtures each truss needs, and where, for an average of `target` lux over
  // the rig area. Trusses, fixture types, dimmers and locked fixtures are kept; unlocked fixtures
  // are removed and rebuilt. Fixtures are added one at a time to whichever truss gives the most
  // even light after optimiseCoverage re-arranges them (symmetric, respecting minSpacing), until
  // the average reaches the target or every truss is full at the minimum spacing. Adding one at a
  // time can leave the trusses lopsided, so a final pass tries moving single unlocked fixtures
  // between trusses (same total) and keeps any move that evens the light and still meets target.
  //
  // Returns { trusses: [{ count, positions, locks }], stats: {mean, min, u0}, reached, added }.
  function designForTarget(scene, library, target) {
    const sc = { ...scene, trusses: scene.trusses.map((t) => {
      const pos = fixturePositions(t), locks = fixtureLocks(t);
      const keep = pos.map((p, i) => i).filter((i) => locks[i]);
      return { ...t, count: keep.length, positions: keep.map((i) => pos[i]), locks: keep.map(() => true) };
    }) };
    const spacing = Math.max(0, scene.minSpacing ?? 0);
    const capacity = (t) => (spacing > 0 ? Math.floor(t.length / spacing + 1e-9) + 1 : 50);
    const usable = (t) => library.some((f) => f.id === t.fixtureId);

    // A copy of sc with truss ti changed by delta unlocked fixtures, re-arranged by optimiseCoverage.
    const withCount = (base, changes) => {
      const trial = { ...base, trusses: base.trusses.map((u, j) => {
        const delta = changes[j] || 0;
        if (!delta) return u;
        let pos = fixturePositions(u), locks = fixtureLocks(u);
        if (delta > 0) {
          pos = [...pos, ...Array(delta).fill(u.length / 2)];
          locks = [...locks, ...Array(delta).fill(false)];
        } else {
          for (let r = -delta; r > 0; r--) {
            const k = locks.lastIndexOf(false);
            if (k < 0) return null;
            pos = pos.filter((_, i) => i !== k); locks = locks.filter((_, i) => i !== k);
          }
        }
        return { ...u, count: pos.length, positions: pos, locks };
      }) };
      if (trial.trusses.some((u) => u === null)) return null;
      const r = optimiseCoverage(trial, library);
      if (r) trial.trusses = trial.trusses.map((u, j) => ({ ...u, positions: r.positions[j] }));
      return { scene: trial, stats: rigStats(trial, library) };
    };

    let stats = rigStats(sc, library);
    let added = 0;
    while (stats.mean < target) {
      let best = null;
      sc.trusses.forEach((t, ti) => {
        if (!usable(t) || t.count >= capacity(t)) return;
        const cand = withCount(sc, { [ti]: 1 });
        // Most even light wins; a clearly higher average breaks ties.
        if (cand && (!best || cand.stats.u0 > best.stats.u0 + 1e-6 ||
            (Math.abs(cand.stats.u0 - best.stats.u0) <= 1e-6 && cand.stats.mean > best.stats.mean))) {
          best = cand;
        }
      });
      if (!best) break;
      sc.trusses = best.scene.trusses;
      stats = best.stats;
      added++;
    }

    // Rebalance: move one unlocked fixture from truss a to truss b while that evens the light out.
    for (let round = 0, improved = true; improved && round < 20; round++) {
      improved = false;
      for (let a = 0; a < sc.trusses.length && !improved; a++) {
        if (!fixtureLocks(sc.trusses[a]).includes(false)) continue;
        for (let b = 0; b < sc.trusses.length && !improved; b++) {
          const tb = sc.trusses[b];
          if (a === b || !usable(tb) || tb.count >= capacity(tb)) continue;
          const cand = withCount(sc, { [a]: -1, [b]: 1 });
          if (cand && cand.stats.mean >= Math.min(target, stats.mean) && cand.stats.u0 > stats.u0 + 1e-3) {
            sc.trusses = cand.scene.trusses;
            stats = cand.stats;
            improved = true;
          }
        }
      }
    }
    return {
      trusses: sc.trusses.map((t) => ({ count: t.count, positions: fixturePositions(t), locks: fixtureLocks(t) })),
      stats,
      reached: stats.mean >= target,
      added,
    };
  }

  // Moves unlocked fixtures along their trusses to make the light as even as possible over the
  // area the rig spans (between the outermost trusses, along the full truss extent), keeping each
  // truss's layout symmetric about its centre. Locked fixtures, dimmers and truss positions are
  // left alone.
  //
  // Symmetry, per truss: a locked fixture with no locked twin at its mirror position gets a free
  // fixture placed there; the remaining free fixtures form mirrored pairs at centre ± d, plus one
  // at the centre if their number is odd. If there aren't enough free fixtures to twin every
  // unmatched locked one, or the odd one's centre spot is already taken by a locked fixture (it
  // then moves on its own), that truss can't be symmetric and is reported in `asymmetric`.
  //
  // Spacing: no two fixtures on a truss (locked ones included) may end up closer than
  // scene.minSpacing. It's a hard rule: a move is accepted if it reduces spacing violations, or
  // keeps them at zero and improves evenness. So a start that breaks the rule is repaired first.
  // Trusses where the fixtures can't fit that far apart are reported in `crowded`.
  //
  // Evenness is scored on a 0.5 m sample grid as the coefficient of variation (std/mean) minus a
  // small reward for the min/avg ratio. The search is coordinate descent over the pair offsets d:
  // each tries steps either way, shrinking from 2 m to 5 cm, keeping any move that lowers the
  // score. It runs from the current layout and from an even spread, and keeps the better result.
  // Each pair's contribution at every sample is cached, so a trial move only recomputes one pair.
  //
  // Returns { positions: [[...] per truss], before: {cv, u0}, after: {cv, u0}, moved,
  // asymmetric: [truss indices], crowded: [truss indices] } or null when there is nothing free.
  function optimiseCoverage(scene, library) {
    const placed = placeFixtures(scene, library);
    const free = placed.map((_, k) => k).filter((k) => !placed[k].locked);
    if (!free.length) return null;

    const alongX = scene.orientation !== "y";
    const ax = alongX ? 0 : 1; // index of the along-truss coordinate
    const samples = rigSamples(scene);
    const n = samples.length;

    const trussStart = (f) => {
      const t = scene.trusses[f.truss];
      return (alongX ? t.cx : t.cy) - t.length / 2;
    };
    const at = (f, s) => {
      const pos = f.pos.slice();
      pos[ax] = trussStart(f) + s;
      return { ...f, pos };
    };
    const contribution = (f) => {
      const out = new Float64Array(n);
      for (let k = 0; k < n; k++) out[k] = illuminanceAt([f], samples[k]);
      return out;
    };
    const score = (total) => {
      let sum = 0, min = Infinity;
      for (let k = 0; k < n; k++) { sum += total[k]; if (total[k] < min) min = total[k]; }
      const mean = sum / n;
      if (mean <= 0) return { cost: Infinity, cv: 0, u0: 0 };
      let v = 0;
      for (let k = 0; k < n; k++) v += (total[k] - mean) ** 2;
      const cv = Math.sqrt(v / n) / mean, u0 = min / mean;
      return { cost: cv - 0.5 * u0, cv, u0 };
    };

    // Locked fixtures never move, so their light is a constant background.
    const constTotal = new Float64Array(n);
    for (const f of placed) {
      if (!f.locked) continue;
      const c = contribution(f);
      for (let k = 0; k < n; k++) constTotal[k] += c[k];
    }

    // Per-truss symmetric plan: fixed target positions plus mirrored pair variables.
    const plans = [];
    const asymmetric = [];
    scene.trusses.forEach((t, ti) => {
      const members = placed.filter((f) => f.truss === ti);
      const freeF = members.filter((f) => !f.locked);
      if (!freeF.length) return;
      const L = t.length, mid = L / 2, TOL = 0.01;
      const lockedPos = members.filter((f) => f.locked).map((f) => f.pos[ax] - trussStart(f));
      const matched = lockedPos.map(() => false);
      const unmatched = []; // mirror positions a free fixture should take
      lockedPos.forEach((p, i) => {
        if (matched[i]) return;
        matched[i] = true;
        if (Math.abs(p - mid) < TOL) return;
        const j = lockedPos.findIndex((q, k) => !matched[k] && Math.abs(q - (L - p)) < TOL);
        if (j >= 0) matched[j] = true; else unmatched.push(L - p);
      });
      if (unmatched.length > freeF.length) asymmetric.push(ti);
      const fixed = unmatched.slice(0, freeF.length);
      const rest = freeF.length - fixed.length;
      const centreTaken = lockedPos.some((p) => Math.abs(p - mid) < TOL);
      const centre = rest % 2 === 1 && !centreTaken;
      const singles = rest % 2 === 1 && centreTaken ? 1 : 0;
      if (centre) fixed.push(mid);
      if (singles) asymmetric.push(ti);
      plans.push({ ti, L, mid, freeF, fixed, centre, lockedPos, pairs: Math.floor(rest / 2), singles, template: freeF[0], varIdx: [] });
    });

    const slot = (plan, pos) => contribution(at(plan.template, pos));
    for (const plan of plans) {
      for (const p of plan.fixed) { const c = slot(plan, p); for (let k = 0; k < n; k++) constTotal[k] += c[k]; }
    }
    const vars = plans.flatMap((plan) => [
      ...Array.from({ length: plan.pairs }, () => ({ plan, pair: true })),
      ...Array.from({ length: plan.singles }, () => ({ plan, pair: false })),
    ]);
    vars.forEach((v, i) => v.plan.varIdx.push(i));
    const varPositions = (v, val) => (v.pair ? [v.plan.mid - val, v.plan.mid + val] : [val]);
    const varMax = (v) => (v.pair ? v.plan.mid : v.plan.L);

    // How far a truss's layout falls short of the minimum spacing (0 when every gap is wide enough).
    const SPACING = Math.max(0, scene.minSpacing ?? 0);
    const violation = (plan, d) => {
      const all = [...plan.lockedPos, ...plan.fixed];
      for (const i of plan.varIdx) all.push(...varPositions(vars[i], d[i]));
      all.sort((p, q) => p - q);
      let v = 0;
      for (let k = 1; k < all.length; k++) v += Math.max(0, SPACING - (all[k] - all[k - 1]) - 1e-6);
      return v;
    };
    const totalViolation = (d) => plans.reduce((sum, plan) => sum + violation(plan, d), 0);
    const varContribution = (v, val) => {
      const out = new Float64Array(n);
      for (const p of varPositions(v, val)) { const c = slot(v.plan, p); for (let k = 0; k < n; k++) out[k] += c[k]; }
      return out;
    };

    function descend(startD) {
      const d = startD.slice();
      const contrib = vars.map((v, i) => varContribution(v, d[i]));
      const total = Float64Array.from(constTotal);
      for (const c of contrib) for (let k = 0; k < n; k++) total[k] += c[k];
      let best = score(total);
      let viol = totalViolation(d);
      for (const step of [2, 1, 0.5, 0.25, 0.1, 0.05]) {
        for (let pass = 0, improved = true; improved && pass < 40; pass++) {
          improved = false;
          vars.forEach((v, i) => {
            const plan = v.plan;
            for (const delta of [-step, step]) {
              const nd = Math.max(0, Math.min(varMax(v), d[i] + delta));
              if (nd === d[i]) continue;
              const old = d[i];
              const oldPlanViol = violation(plan, d);
              d[i] = nd;
              const newViol = viol - oldPlanViol + violation(plan, d);
              d[i] = old;
              if (newViol > viol + 1e-9) continue; // never trade spacing for evenness
              const nc = varContribution(v, nd);
              for (let q = 0; q < n; q++) total[q] += nc[q] - contrib[i][q];
              const trial = score(total);
              if (newViol < viol - 1e-9 || trial.cost < best.cost - 1e-9) {
                best = trial; d[i] = nd; contrib[i] = nc; viol = newViol; improved = true;
              } else {
                for (let q = 0; q < n; q++) total[q] -= nc[q] - contrib[i][q];
              }
            }
          });
        }
      }
      return { d, best, viol };
    }

    const startScore = (() => {
      const total = new Float64Array(n);
      for (const f of placed) { const c = contribution(f); for (let k = 0; k < n; k++) total[k] += c[k]; }
      return score(total);
    })();

    // Start 1: pair up the current free fixtures by their distance from the truss centre.
    // Start 2: the pairs (and centre fixture) spread evenly over the truss.
    const snap = (v) => Math.round(v * 20) / 20;
    const currentD = [], evenD = [];
    for (const plan of plans) {
      const dist = plan.freeF.map((f) => Math.abs(f.pos[ax] - trussStart(f) - plan.mid)).sort((p, q) => q - p);
      const count = 2 * plan.pairs + (plan.centre ? 1 : 0);
      for (let k = 0; k < plan.pairs; k++) {
        currentD.push(snap(Math.min(plan.mid, (dist[2 * k] + dist[2 * k + 1]) / 2)));
        evenD.push(snap(plan.mid - ((k + 0.5) * plan.L) / count));
      }
      // A lone fixture starts a quarter of the way along, clear of the locked centre fixture.
      for (let k = 0; k < plan.singles; k++) { currentD.push(snap(plan.L / 4)); evenD.push(snap(plan.L / 4)); }
    }
    const fromCurrent = descend(currentD);
    const fromEven = descend(evenD);
    const better = (p, q) => p.viol < q.viol - 1e-9 || (Math.abs(p.viol - q.viol) <= 1e-9 && p.best.cost < q.best.cost);
    const result = better(fromEven, fromCurrent) ? fromEven : fromCurrent;
    const crowded = plans.filter((plan) => violation(plan, result.d) > 1e-6).map((plan) => plan.ti);

    // Target positions per truss; free fixtures take them in their current order along the truss.
    const positions = scene.trusses.map((t) => fixturePositions(t).slice());
    let moved = 0;
    for (const plan of plans) {
      const targets = [...plan.fixed];
      for (const i of plan.varIdx) targets.push(...varPositions(vars[i], result.d[i])); // on the 5 cm grid
      targets.sort((p, q) => p - q);
      const order = plan.freeF.slice().sort((f, g) => f.pos[ax] - g.pos[ax]);
      order.forEach((f, k) => {
        const v = +targets[k].toFixed(2);
        if (Math.abs(positions[plan.ti][f.index] - v) > 1e-9) moved++;
        positions[plan.ti][f.index] = v;
      });
    }
    return {
      positions,
      before: { cv: startScore.cv, u0: startScore.u0 },
      after: { cv: result.best.cv, u0: result.best.u0 },
      moved,
      asymmetric,
      crowded,
    };
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

  const api = { intensity, evenPositions, fixturePositions, fixtureLocks, spreadPositions, optimiseCoverage, rigStats, designForTarget, placeFixtures, illuminanceAt, computeGrid, integrateFlux };
  if (typeof module !== "undefined") module.exports = api;
  else window.Photometry = api;
})();
