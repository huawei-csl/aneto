// The live example of the home page: a machine, a suite, a workload and a target memory give the
// supply and demand curves, the slowdown of the workload and the mean slowdown of its suite.
import "./copy.js";
import data from "../data/machines.js";
import { crossValidate, KNEE, LINE, measuredCurve, nsAtKnee, percentile, predictOn, supplyCurve } from "./aneto.js";
import { Chart, el, fmt, linear, log, roundUp } from "./plot.js";

const $ = s => document.querySelector(s);
const PEAK = 100;   // GB/s, peak bandwidth of both supply curves until the target is dragged (illustrative)
const BW = [0.05, 200];

const S = { m: "zen5", suite: "all", w: "gms-tc-pokec", ns: 250, peak: PEAK, copies: 1, ex: null };
let base = 250;   // the latency of the last preset chosen, for Reset
const NS = [40, 1500], GBPS = [1, 240];
const clamp = (v, [lo, hi]) => Math.round(Math.max(lo, Math.min(hi, v)));
const peakStep = () => (S.peak > 20 ? 5 : 1);

const machine = () => data.machines.find(m => m.id === S.m) || data.machines[0];
// Suites by key: "all", or the suite name in lower case with dashes ("spec17", "ai-ml")
const key = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const members = (m, suite) => m.workloads.filter(w => suite === "all" || key(w.s) === suite);
// The suites of a machine, by name. A machine with a single suite offers only "All".
function suitesOf(m) {
  const names = [...new Set(m.workloads.map(w => w.s))].sort((a, b) => a.localeCompare(b));
  return names.length > 1 ? names : [];
}
// The target is an example (a MESS curve of another machine), or a preset while it keeps the preset
// latency and the default peak
const example = () => data.examples.find(e => e.id === S.ex) || null;
const preset = () => (!example() && S.peak === PEAK ? data.technologies.find(t => t.ns === S.ns) : null);
const target = () => (example() ? { ns: example().ns, curve: example().curve } : { ns: S.ns, peak: S.peak });
const peakOf = mem => mem.peak ?? mem.curve.at(-1)[0];
// The presets in groups a reader knows, each with a short form of its note in the package
const GROUPS = [
  ["Local DRAM", { DDR5: "", DDR4: "" }],
  ["Remote socket", { NUMA: "" }],
  ["CXL", { "CXL-3": "direct-attached", "CXL-sw": "behind a switch", "CXL-pool": "pooled" }],
  ["Disaggregated", { Rack: "rack-scale", "X-rack": "cross-rack" }],
];
const kindOf = t => GROUPS.find(([, names]) => t.name in names);
const techLabel = t => { const g = kindOf(t), k = g && g[1][t.name]; return k ? `${t.name}, ${k}` : t.name; };
const memLabel = () => (example() ? `${example().name}, MESS curve` : preset() ? techLabel(preset()) : `${S.ns} ns, ${S.peak} GB/s`);
// The baseline memory: the DRAM of the calibration runs (hardware only)
const baseline = m => (m.memory ? `baseline, ${m.memory}` : "baseline");
// The change against the single run: a percent below 10x, then a factor. Faster is the speedup,
// 1 / s - 1, so 2x slower and 2x faster read the same.
function change(s) {
  const f = s >= 1 ? s : 1 / s;
  return f >= 10 ? `${Math.round(f)}x` : `${Math.round(100 * (f - 1))}%`;
}
const direction = s => (s >= 1 ? "slower" : "faster");

// Leave-one-out estimates of every workload, once per machine
const cache = new Map();
function loo(m) {
  if (!cache.has(m.id)) cache.set(m.id, crossValidate(m.workloads));
  return cache.get(m.id);
}

// Aneto and the ground-truth fit for one workload: operating points on today's memory and the
// target, the slowdown against the single run, and the CPI error on the target
function predictOne(m, w) {
  const est = loo(m).get(w.n);
  if (!est) return null;
  const today = { ns: m.unloaded_ns, peak: PEAK }, mem = target();
  const side = e => ({ a: predictOn(w, e, today, m.unloaded_ns, S.copies), b: predictOn(w, e, mem, m.unloaded_ns, S.copies) });
  const an = side(est), gt = side({ bf: w.bf, cpi0: w.cpi0 });
  // sat: both sit at the wall of the target, where the peak bandwidth sets the CPI and the error says nothing
  return { w, an, gt, sAn: an.b.cpi / w.cpi, sGt: gt.b.cpi / w.cpi, err: Math.abs(an.b.cpi - gt.b.cpi) / gt.b.cpi,
    sat: an.b.wall && gt.b.wall };
}

