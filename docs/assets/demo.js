// The live demo: the shipped calibrations (data/machines.js), the model (aneto.js), the charts (plot.js).
import "./copy.js";
import data from "../data/machines.js";
import { fit, predict, crossValidate, cpiErrors, percentile, isoCpi, predictOn, KNEE, LINE, nsAtKnee, supplyCurve } from "./aneto.js";
import { Chart, linear, log, el, fmt, tick, bfColor, roundUp } from "./plot.js";

const $ = s => document.querySelector(s);
const TECHS = data.technologies;  // the paper's target memories: name and unloaded latency (ns)
const PEAK = 100;                 // GB/s, default peak bandwidth of both supply curves (illustrative)
const BW = [0.05, 200];           // GB/s, the bandwidth axis of panel 3, as on the home page
const OWN = "__own";

const S = {
  p: Math.max(0, data.machines.findIndex(p => p.label === "Zen 5")),
  wl: "gms-tc-pokec",
  ns: 250,
  calib: "loo", ncal: 16, seed: 1,
  copies: 1, peakA: PEAK, peakB: PEAK,
  own: null,
};

const plat = () => data.machines[S.p];
const techOf = ns => TECHS.find(t => t.ns === ns);
const pct = v => `${fmt(100 * v)}%`;
const signed = v => `${v >= 0 ? "+" : "\u2212"}${Math.round(Math.abs(100 * v))}%`;  // whole percent

// Seeded shuffle, so a drawn calibration set stays put until the visitor draws another
function mulberry(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function calibSet(pi) {
  if (S.calib !== "small") return null;
  const names = data.machines[pi].workloads.map(w => w.n), rnd = mulberry(S.seed * 7919 + pi);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return new Set(names.slice(0, S.ncal));
}

// Leave-one-out predictions of every workload of a machine, cached per calibration choice
const cache = new Map();
function loo(pi) {
  const key = `${pi}|${S.calib}|${S.ncal}|${S.seed}`;
  if (!cache.has(key)) cache.set(key, crossValidate(data.machines[pi].workloads, calibSet(pi)));
  return cache.get(key);
}
function errorsAt(pi, ns) {
  const p = data.machines[pi], e = cpiErrors(p.workloads, loo(pi), ns / p.unloaded_ns);
  return { p50: percentile(e, 50), p90: percentile(e, 90) };
}

function selected() {
  const W = plat().workloads;
  return S.wl === OWN && S.own ? S.own : W.find(w => w.n === S.wl) || W[0];
}

// Everything the panels show for the selected workload
function compute() {
  const P = plat(), w = selected(), drawn = calibSet(S.p);
  const others = P.workloads.filter(v => v.g !== w.g);
  // A small draw can leave fewer than 3 workloads outside this benchmark: then fit on all the others
  const small = drawn && fit(others.filter(v => drawn.has(v.n)));
  const cal = small ? drawn : null, model = small || fit(others), fallback = !!drawn && !small;
  const pr = predict(model, w);
  const Lref = w.mp / w.ghz, factor = S.ns / P.unloaded_ns;
  const today = { ns: P.unloaded_ns, peak: S.peakA }, target = { ns: S.ns, peak: S.peakB };
  // The prediction on today's memory and on the target, from a BF and CPI0
  const side = est => {
    const a = predictOn(w, est, today, P.unloaded_ns, S.copies), b = predictOn(w, est, target, P.unloaded_ns, S.copies);
    return { ...est, dem: b.dem, a, b, supA: a.sup, supB: b.sup, cpiB: b.cpi, growth: b.cpi / w.cpi - 1 };
  };
  const an = side(pr);
  const ref = w.own ? null : side({ bf: w.bf, cpi0: w.cpi0 });
  return { P, w, cal, fallback, model, Lref, factor, supA: an.supA, supB: an.supB, an, ref, own: !!w.own };
}

const tip = document.createElement("div");
tip.className = "tip";
document.body.appendChild(tip);
function showTip(ev, html) {
  tip.innerHTML = html;
  tip.style.display = "block";
  tip.style.left = `${Math.min(ev.clientX + 14, innerWidth - 290)}px`;
  tip.style.top = `${ev.clientY + 14}px`;
}
const hideTip = () => { tip.style.display = "none"; };

// Panel 1: the plot of CPI against MPI x MP, coloured by the BF of the sweep
function drawKey(c) {
  const W = c.P.workloads, all = c.own ? [...W, c.w] : W;
  const xs = all.map(w => w.mpi * w.mp), ys = all.map(w => w.cpi);
  const x = log([Math.min(...xs) / 1.6, Math.max(...xs) * 1.6], [cKey.x0, cKey.x1]);
  const y = log([Math.min(...ys) / 1.25, Math.max(...ys) * 1.25], [cKey.y0, cKey.y1]);
  const mpimp = "<tspan font-style='italic'>MPI</tspan> \u00d7 <tspan font-style='italic'>MP</tspan>";
  cKey.scales(x, y).frame({ xlabel: narrow ? `${mpimp} (cycles)` : `${mpimp}, the maximum memory stall per instruction (cycles)`, ylabel: "<tspan font-style='italic'>CPI</tspan>" });
  cKey.clear();
  const lbf = W.map(w => Math.log10(w.bf));
  const lo = percentile(lbf, 2), hi = percentile(lbf, 98);
  const bmin = Math.min(...W.map(w => w.bf)), bmax = Math.max(...W.map(w => w.bf)), placed = [];
  for (const b of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5].filter(b => b > bmin && b < bmax)) {
    const pts = [];
    for (let i = 0; i <= 90; i++) {
      const xv = x.domain[0] * (x.domain[1] / x.domain[0]) ** (i / 90), cv = isoCpi(c.model, b, xv);
      if (cv) pts.push([xv, cv]);
    }
    cKey.line(pts, { stroke: "var(--rule)", "stroke-width": 1.3 });
    const inside = pts.filter(([a, v]) => v > y.domain[0] && v < y.domain[1] && a < x.domain[1]);
    if (inside.length > 5) {
      const [a, v] = inside[inside.length - 1];
      if (placed.every(([px, py]) => Math.hypot(px - x(a), py - y(v)) > 46)) {
        placed.push([x(a), y(v)]);
        cKey.text(a, v, `BF ${tick(100 * b)}%`, { class: "note", "font-size": 12, fill: "var(--muted)", "text-anchor": "end", dy: -5 });
      }
    }
  }
  const preds = loo(S.p);
  for (const w of W) {
    const d = cKey.dot(w.mpi * w.mp, w.cpi, 5.5, {
      fill: bfColor((Math.log10(w.bf) - lo) / (hi - lo)), class: "dotwl",
      stroke: c.cal && c.cal.has(w.n) ? "var(--fg)" : "#fff", "stroke-width": c.cal && c.cal.has(w.n) ? 1.8 : 0.8,
    });
    const q = preds.get(w.n);
    d.addEventListener("mousemove", ev => showTip(ev, `<b>${w.n}</b> (${w.s})<br>BF from the ground-truth fit ${pct(w.bf)}` +
      (q ? `<br>BF from a single run (Aneto) ${pct(q.bf)}` : "") + (c.cal && c.cal.has(w.n) ? "<br>in the calibration set" : "")));
    d.addEventListener("mouseleave", hideTip);
    d.addEventListener("click", () => { S.wl = w.n; render(); });
  }
  const sx = c.w.mpi * c.w.mp, sy = c.w.cpi;
  if (c.own) {
    const px = x(sx), py = y(sy);
    el("path", { d: `M${px},${py - 9}L${px + 9},${py}L${px},${py + 9}L${px - 9},${py}Z`, fill: "#fff", stroke: "var(--accent)", "stroke-width": 2.5 }, cKey.top);
  } else {
    cKey.dot(sx, sy, 11, { fill: "none", stroke: "var(--accent)", "stroke-width": 2.5 }, cKey.top);
  }
  const right = x(sx) > (cKey.x0 + cKey.x1) / 2;
  cKey.text(sx, sy, c.w.n, { class: "note", fill: "var(--accent)", "font-weight": 700, "text-anchor": right ? "end" : "start", dx: right ? -16 : 16, dy: -10 });
}

