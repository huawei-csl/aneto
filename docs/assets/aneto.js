// The Aneto model in JavaScript.
// OLS on standardized features: logit(f_mem) ~ [1, log(MPI*MP), log(CPI)], f_mem = BF*MPI*MP/CPI,
// inverted through the sigmoid. tools/check_site.mjs checks it against reference predictions.

const EPS = 1e-6;     // logit clamp
const FLOOR = 1e-6;   // lower bound on the predicted BF and CPI0
const CLIP = 50;      // logit clip before the sigmoid

export const logit = p => {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(q / (1 - q));
};
export const sigmoid = z => 1 / (1 + Math.exp(-z));

const features = w => [Math.log(w.mpi) + Math.log(w.mp), Math.log(w.cpi)];

function target(w) {
  const f = w.bf * w.mpi * w.mp / w.cpi;
  return f > 0 && f < 1 ? logit(f) : NaN;
}

function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < 3; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j < 4; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = M[r][3];
    for (let j = r + 1; j < 3; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

// Fit on workloads with a known BF (from their sweep). Returns null below three usable workloads.
export function fit(train) {
  const rows = train.filter(w => Number.isFinite(target(w)));
  const n = rows.length;
  if (n < 3) return null;
  const F = rows.map(features), y = rows.map(target);
  const mean = [0, 1].map(j => F.reduce((s, f) => s + f[j], 0) / n);
  const std = [0, 1].map(j => {
    const sd = Math.sqrt(F.reduce((s, f) => s + (f[j] - mean[j]) ** 2, 0) / n);
    return sd > 0 ? sd : 1;
  });
  const X = F.map(f => [1, (f[0] - mean[0]) / std[0], (f[1] - mean[1]) / std[1]]);
  const A = [0, 1, 2].map(i => [0, 1, 2].map(j => X.reduce((s, x) => s + x[i] * x[j], 0)));
  const b = [0, 1, 2].map(i => X.reduce((s, x, k) => s + x[i] * y[k], 0));
  const beta = solve3(A, b);
  return { beta, mean, std, n };
}

export function predictLogit(m, w) {
  const [a, c] = features(w);
  return m.beta[0] + m.beta[1] * (a - m.mean[0]) / m.std[0] + m.beta[2] * (c - m.mean[1]) / m.std[1];
}

// BF and CPI0 from one baseline run (cpi, mpi, mp)
export function predict(m, w) {
  const f = sigmoid(Math.max(-CLIP, Math.min(CLIP, predictLogit(m, w))));
  const x = w.mpi * w.mp;
  const bf = Math.max(FLOOR, f * w.cpi / x);
  return { bf, cpi0: Math.max(FLOOR, w.cpi - bf * x) };
}

// Leave-one-group-out, as in the paper: phases of one benchmark are held out together.
// With `calib` (a set of names), every workload is predicted from that set instead, minus its own group.
export function crossValidate(workloads, calib = null) {
  const groups = new Map();
  for (const w of workloads) groups.set(w.g, [...(groups.get(w.g) || []), w]);
  const out = new Map();
  for (const [g, members] of groups) {
    const train = workloads.filter(w => w.g !== g && (!calib || calib.has(w.n)));
    const m = fit(train);
    if (!m) continue;
    for (const w of members) out.set(w.n, predict(m, w));
  }
  return out;
}

// CPI at `factor` times the baseline miss penalty
export const cpiAt = (cpi0, bf, w, factor) => cpi0 + bf * w.mpi * w.mp * factor;

// numpy.percentile with linear interpolation
export function percentile(v, p) {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * p / 100, lo = Math.floor(h);
  return lo + 1 < s.length ? s[lo] + (h - lo) * (s[lo + 1] - s[lo]) : s[lo];
}

// Relative CPI error (%) of each predicted workload at `factor`, against its own sweep fit
export function cpiErrors(workloads, preds, factor) {
  const errs = [];
  for (const w of workloads) {
    const p = preds.get(w.n);
    if (!p) continue;
    const t = cpiAt(w.cpi0, w.bf, w, factor), h = cpiAt(p.cpi0, p.bf, w, factor);
    errs.push(100 * Math.abs(h - t) / Math.abs(t));
  }
  return errs;
}

// CPI on the iso-BF line of model `m` at memory load x = MPI*MP: the CPI at which the model
// predicts `bf`. Null when there is none in range.
export function isoCpi(m, bf, x) {
  const k1 = m.beta[1] / m.std[0], k2 = m.beta[2] / m.std[1];
  const k0 = m.beta[0] - k1 * m.mean[0] - k2 * m.mean[1];
  const g = u => logit(bf * x / Math.exp(u)) - (k0 + k1 * Math.log(x) + k2 * u);
  let lo = Math.log(bf * x) + 1e-9, hi = lo + 12;
  if (g(lo) * g(hi) > 0) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (g(lo) * g(mid) <= 0) hi = mid; else lo = mid;
  }
  return Math.exp((lo + hi) / 2);
}