const geomean = v => Math.exp(v.reduce((s, x) => s + Math.log(x), 0) / v.length);

function fillMachines() {
  const groups = [["CPUs", "hardware"], ["Simulators", "simulator"]];
  $("#h-machine").innerHTML = groups.map(([label, kind]) =>
    `<optgroup label="${label}">${data.machines.filter(m => m.kind === kind).map(m =>
      `<option value="${m.id}">${kind === "hardware" ? `${m.label} (${m.name}), ${m.memory}` : m.machine}</option>`).join("")}</optgroup>`).join("");
}

function fillWorkloads(m) {
  const W = members(m, S.suite).slice().sort((a, b) => a.n.localeCompare(b.n, "en", { numeric: true }));
  if (!W.some(w => w.n === S.w)) S.w = W[0].n;
  const opt = w => `<option value="${w.n}">${w.n}</option>`, names = suitesOf(m);
  if (S.suite !== "all" || !names.length) {
    $("#h-workload").innerHTML = W.map(opt).join("");
    return;
  }
  $("#h-workload").innerHTML = names.map(s =>
    `<optgroup label="${s}">${W.filter(w => w.s === s).map(opt).join("")}</optgroup>`).join("");
}

function syncControls(m) {
  const names = suitesOf(m), count = suite => members(m, suite).length;
  const opt = (k, label) => `<option value="${k}">${label} (${count(k)})</option>`;
  $("#h-suite").innerHTML = opt("all", "All") + names.map(n => opt(key(n), n)).join("");
  $("#h-suite").disabled = !names.length;
  $("#h-suite").value = S.suite;
  $("#h-machine").value = m.id;
  $("#h-workload").value = S.w;
  // A dragged target joins the list as its own entry
  const techOpt = t => `<option value="${t.ns}">${techLabel(t)}, ${t.ns} ns</option>`;
  $("#h-memory").innerHTML = GROUPS.map(([g]) =>
    `<optgroup label="${g}">${data.technologies.filter(t => kindOf(t)?.[0] === g).map(techOpt).join("")}</optgroup>`).join("") +
    data.technologies.filter(t => !kindOf(t)).map(techOpt).join("") +
    `<optgroup label="MESS curves of other machines">${data.examples.map(e =>
      `<option value="ex:${e.id}">${e.name}, ${Math.round(e.ns)} ns</option>`).join("")}</optgroup>` +
    (preset() || example() ? "" : `<optgroup label="Dragged"><option value="custom">${memLabel()}</option></optgroup>`);
  $("#h-memory").value = example() ? `ex:${S.ex}` : preset() ? String(S.ns) : "custom";
  const copies = [];
  for (let c = 1; c < m.cores; c *= 2) copies.push(c);
  copies.push(m.cores);
  if (!copies.includes(S.copies)) S.copies = copies.filter(c => c <= S.copies).pop();
  $("#h-copies").innerHTML = copies.map(c =>
    `<option value="${c}">${c === 1 ? "1 copy" : `${c} copies${c === m.cores ? ", one per core" : ""}`}</option>`).join("");
  $("#h-copies").value = String(S.copies);
  // A MESS curve is measured, so its latency and peak stay as they are
  const mem = target();
  $("#h-ns").value = Math.round(mem.ns);
  $("#h-peak").value = Math.round(peakOf(mem));
  for (const c of document.querySelectorAll(".target-edit input, .target-edit [data-k]")) c.disabled = !!example();
  $("#h-reset").disabled = !!(preset() || example());
}