// Panel 2: CPI against the miss latency, the line from one run and the line from the sweep
function drawLine(c) {
  const w = c.w, k = w.mpi * w.ghz;  // CPI per ns of miss latency, per unit BF
  const pts = w.pts.map(([xx, cpi]) => [xx / k, cpi]);
  const meas = [...pts.map(p => p[0]), c.Lref];
  const xmax = Math.max(c.an.b.L, c.ref ? c.ref.b.L : 0, ...meas) * 1.12;
  const at = (s, L) => s.cpi0 + s.bf * k * L;
  const ymax = Math.max(at(c.an, xmax), c.ref ? at(c.ref, xmax) : 0, w.cpi, ...pts.map(p => p[1])) * 1.1;
  cLine.scales(linear([0, xmax], [cLine.x0, cLine.x1]), linear([0, ymax], [cLine.y0, cLine.y1]))
    .frame({ xlabel: "Memory latency (ns)", ylabel: "<tspan font-style='italic'>CPI</tspan>" });
  cLine.clear();
  const tgt = c.an.b.L;
  cLine.line([[tgt, 0], [tgt, ymax]], { stroke: "var(--fg)", "stroke-width": 1, "stroke-dasharray": "3 4" });
  const tech = techOf(S.ns);
  cLine.text(tgt, ymax, tech ? tech.name : `${fmt(S.ns)} ns`, { class: "note", "text-anchor": "end", dx: -6, dy: 16, fill: "var(--fg)" });
  if (c.ref) {
    const lo = Math.min(...meas), hi = Math.max(...meas);
    cLine.line([[0, at(c.ref, 0)], [xmax, at(c.ref, xmax)]], { stroke: "var(--ref)", "stroke-width": 2, "stroke-dasharray": "6 5" });
    cLine.line([[lo, at(c.ref, lo)], [hi, at(c.ref, hi)]], { stroke: "var(--ref)", "stroke-width": 3 });
    for (const [a, b] of pts) cLine.dot(a, b, 4.5, { fill: "#fff", stroke: "var(--ref)", "stroke-width": 1.8 });
  }
  cLine.line([[0, at(c.an, 0)], [xmax, at(c.an, xmax)]], { stroke: "var(--accent)", "stroke-width": 3 });
  cLine.dot(c.Lref, w.cpi, 5.5, { fill: "var(--fg)" });
  cLine.text(c.Lref, w.cpi, "the single run", { class: "note", fill: "var(--fg)", dx: 9, dy: 18 });
  if (c.ref) {
    cLine.dot(c.ref.b.L, c.ref.cpiB, 6, { fill: "var(--ref)" }, cLine.top);
    cLine.text(c.ref.b.L, c.ref.cpiB, signed(c.ref.growth), { class: "note", fill: "var(--muted)", "text-anchor": "end", dx: -10, dy: c.ref.cpiB > c.an.cpiB ? -6 : 16 });
  }
  cLine.dot(tgt, c.an.cpiB, 6.5, { fill: "#fff", stroke: "var(--accent)", "stroke-width": 2.5 }, cLine.top);
  cLine.text(tgt, c.an.cpiB, signed(c.an.growth), { class: "note", fill: "var(--accent)", "font-weight": 700, "text-anchor": "end", dx: -10, dy: c.ref && c.ref.cpiB > c.an.cpiB ? 18 : -8 });
  const hw = c.P.kind === "hardware";
  $("#cap-line").innerHTML = c.own
    ? "Your run has no sweep, so the plot shows only the Aneto line. It starts at <i>CPI</i><sub>0</sub>, and its slope is the BF."
    : `Each line starts at its <i>CPI</i><sub>0</sub>, and its slope is the BF. ` +
      (hw ? `The frequency sweep changes the miss penalty in cycles. The plot places each operating point at the memory latency that gives the same miss penalty at ${fmt(w.ghz)} GHz, the clock of the run. `
          : "The simulator sweeps the memory latency. ") +
      "The solid gray segment spans the sweep. The dashed part extrapolates the ground-truth fit, as in the paper.";
}