// Memories and the operating point, as the package (aneto/memory.py, aneto/predict.py).
// A memory is { ns, peak }: unloaded latency (ns) and, optionally, a peak bandwidth (GB/s)
// with the illustrative knee of aneto.memory.Memory. Or it is { ns, curve }: measured [GB/s, ns]
// points, in order of bandwidth, past the last of which the memory saturates.
export const Q_NS = 30;   // queueing delay scale of the knee (ns)
const WALL = 0.995;       // share of the peak where the latency turns infinite
export const LINE = 64;   // bytes per miss
export const KNEE = 0.8;  // drag handles sit at this share of the peak bandwidth

// The unloaded latency (ns) of a target whose latency at KNEE of its peak is L, for a run at r x unloaded
export const nsAtKnee = (L, r) => (L - Q_NS * KNEE ** 3 / (1 - KNEE)) / r;

export function latencyAt(mem, bw) {
  if (mem.curve) {
    const c = mem.curve, i = c.findIndex(p => p[0] >= bw);
    if (i <= 0) return i ? Infinity : c[0][1];
    const [[x0, y0], [x1, y1]] = [c[i - 1], c[i]];
    return y0 + (y1 - y0) * (bw - x0) / (x1 - x0);
  }
  if (!mem.peak) return mem.ns;
  const u = bw / mem.peak;
  return u >= WALL ? Infinity : mem.ns + Q_NS * u ** 3 / (1 - u);
}

// Points of the supply curve sup of a memory with this peak, for a plot that ends at `top` ns. The
// steps are even (from 0) or log-spaced (from > 0) up to 30% of the peak, then log-spaced in 1 - u,
// so the steep part is drawn. The curve ends in the wall, where operatingPoint places any point
// beyond its last finite value.
export function supplyCurve(sup, peak, from, top) {
  const bws = [], bend = 0.3 * peak, gap = (1 - WALL) * 1.002;
  for (let i = 0; i < 60; i++) bws.push(from > 0 ? from * (bend / from) ** (i / 60) : bend * i / 60);
  for (let i = 0; i <= 120; i++) bws.push(peak * (1 - 0.7 * (gap / 0.7) ** (i / 120)));
  const pts = [];
  for (const bw of bws) {
    const L = sup(bw);
    pts.push([bw, L]);
    if (L > top) return pts;
  }
  pts.push([WALL * peak, top]);
  return pts;
}

// Points of the supply curve sup of a measured memory from `from` GB/s, up to `top` ns. It ends in the
// wall at its last point.
export function measuredCurve(sup, curve, from, top) {
  const pts = [[from, sup(from)]];
  for (const [bw] of curve) {
    if (bw <= from) continue;
    pts.push([bw, sup(bw)]);
    if (sup(bw) > top) return pts;
  }
  pts.push([curve.at(-1)[0], top]);
  return pts;
}

// Bandwidth (GB/s) that `copies` copies of run w ask for when misses take L ns
export const demand = (w, est, copies) => L => copies * w.mpibw * LINE * w.ghz / (est.cpi0 + est.bf * w.mpi * L * w.ghz);

// The latency at which the supply of demand(L) gives back L
export function operatingPoint(supply, dem, floor) {
  let a = floor, b = 2 * floor;
  while (supply(dem(b)) > b) {
    b *= 2;
    if (b > 1e9) return { L: Infinity, bw: NaN };
  }
  for (let i = 0; i < 100; i++) {
    const m = (a + b) / 2;
    if (Math.min(supply(dem(m)), 1e12) > m) a = m; else b = m;
  }
  const L = (a + b) / 2;
  return { L, bw: dem(L) };
}

// Run w with BF and CPI0 `est` on memory `mem`. The run saw w.mp / w.ghz ns on a machine whose
// memory is unloadedNs when idle, and that ratio scales the target's unloaded latency.
export function predictOn(w, est, mem, unloadedNs, copies) {
  const offset = (w.mp / w.ghz / unloadedNs - 1) * mem.ns;
  const sup = bw => latencyAt(mem, bw) + offset, dem = demand(w, est, copies);
  const bound = !!(mem.peak || mem.curve);
  const L = bound ? operatingPoint(sup, dem, sup(0)).L : sup(0), bw = dem(L);
  // At the wall the CPI is copies x traffic / peak bandwidth, the same for every BF and CPI0
  const wall = bound && bw >= (mem.curve ? mem.curve.at(-1)[0] : WALL * mem.peak) * (1 - 1e-9);
  return { L, bw, cpi: est.cpi0 + est.bf * w.mpi * L * w.ghz, sup, dem, wall };
}