// Supply and demand: bandwidth on a log axis, so the demand of one copy is visible next to the peak,
// and latency on a linear axis from 0, as in the paper's figure. There the demand curve bows toward
// the origin and reaches its limit, copies x traffic / CPI0, at zero latency. A phone gets a smaller
// drawing, so the text stays readable.
let chart = null;
let drag = null;   // while the handle moves: the run's latency ratio, which maps the pointer to a target
let yTop = 0;      // top of the latency axis (ns), kept while the handle moves so it stays under the pointer
let grown = -Infinity;   // time of the last step up of the latency axis during a drag
const narrow = matchMedia("(max-width: 640px)");
function makeChart() {
  const size = narrow.matches ? { w: 400, h: 330, m: { l: 54, r: 14, t: 12, b: 50 } } : { w: 640, h: 400, m: { l: 62, r: 20, t: 14, b: 52 } };
  chart = new Chart($("#h-sd"), { ...size, label: "Supply and demand curves" });
  chart.svg.addEventListener("pointermove", onDrag);
  chart.svg.addEventListener("pointerup", endDrag);
  chart.svg.addEventListener("pointercancel", endDrag);
}

// The top of the latency axis: a round value above the run, the handle and the operating points. A
// point at the wall is left out: the peak bandwidth sets its CPI, and its latency only says how far up
// the wall it sits.
function latencyTop({ an, gt, w }) {
  const v = [w.mp / w.ghz, an.b.sup(KNEE * peakOf(target())), ...[an.b, gt.b].filter(p => !p.wall).map(p => p.L)];
  return roundUp(1.2 * Math.max(...v));
}

function drawSd(r) {
  const { an, gt, w } = r;
  const Lrun = w.mp / w.ghz, ratio = Lrun / machine().unloaded_ns;
  if (!drag) yTop = latencyTop(r);
  // The axis reaches past the peak of a MESS curve above 200 GB/s
  const bw = [BW[0], Math.max(BW[1], roundUp(1.08 * peakOf(target())))];
  chart.scales(log(bw, [chart.x0, chart.x1]), linear([0, yTop], [chart.y0, chart.y1]))
    .frame({ xlabel: "Bandwidth (GB/s)", ylabel: "Memory latency (ns)", xticks: [0.1, 1, 10, 100, 1000].filter(t => t <= bw[1]), xfmt: v => String(v),
      yfmt: v => v.toLocaleString("en-US") });
  // A redraw replaces the handle, so a focused handle passes its focus on to the new one
  const hadFocus = !!document.activeElement?.classList?.contains("handle");
  chart.clear();
  const supply = (sup, peak) => supplyCurve(sup, peak, BW[0], yTop * 1.1);
  chart.line(supply(an.a.sup, PEAK), { stroke: "var(--fg)", "stroke-width": 2, "stroke-dasharray": "7 5" });
  const ex = example();
  chart.line(ex ? measuredCurve(an.b.sup, ex.curve, BW[0], yTop * 1.1) : supply(an.b.sup, S.peak), { stroke: "var(--fg)", "stroke-width": 2.6 });
  // Each supply curve is named above its left end. When the two run close, the lower name moves under
  // its curve; without room there, only the target keeps its name and the legend names the baseline memory.
  const [la, lb] = [an.a.sup(0.07), an.b.sup(0.07)], [pa, pb] = [chart.y(la), chart.y(lb)];
  const A = { class: "note", fill: "var(--fg)" }, B = { ...A, "font-weight": 700 };
  const name = ex ? ex.name : preset() ? preset().name : "target";
  if (Math.abs(pa - pb) >= 20) {
    chart.text(0.07, la, baseline(machine()), { ...A, dy: -8 });
    chart.text(0.07, lb, name, { ...B, dy: -8 });
  } else if (chart.y0 - Math.max(pa, pb) >= 18) {
    chart.text(0.07, la, baseline(machine()), { ...A, dy: pa >= pb ? 15 : -8 });
    chart.text(0.07, lb, name, { ...B, dy: pb > pa ? 15 : -8 });
  } else chart.text(0.07, Math.max(la, lb), name, { ...B, dy: -8 });
  const demand = (dem, color) => {
    const pts = [];
    for (let i = 0; i <= 200; i++) { const L = 1.1 * yTop * i / 200; pts.push([dem(L), L]); }
    chart.line(pts, { stroke: color, "stroke-width": 2.4 });
  };
  demand(gt.b.dem, "var(--ref)");
  demand(an.b.dem, "var(--accent)");
  // A point above the axis sits on its edge, and its label says so
  const inside = (b, L) => [Math.min(Math.max(b, bw[0]), bw[1]), Math.min(L, yTop)];
  chart.dot(...inside(gt.b.bw, gt.b.L), 6, { fill: "var(--ref)" }, chart.top);
  chart.dot(w.mpibw * LINE * w.ghz / w.cpi, Lrun, 4.5, { fill: "var(--fg)" }, chart.top);
  const [ox, oy] = inside(an.b.bw, an.b.L), right = chart.x(ox) > (chart.x0 + chart.x1) / 2;
  chart.dot(ox, oy, 6.5, { class: "op", fill: "#fff", stroke: "var(--accent)", "stroke-width": 2.4 }, chart.top);
  chart.text(ox, oy, an.b.wall ? "at the peak bandwidth" : `${fmt(an.b.L)} ns${an.b.L > yTop ? ", off the chart" : ""}`,
    { class: "note", fill: "var(--accent)", "font-weight": 700, "text-anchor": right ? "end" : "start", dx: right ? -11 : 11, dy: oy === yTop ? 14 : -9 });

  // A MESS curve has no handle: it is measured
  const hx = KNEE * S.peak, hy = an.b.sup(hx);
  if (ex || !(hy < yTop)) return;
  const value = `${S.ns} ns, ${S.peak} GB/s`;
  const h = chart.dot(hx, hy, 9, { class: "handle", tabindex: 0, role: "slider", "aria-label": "Target memory. Up and down arrows change the latency, left and right arrows the peak bandwidth.",
    "aria-valuenow": S.ns, "aria-valuemin": NS[0], "aria-valuemax": NS[1], "aria-valuetext": value }, chart.top);
  const live = drag || hadFocus;
  chart.text(hx, hy, live ? value : "drag", { class: "note", fill: live ? "var(--accent)" : "var(--muted)", "font-weight": live ? 700 : 400,
    "text-anchor": "end", dx: -14, dy: 4 });
  h.addEventListener("pointerdown", ev => {
    drag = { r: ratio };
    try { chart.svg.setPointerCapture(ev.pointerId); } catch { /* synthetic events have no capture */ }
    ev.preventDefault();
  });
  h.addEventListener("keydown", onKey);
  if (live) h.dataset.live = "";
  // Show the value while the handle has the focus, and the hint again when it loses it
  h.addEventListener("focus", () => { if (!("live" in h.dataset)) render(); });
  h.addEventListener("blur", () => { if (h.isConnected) render(); });
  if (hadFocus) h.focus({ preventScroll: true });
}