// Panel 3: supply curves of today's and the target memory, demand curves from the two BFs
let drag = null, axes = null, grown = -Infinity;   // grown: time of the last step out of an axis during a drag
// As on the home page: bandwidth on a log axis, so the demand of one copy shows next to the peak, and
// latency on a linear axis from 0. The latency axis ends above the run, the handles and the operating
// points; a point at the wall is left out, since the peak bandwidth sets its CPI.
function axesFor(c) {
  const ops = [c.an.a, c.an.b, ...(c.ref ? [c.ref.a, c.ref.b] : [])].filter(p => !p.wall).map(p => p.L);
  const top = Math.max(c.Lref, c.supA(KNEE * S.peakA), c.supB(KNEE * S.peakB), ...ops);
  return { x: [BW[0], Math.max(BW[1], roundUp(1.08 * Math.max(S.peakA, S.peakB)))], y: [0, roundUp(1.2 * top)] };
}
function drawSd(c) {
  const focused = document.activeElement?.dataset?.which;   // the redraw replaces the focused handle
  // A drag keeps the axes, so the handle stays under the pointer
  if (!drag || !axes) axes = axesFor(c);
  const { x: dx, y: ly } = axes;
  cSd.scales(log(dx, [cSd.x0, cSd.x1]), linear(ly, [cSd.y0, cSd.y1]))
    .frame({ xlabel: "Bandwidth (GB/s)", ylabel: "Memory latency (ns)", xticks: [0.1, 1, 10, 100, 1000].filter(t => t <= dx[1]),
      xfmt: v => String(v), yfmt: v => v.toLocaleString("en-US") });
  cSd.clear();
  const curve = (sup, peak) => supplyCurve(sup, peak, dx[0], ly[1] * 1.1);
  cSd.line(curve(c.supA, S.peakA), { stroke: "var(--fg)", "stroke-width": 2, "stroke-dasharray": "7 5" });
  cSd.line(curve(c.supB, S.peakB), { stroke: "var(--fg)", "stroke-width": 2.6 });
  const tech = techOf(S.ns);
  // Each supply curve is named above its left end, as on the home page; when the two run close, the
  // lower name moves under its curve
  const [la, lb] = [c.supA(0.07), c.supB(0.07)], close = Math.abs(cSd.y(la) - cSd.y(lb)) < 20;
  cSd.text(0.07, la, "baseline", { class: "note", fill: "var(--fg)", dy: close && la <= lb ? 15 : -8 });
  cSd.text(0.07, lb, tech ? tech.name : `${fmt(S.ns)} ns`, { class: "note", fill: "var(--fg)", "font-weight": 700, dy: close && lb < la ? 15 : -8 });
  const demandLine = (s, color) => {
    const out = [];
    for (let i = 0; i <= 200; i++) { const L = 1.1 * ly[1] * i / 200; out.push([s.dem(L), L]); }
    cSd.line(out, { stroke: color, "stroke-width": 2.4 });
  };
  if (c.ref) demandLine(c.ref, "var(--ref)");
  demandLine(c.an, "var(--accent)");
  const w = c.w, bwRun = w.mpibw * LINE * w.ghz / w.cpi;
  cSd.dot(bwRun, c.Lref, 4.5, { fill: "var(--fg)" }, cSd.top);
  // A point outside the axes sits on the edge. Panel 4 gives its value.
  const inside = (bw, L) => [Math.min(Math.max(bw, dx[0]), dx[1]), Math.min(Math.max(L, ly[0]), ly[1])];
  if (c.ref) for (const [o, r] of [[c.ref.a, 4], [c.ref.b, 6.5]]) cSd.dot(...inside(o.bw, o.L), r, { fill: "var(--ref)" }, cSd.top);
  for (const [o, r] of [[c.an.a, 4], [c.an.b, 6.5]]) cSd.dot(...inside(o.bw, o.L), r, { fill: "#fff", stroke: "var(--accent)", "stroke-width": 2.4 }, cSd.top);
  // Handles: target memory (latency and bandwidth), today's memory (bandwidth only)
  for (const which of ["B", "A"]) {
    const peak = which === "B" ? S.peakB : S.peakA, sup = which === "B" ? c.supB : c.supA;
    const hx = KNEE * peak, hy = sup(hx);
    if (!(hy < ly[1])) continue;
    const peakNow = which === "B" ? S.peakB : S.peakA;
    const h = cSd.dot(hx, hy, which === "B" ? 9 : 7, { fill: "#fff", stroke: "var(--fg)", "stroke-width": 2.2, class: "handle", tabindex: 0, role: "slider",
      "aria-label": which === "B" ? "Target memory. Up and down arrows change the latency, left and right arrows the peak bandwidth."
        : "Baseline memory. Left and right arrows change the peak bandwidth.",
      "aria-valuenow": Math.round(peakNow), "aria-valuemin": PEAK_RANGE[0], "aria-valuemax": PEAK_RANGE[1],
      "aria-valuetext": which === "B" ? `${S.ns} ns, ${Math.round(S.peakB)} GB/s` : `${Math.round(S.peakA)} GB/s` }, cSd.top);
    h.dataset.which = which;
    h.addEventListener("keydown", ev => onKey(ev, which));
    if (which === focused) h.focus({ preventScroll: true });
    h.addEventListener("pointerdown", ev => {
      drag = { which };
      try { cSd.svg.setPointerCapture(ev.pointerId); } catch { /* synthetic events have no capture */ }
      ev.preventDefault();
    });
    if (which === "B") cSd.text(hx, hy, "drag", { class: "note", fill: "var(--muted)", dx: 13, dy: 4 });
  }
}
function onDrag(ev) {
  if (!drag) return;
  // Pushed against the top or the right edge, a handle widens that axis one round step at a time.
  // Otherwise it stays inside the axes that the drag keeps.
  const [bwp, Lp] = cSd.pointer(ev), push = ev.timeStamp - grown > 120;
  if (push && drag.which === "B" && Lp >= axes.y[1] && S.ns < 1000) { axes.y[1] = roundUp(1.05 * axes.y[1]); grown = ev.timeStamp; }
  if (push && bwp >= axes.x[1] && bwp / KNEE < 2000) { axes.x[1] = roundUp(1.05 * axes.x[1]); grown = ev.timeStamp; }
  const bw = Math.min(bwp, axes.x[1]), L = Math.min(Lp, 0.96 * axes.y[1]);
  const c = { P: plat(), w: selected() };
  const peak = Math.max(5, Math.min(2000, bw / KNEE));
  if (drag.which === "A") S.peakA = peak;
  else {
    S.peakB = peak;
    // At the handle the target gives r * ns + the knee, with r the run's ratio to the unloaded latency
    const r = c.w.mp / c.w.ghz / c.P.unloaded_ns;
    S.ns = Math.round(Math.max(40, Math.min(1000, nsAtKnee(L, r))));
  }
  render();
}
// Arrow keys move the focused handle: left and right change the peak bandwidth, up and down the target latency
const PEAK_RANGE = [5, 2000];
function onKey(ev, which) {
  const k = ev.shiftKey ? 5 : 1, cur = which === "B" ? S.peakB : S.peakA;
  const step = Math.max(1, Math.round(cur * 0.05)) * k;
  let peak = cur;
  if (ev.key === "ArrowRight") peak += step;
  else if (ev.key === "ArrowLeft") peak -= step;
  else if (which === "B" && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
    S.ns = Math.max(40, Math.min(1000, S.ns + (ev.key === "ArrowUp" ? 10 : -10) * k));
  } else return;
  ev.preventDefault();
  peak = Math.max(PEAK_RANGE[0], Math.min(PEAK_RANGE[1], peak));
  if (which === "A") S.peakA = peak; else S.peakB = peak;
  render();
}
const endDrag = () => { if (drag) { drag = null; render(); } };

// Panel 4: the numbers
function drawPred(c) {
  const w = c.w, tech = techOf(S.ns), ref = c.ref;
  const row = (name, a, b) => `<tr><td>${name}</td><td class="aneto">${a}</td>${ref ? `<td>${b}</td>` : ""}</tr>`;
  const hw = c.P.kind === "hardware";
  const span = !c.own && w.pts.length ? Math.min(...w.pts.map(p => p[0] / (w.mpi * w.mp))) : null;
  $("#pred").innerHTML = `
    <h3>${w.n} on ${c.P.label} <span class="muted">(${c.P.machine})</span></h3>
    <p class="sub">${w.s}. Single run: <i>CPI</i> ${fmt(w.cpi)}, <i>MPI</i>&thinsp;&times;&thinsp;<i>MP</i> ${fmt(w.mpi * w.mp)}, memory latency ${fmt(c.Lref)} ns.<br>
      Target: ${tech ? tech.name + ", " : ""}${fmt(S.ns)} ns unloaded, ${fmt(c.factor)}&times; the miss penalty of the baseline memory${S.copies > 1 ? `, ${S.copies} copies` : ""}.</p>
    <table class="readout">
      <tr><th><span class="sr-only">Quantity</span></th><th>Aneto</th>${ref ? `<th>Ground-truth fit</th>` : ""}</tr>
      ${row("BF", pct(c.an.bf), ref && pct(ref.bf))}
      ${row("<i>CPI</i><sub>0</sub>", fmt(c.an.cpi0), ref && fmt(ref.cpi0))}
      ${row("Latency on the target (ns)", fmt(c.an.b.L), ref && fmt(ref.b.L))}
      ${row("Bandwidth on the target (GB/s)", fmt(c.an.b.bw), ref && fmt(ref.b.bw))}
      ${row("CPI on the target", fmt(c.an.cpiB), ref && fmt(ref.cpiB))}
      ${row("Slowdown", signed(c.an.growth), ref && signed(ref.growth))}
    </table>
    ${!ref ? `<p class="verdict">This run has no sweep, so there is no reference.</p>`
      : c.an.b.wall && ref.b.wall ? `<p class="verdict">${S.copies > 1 ? "The copies saturate" : "The workload saturates"} the target memory, so its peak bandwidth sets the CPI, whatever the BF.</p>`
      : `<p class="verdict">CPI error of Aneto against the ground-truth fit: <b>${pct(Math.abs(c.an.cpiB - ref.cpiB) / ref.cpiB)}</b></p>`}
    <p class="note">Aneto reads only the run. The reference is the ground-truth fit of the sweep. <i>CPI</i><sub>0</sub> is the CPI of the compute component.
      ${c.fallback ? `This draw of ${S.ncal} workloads has fewer than 3 outside this benchmark, so Aneto fitted the regression on all other workloads of this machine`
        : S.calib === "small" ? `Aneto fitted the regression on ${S.ncal} randomly drawn workloads` : "Aneto fitted the regression on all other workloads of this machine"}, never on this workload or on other phases of its benchmark.
      ${ref && hw && span ? `The sweep reaches down to ${fmt(span)}&times; the miss penalty of the run. Beyond that range, the reference is the extrapolated ground-truth fit, as in the paper.` : ""}</p>`;
}