// Arrow keys move the handle: up and down for the latency, left and right for the peak bandwidth
function onKey(ev) {
  const k = ev.shiftKey ? 5 : 1;
  const moves = { ArrowUp: ["ns", 10], ArrowDown: ["ns", -10], ArrowRight: ["peak", peakStep()], ArrowLeft: ["peak", -peakStep()] };
  if (!moves[ev.key]) return;
  ev.preventDefault();
  const [what, d] = moves[ev.key];
  if (what === "ns") S.ns = clamp(S.ns + k * d, NS);
  else S.peak = clamp(S.peak + k * d, GBPS);
  render();
}

// At the handle, the target gives r * ns plus the queueing delay at KNEE of the peak
function onDrag(ev) {
  if (!drag) return;
  const [bw, Lp] = chart.pointer(ev);
  // Pushed against the top, the handle raises the axis one round step at a time, so a drag reaches any
  // latency. Otherwise it stays inside the axis.
  if (Lp >= yTop && S.ns < NS[1] && ev.timeStamp - grown > 120) { yTop = roundUp(1.05 * yTop); grown = ev.timeStamp; }
  const L = Math.min(Lp, 0.96 * yTop);
  S.peak = clamp(bw / KNEE, GBPS);
  S.ns = clamp(nsAtKnee(L, drag.r), NS);
  // Snap to a preset: its latency within 6 ns, the default peak within 4 GB/s
  const near = data.technologies.find(t => Math.abs(t.ns - S.ns) <= 6);
  if (near) S.ns = near.ns;
  if (Math.abs(S.peak - PEAK) <= 4) S.peak = PEAK;
  render();
}
function endDrag() {
  if (!drag) return;
  drag = null;
  render();
}