// Panel 5: rank candidate memories for the selected run, and the same query for the package
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const CANDIDATES = [
  { name: "DDR5", ns: 80, peak: null },
  { name: "CXL-3", ns: 250, peak: null },
  { name: "CXL-3 with a limit", ns: 250, peak: 64 },
  { name: "Rack", ns: 600, peak: null },
];
S.cands = CANDIDATES.map(m => ({ ...m }));
const num6 = v => String(Number(v.toPrecision(6)));
function memorySpec(m) {
  const t = TECHS.find(t => t.name === m.name && t.ns === m.ns);
  return (t ? t.name.toLowerCase() : num6(m.ns)) + (m.peak ? `:${num6(m.peak)}` : "");
}
function drawCompare(c) {
  const w = c.w;
  const rows = S.cands.map((m, i) => ({ m, i, ...predictOn(w, c.an, m, c.P.unloaded_ns, S.copies) }));
  const cpis = rows.filter(r => Number.isFinite(r.cpi)).map(r => r.cpi), best = Math.min(...cpis), top = Math.max(...cpis);
  const inp = (i, k, v, cls = "", ph = "") =>
    `<input class="${cls}" data-i="${i}" data-k="${k}" value="${esc(v ?? "")}" placeholder="${ph}" ${k === "name" ? "" : 'inputmode="decimal"'} aria-label="${k}">`;
  $("#cmp").innerHTML = `
    <table class="cmp">
      <tr><th>Memory</th><th>Unloaded (ns)</th><th>Peak (GB/s)</th><th class="seen">Loaded (ns)</th><th><i>CPI</i></th><th>Slowdown</th><th class="barcol"><span class="sr-only">CPI bar</span></th><th><span class="sr-only">Remove</span></th></tr>
      ${rows.map(r => `<tr class="${r.cpi === best ? "best" : ""}">
        <td>${inp(r.i, "name", r.m.name, "name")}</td><td>${inp(r.i, "ns", r.m.ns)}</td><td>${inp(r.i, "peak", r.m.peak, "", "none")}</td>
        <td class="seen">${fmt(r.L)}</td><td>${fmt(r.cpi)}</td><td>${signed(r.cpi / w.cpi - 1)}</td>
        <td class="barcol"><span class="bar" style="width:${Math.round(90 * r.cpi / top)}px"></span></td>
        <td><button class="small" type="button" data-del="${r.i}" aria-label="Remove ${esc(r.m.name)}">&times;</button></td></tr>`).join("")}
    </table>`;
  $("#cmp").querySelectorAll("input").forEach(e => e.addEventListener("change", () => {
    const m = S.cands[+e.dataset.i], v = e.value.trim();
    if (e.dataset.k === "name") m.name = v || "Memory";
    else if (e.dataset.k === "ns") m.ns = Math.max(10, Math.min(5000, parseFloat(v) || m.ns));
    else m.peak = parseFloat(v) > 0 ? parseFloat(v) : null;
    render();
  }));
  $("#cmp").querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    S.cands.splice(+b.dataset.del, 1);
    render();
  }));
  const cli = $("#cmp-cli");
  if (!cli) return; // a page without the command line
  // One token per option and value, so a narrow screen wraps between options only
  const tokens = ["aneto predict", `--machine ${c.P.id}`, `--cpi ${num6(w.cpi)}`, `--mpi ${num6(w.mpi)}`,
    `--mp ${num6(w.mp)}`, `--ghz ${num6(w.ghz)}`, ...(w.mpibw !== w.mpi ? [`--mpi-bw ${num6(w.mpibw)}`] : []),
    ...(S.copies > 1 ? [`--copies ${S.copies}`] : []), ...S.cands.map(m => `--memory ${memorySpec(m)}`)];
  cli.textContent = "";
  tokens.forEach((t, i) => {
    if (i) cli.append(" ");
    cli.appendChild(document.createElement("span")).textContent = t;
  });
}

// Panel 6: error over target latency, all workloads of this machine (latency only, as in the paper)
function drawLat(c) {
  const grid = [];
  for (let ns = 60; ns <= 750; ns += 10) grid.push(ns);
  const rows = grid.map(ns => [ns, errorsAt(S.p, ns)]);
  const now = errorsAt(S.p, S.ns);
  const ymax = Math.max(...rows.map(r => r[1].p90), now.p90) * 1.25;
  const yl = linear([0, ymax], [cLat.y0, cLat.y1]);
  cLat.scales(linear([60, 750], [cLat.x0, cLat.x1]), yl)
    .frame({ xlabel: "Unloaded latency of the target memory (ns)", ylabel: "CPI error (%)", yticks: yl.ticks().filter(v => v < ymax * 0.85) });
  cLat.clear();
  TECHS.forEach((t, i) => {
    cLat.line([[t.ns, 0], [t.ns, ymax]], { stroke: "var(--zebra)", "stroke-width": 1.5 });
    cLat.text(t.ns, ymax, t.name, { class: "note", "font-size": 11.5, fill: "var(--muted)", "text-anchor": "middle", dy: i % 2 ? 26 : 12 });
  });
  cLat.line(rows.map(([ns, e]) => [ns, e.p90]), { stroke: "var(--accent)", "stroke-width": 2.2, "stroke-dasharray": "7 5" });
  cLat.line(rows.map(([ns, e]) => [ns, e.p50]), { stroke: "var(--accent)", "stroke-width": 3 });
  cLat.line([[S.ns, 0], [S.ns, ymax]], { stroke: "var(--fg)", "stroke-width": 1, "stroke-dasharray": "3 4" });
  // The curves rise to the right: the median label goes below its point, the 90th percentile above
  for (const [v, lab, dy] of [[now.p50, "median", 18], [now.p90, "90th percentile", -7]]) {
    cLat.dot(S.ns, v, 5, { fill: "var(--accent)" }, cLat.top);
    cLat.text(S.ns, v, `${lab} ${fmt(v)}%`, { class: "note", fill: "var(--accent)", "font-weight": 700, dx: S.ns > 520 ? -9 : 9, dy, "text-anchor": S.ns > 520 ? "end" : "start" });
  }
  const preds = loo(S.p), n = c.P.workloads.filter(w => preds.has(w.n)).length;
  $("#cap-lat").innerHTML = `CPI error of ${n} ${c.P.label} workloads against their ground-truth fits, at each latency of the target memory. ` +
    `Aneto predicts each workload without its own sweep, from latency only (one copy, no bandwidth limit), as in the paper. Today's memory is at ${fmt(c.P.unloaded_ns)} ns unloaded.`;
}