// Every workload of the suite on a log axis of the slowdown that Aneto predicts: 2x slower and 2x faster
// sit at the same distance from 0%, and each geometric mean falls where its dots balance
const STEPS = [2, 10, 100, 1000, 1.5, 5, 50, 500, 5000, 1.25, 3, 20, 200, 2000, 1.1];
const tickLabel = t => (Math.abs(t - 1) < 1e-9 ? "0%" : t >= 10 ? change(t) : `${t > 1 ? "+" : "\u2212"}${change(t)}`);
function drawStrip(rows, sel) {
  const host = $("#h-strip"), W = 420, H = 92, x0 = 14, x1 = W - 14, y0 = 16, y1 = 62;
  const vals = rows.flatMap(r => [r.sAn, r.sGt]).map(Math.log);
  let a = Math.min(0, ...vals), b = Math.max(0, ...vals);
  if (b - a < 0.1) { const c = (a + b) / 2; a = c - 0.05; b = c + 0.05; }
  const pad = 0.04 * (b - a), x = log([Math.exp(a - pad), Math.exp(b + pad)], [x0, x1]);
  // Ticks at round slowdowns and speedups, the roundest first, at least 56 units apart
  const ticks = [];
  for (const t of [1, ...STEPS.flatMap(v => [v, 1 / v])])
    if (x(t) >= x0 && x(t) <= x1 && ticks.every(u => Math.abs(x(u) - x(t)) >= 56)) ticks.push(t);
  host.innerHTML = "";
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart strip", role: "group",
    "aria-label": "Slowdown of each workload of the suite" }, host);
  el("line", { x1: x0, x2: x1, y1: y1 + 6, y2: y1 + 6, class: "axis" }, svg);
  for (const v of ticks) {
    el("line", { x1: x(v), x2: x(v), y1: y1 + 6, y2: y1 + 10, class: "axis" }, svg);
    el("text", { x: x(v), y: y1 + 26, "text-anchor": "middle", class: "tick" }, svg).textContent = tickLabel(v);
  }
  const mean = k => geomean(rows.map(r => r[k]));
  el("line", { x1: x(mean("sGt")), x2: x(mean("sGt")), y1: y0 - 8, y2: y1 + 6, stroke: "var(--ref)", "stroke-width": 2, "stroke-dasharray": "4 3" }, svg);
  el("line", { x1: x(mean("sAn")), x2: x(mean("sAn")), y1: y0 - 8, y2: y1 + 6, stroke: "var(--accent)", "stroke-width": 2 }, svg);
  let picked = null;
  rows.forEach((r, i) => {
    if (r.w.n === sel) { picked = r; return; }
    const c = el("circle", { cx: x(r.sAn), cy: y0 + (y1 - y0) * ((i * 0.6180339887) % 1), r: 4, class: "dot" }, svg);
    el("title", {}, c).textContent = `${r.w.n}: ${change(r.sAn)} ${direction(r.sAn)}`;
    c.addEventListener("click", () => { S.w = r.w.n; render(); });
  });
  if (picked) el("circle", { cx: x(picked.sAn), cy: (y0 + y1) / 2, r: 7, class: "dot sel" }, svg);
}