// Panel 7: median error at the target latency on every machine
function drawMach(c) {
  const P = data.machines, vals = P.map((_, i) => errorsAt(i, S.ns).p50);
  const ymax = Math.max(15, ...vals) * 1.18;
  const x = linear([-0.6, P.length - 0.4], [cMach.x0, cMach.x1]);
  cMach.scales(x, linear([0, ymax], [cMach.y0, cMach.y1]))
    .frame({ xlabel: "", ylabel: "Median CPI error (%)", xticks: [] });
  cMach.clear();
  const bw = (cMach.x1 - cMach.x0) / P.length * 0.62;
  P.forEach((p, i) => {
    const r = el("rect", {
      x: x(i) - bw / 2, y: cMach.y(vals[i]), width: bw, height: cMach.y0 - cMach.y(vals[i]),
      fill: "var(--accent)", "fill-opacity": i === S.p ? 1 : 0.4, class: "dotwl",
    }, cMach.marks);
    r.addEventListener("click", () => setMachine(i));
    r.addEventListener("mousemove", ev => showTip(ev, `<b>${p.label}</b>, ${p.machine}<br>${p.workloads.length} workloads, baseline memory ${fmt(p.unloaded_ns)} ns`));
    r.addEventListener("mouseleave", hideTip);
    cMach.text(i, vals[i], fmt(vals[i]), { class: "note", "text-anchor": "middle", dy: -6, fill: "var(--fg)", "font-weight": i === S.p ? 700 : 400 });
    const ty = cMach.y0 + (narrow ? 14 : 20);
    const t = el("text", {
      x: x(i), y: ty, class: "tick", "font-weight": i === S.p ? 700 : 400, fill: "var(--fg)",
      "text-anchor": narrow ? "end" : "middle", transform: narrow ? `rotate(-40 ${x(i)} ${ty})` : null,
    }, cMach.top);
    t.textContent = narrow ? p.label : p.label.replace("ChampSim-", "").replace("Comet Lake", "Comet L.");
  });
  if (!narrow) {
    const cs = P.map((p, i) => p.label.startsWith("ChampSim") ? i : -1).filter(i => i >= 0);
    el("text", { x: (x(cs[0]) + x(cs[cs.length - 1])) / 2, y: cMach.y0 + 40, "text-anchor": "middle", class: "tick" }, cMach.top).textContent = "ChampSim";
  }
  const tech = techOf(S.ns);
  $("#cap-mach").innerHTML = `Median CPI error at ${tech ? tech.name + ", " : ""}${fmt(S.ns)} ns unloaded, over the workloads of each machine. ` +
    `ChampSim pf and nopf run with prefetching on and off. Click a bar to select its machine.`;
}

// Charts: a smaller drawing on phones keeps the text readable after scaling
let cKey, cLine, cSd, cLat, cMach, narrow;
function makeCharts() {
  narrow = innerWidth < 640;
  const o = (label, b = 52) => narrow
    ? { label, w: 400, h: 330, m: { l: 50, r: 12, t: 22, b } }
    : { label, w: 560, h: 360, m: { l: 62, r: 18, t: 22, b } };
  cKey = new Chart($("#plot-key"), o("CPI against MPI times MP of every workload"));
  cLine = new Chart($("#plot-line"), o("CPI against memory latency for the selected workload"));
  cSd = new Chart($("#plot-sd"), o("Memory latency against bandwidth, with the supply and demand curves"));
  cLat = new Chart($("#plot-lat"), o("Median and 90th-percentile CPI error over target latency"));
  cMach = new Chart($("#plot-mach"), o("Median CPI error on every machine", narrow ? 92 : 70));
  cSd.svg.addEventListener("pointermove", onDrag);
  cSd.svg.addEventListener("pointerup", endDrag);
  cSd.svg.addEventListener("pointercancel", endDrag);
}
addEventListener("resize", () => {
  if ((innerWidth < 640) !== narrow) { makeCharts(); render(); }
});

function setMachine(i) {
  if (i === S.p) return;
  S.prev = S.p;
  S.p = i;
  S.own = null;
  const W = plat().workloads, prev = S.wl;
  S.wl = (W.find(w => w.n === prev) || W[0]).n;
  S.copies = S.copies === data.machines[S.prev].cores ? plat().cores : Math.min(S.copies, plat().cores);
  fillWorkloads();
  render();
}

function seg(host, items, onPick) {
  host.innerHTML = "";
  for (const it of items) {
    if (it.sep) { host.appendChild(document.createElement("span")).className = "sep"; continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    b.dataset.v = it.v;
    b.addEventListener("click", () => onPick(it.v));
    host.appendChild(b);
  }
}
const press = (host, v) => host.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === String(v))));