function render() {
  const m = machine();
  if (S.suite !== "all" && !suitesOf(m).some(n => key(n) === S.suite)) S.suite = "all";
  S.copies = Math.min(S.copies, m.cores);
  fillWorkloads(m);
  syncControls(m);
  const rows = members(m, S.suite).map(w => predictOne(m, w)).filter(Boolean);
  const r = rows.find(x => x.w.n === S.w) || rows[0];
  S.w = r.w.n;
  drawSd(r);
  const suite = S.suite === "all" ? "All workloads" : suitesOf(m).find(n => key(n) === S.suite);
  const shared = S.copies > 1 ? `, with ${S.copies} copies running at once and sharing the memory` : "";
  // On a MESS curve of another machine, Aneto extrapolates, and no error is known
  const far = "MESS measured this curve on another machine, so Aneto extrapolates and no error is known.";
  const check = r.sat
    ? `${S.copies > 1 ? "The copies saturate" : "The workload saturates"} the memory, so its peak bandwidth sets the CPI, whatever the BF. The ground-truth fit gives the same value.`
    : example() ? far : `Ground-truth fit: ${change(r.sGt)} ${direction(r.sGt)}. CPI error of Aneto: ${fmt(100 * r.err)}%.`;
  $("#h-one").innerHTML = `
    <h3>${r.w.n} on ${memLabel()}</h3>
    <p class="big"><span class="val">${change(r.sAn)}</span> ${direction(r.sAn)}</p>
    <p class="sub">than its single run on ${m.label}${m.memory ? ` with ${m.memory}` : ""}${shared}. ${check}</p>`;
  const sAn = geomean(rows.map(x => x.sAn)), sGt = geomean(rows.map(x => x.sGt));
  const live = rows.filter(x => !x.sat), n = live.length;
  const err = !n ? "Every workload saturates the memory, so its peak bandwidth sets every CPI."
    : `Median CPI error of Aneto: ${fmt(percentile(live.map(x => 100 * x.err), 50))}%${n < rows.length
      ? `, over the ${n} workload${n > 1 ? "s that do" : " that does"} not saturate the memory` : ""}.`;
  $("#h-suite-result").innerHTML = `
    <h3>${suite} on ${m.label} <span class="muted">(${rows.length})</span></h3>
    <p class="big"><span class="val">${change(sAn)}</span> ${direction(sAn)}</p>
    <p class="sub">geometric mean of the slowdown. ${example() ? far : `Ground-truth fit: ${change(sGt)} ${direction(sGt)}. ${err}`}</p>`;
  drawStrip(rows, r.w.n);
  const q = new URLSearchParams(S.ex ? { m: S.m, s: S.suite, w: S.w, x: S.ex, k: S.copies }
    : { m: S.m, s: S.suite, w: S.w, t: S.ns, p: S.peak, k: S.copies });
  history.replaceState(null, "", `#${q}`);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const num = (k, lo, hi) => { const v = Number(q.get(k)); return q.has(k) && v >= lo && v <= hi ? Math.round(v) : null; };
  if (data.machines.some(m => m.id === q.get("m"))) S.m = q.get("m");
  if (q.get("s")) S.suite = q.get("s");
  if (q.get("w")) S.w = q.get("w");
  S.ns = num("t", ...NS) ?? S.ns;
  if (data.technologies.some(t => t.ns === S.ns)) base = S.ns;
  S.peak = num("p", ...GBPS) ?? S.peak;
  S.copies = num("k", 1, 1024) ?? S.copies;
  if (data.examples.some(e => e.id === q.get("x"))) S.ex = q.get("x");
}

function init() {
  readHash();
  fillMachines();
  makeChart();
  narrow.addEventListener("change", () => { makeChart(); render(); });
  $("#h-machine").addEventListener("change", e => { S.m = e.target.value; render(); });
  $("#h-suite").addEventListener("change", e => { S.suite = e.target.value; render(); });
  $("#h-workload").addEventListener("change", e => { S.w = e.target.value; render(); });
  $("#h-memory").addEventListener("change", e => {
    const v = e.target.value;
    if (v === "custom") return;
    S.ex = v.startsWith("ex:") ? v.slice(3) : null;
    if (!S.ex) { S.ns = base = Number(v); S.peak = PEAK; }
    render();
  });
  // The fields and steppers under the chart: the same target as the handle
  $("#h-ns").addEventListener("change", e => { S.ns = clamp(Number(e.target.value) || S.ns, NS); render(); });
  $("#h-peak").addEventListener("change", e => { S.peak = clamp(Number(e.target.value) || S.peak, GBPS); render(); });
  for (const b of document.querySelectorAll(".target-edit [data-k]")) {
    b.addEventListener("click", () => {
      const d = Number(b.dataset.dir);
      if (b.dataset.k === "ns") S.ns = clamp(S.ns + 10 * d, NS);
      else S.peak = clamp(S.peak + peakStep() * d, GBPS);
      render();
    });
  }
  $("#h-reset").addEventListener("click", () => { S.ns = base; S.peak = PEAK; render(); });
  $("#h-copies").addEventListener("change", e => { S.copies = Number(e.target.value); render(); });
  render();
}

init();