function fillWorkloads() {
  const sel = $("#wl"), W = plat().workloads, by = new Map();
  for (const w of W) by.set(w.s, [...(by.get(w.s) || []), w]);
  sel.innerHTML = "";
  if (S.own) {
    const o = document.createElement("option");
    o.value = OWN;
    o.textContent = "Your run";
    sel.appendChild(o);
  }
  for (const [s, ws] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    const g = document.createElement("optgroup");
    g.label = s;
    for (const w of ws.sort((a, b) => a.n.localeCompare(b.n))) {
      const o = document.createElement("option");
      o.value = w.n;
      o.textContent = w.n;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
}

// The state lives in the URL hash, so a view can be linked (from a paper or a message)
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("m")) return false;
  const num = (k, lo, hi, d) => {
    const v = parseFloat(h.get(k));
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  };
  const p = data.machines.findIndex(m => m.label === h.get("m"));
  if (p >= 0) S.p = p;   // an unknown machine keeps the default
  if (plat().workloads.some(w => w.n === h.get("w"))) S.wl = h.get("w");
  S.ns = Math.round(num("t", 40, 1000, S.ns));
  S.copies = Math.round(num("k", 1, plat().cores, 1));
  S.peakA = num("pa", 5, 2000, PEAK);
  S.peakB = num("pb", 5, 2000, PEAK);
  if (h.get("cal") === "small") S.calib = "small";
  S.ncal = Math.round(num("n", 5, 40, S.ncal));
  S.seed = Math.round(num("s", 1, 1e6, S.seed));
  return true;
}
function writeHash() {
  const h = new URLSearchParams({ m: plat().label, w: S.wl === OWN ? "" : S.wl, t: S.ns, k: S.copies });
  if (S.peakA !== PEAK || S.peakB !== PEAK) { h.set("pa", Math.round(S.peakA)); h.set("pb", Math.round(S.peakB)); }
  if (S.calib === "small") { h.set("cal", "small"); h.set("n", S.ncal); h.set("s", S.seed); }
  history.replaceState(null, "", "#" + h.toString());
}

let started = false;
function render() {
  const c = compute();
  if (started && !drag) writeHash();
  started = true;
  press($("#machines"), S.p);
  press($("#techs"), techOf(S.ns) ? S.ns : "");
  press($("#calib"), S.calib);
  $("#wl").value = c.own ? OWN : c.w.n;
  $("#lat").value = S.ns;
  $("#lat-out").textContent = `${S.ns} ns`;
  $("#copies").max = c.P.cores;
  $("#copies").value = S.copies;
  $("#copies-out").textContent = S.copies;
  $("#reset-supply").disabled = S.peakA === PEAK && S.peakB === PEAK && S.copies === 1;
  $("#small-ctl").hidden = S.calib !== "small";
  $("#ncal").value = S.ncal;
  $("#ncal-out").textContent = S.ncal;
  $("#own-lat").placeholder = fmt(c.P.unloaded_ns);
  $("#own-ghz").placeholder = fmt(c.P.workloads[0].ghz);
  drawKey(c);
  drawLine(c);
  drawSd(c);
  drawPred(c);
  drawCompare(c);
  drawLat(c);
  drawMach(c);
}

function init() {
  const P = data.machines;
  seg($("#machines"), [
    ...P.map((p, i) => ({ label: p.label, v: i })).filter((_, i) => P[i].kind === "hardware"),
    { sep: true },
    ...P.map((p, i) => ({ label: p.label, v: i })).filter((_, i) => P[i].kind !== "hardware"),
  ], v => setMachine(+v));
  seg($("#techs"), TECHS.map(t => ({ label: t.name, v: t.ns })), v => { S.ns = +v; render(); });
  $("#calib").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { S.calib = b.dataset.v; render(); }));
  $("#wl").addEventListener("change", e => { S.wl = e.target.value; render(); });
  $("#rand").addEventListener("click", () => {
    const W = plat().workloads;
    S.wl = W[Math.floor(Math.random() * W.length)].n;
    render();
  });
  $("#lat").addEventListener("input", e => { S.ns = +e.target.value; render(); });
  $("#copies").addEventListener("input", e => { S.copies = +e.target.value; render(); });
  $("#ncal").addEventListener("input", e => { S.ncal = +e.target.value; render(); });
  $("#redraw").addEventListener("click", () => { S.seed++; render(); });
  $("#cmp-add").addEventListener("click", () => {
    S.cands.push({ name: `${fmt(S.ns)} ns`, ns: S.ns, peak: S.peakB !== PEAK ? Math.round(S.peakB) : null });
    render();
  });
  $("#reset-supply").addEventListener("click", () => { S.peakA = S.peakB = PEAK; S.copies = 1; render(); });
  $("#own").addEventListener("submit", e => {
    e.preventDefault();
    const f = new FormData(e.target), num = k => parseFloat(String(f.get(k)).trim());
    const P = plat();
    const cycles = num("cycles"), instr = num("instr"), misses = num("misses");
    const lat = num("lat") || P.unloaded_ns, ghz = num("ghz") || P.workloads[0].ghz;
    if (![cycles, instr, misses, lat, ghz].every(v => Number.isFinite(v) && v > 0)) {
      alert("Enter positive numbers, for example 1.2e12.");
      return;
    }
    const mpi = misses / instr;
    S.own = { own: true, n: "Your run", s: "Your counters", g: OWN, cpi: cycles / instr, mpi, mpibw: mpi, mp: lat * ghz, ghz, pts: [] };
    S.wl = OWN;
    fillWorkloads();
    render();
  });
  $("#own-clear").addEventListener("click", () => {
    S.own = null;
    if (S.wl === OWN) S.wl = plat().workloads[0].n;
    fillWorkloads();
    render();
  });
  makeCharts();
  const linked = readHash();
  fillWorkloads();
  render();
  if (linked) $("#demo").scrollIntoView();
}

init();
