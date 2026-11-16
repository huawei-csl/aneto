// Small SVG plotting helpers: scales, axes and marks.
const NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// At most one decimal, so no number claims more accuracy than the model has
export function fmt(v) {
  if (!Number.isFinite(v)) return "n/a";
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1);
}
export const tick = v => String(+v.toPrecision(6));
// The first of 1, 2, 2.5, 5 and 10 times a power of ten at or above v: the top of an axis from 0
export function roundUp(v) {
  const e = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(k => k * e).find(k => k >= v);
}

function niceTicks(a, b, n) {
  const raw = (b - a) / n, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
  const step = (r >= 7.5 ? 10 : r >= 3.5 ? 5 : r >= 1.5 ? 2 : 1) * mag;
  const t = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) t.push(+v.toPrecision(10));
  return t;
}

export function linear(d, r) {
  const f = v => r[0] + (v - d[0]) / (d[1] - d[0]) * (r[1] - r[0]);
  f.invert = p => d[0] + (p - r[0]) / (r[1] - r[0]) * (d[1] - d[0]);
  f.ticks = (n = 5) => niceTicks(d[0], d[1], n);
  f.domain = d;
  return f;
}

export function log(d, r) {
  const l0 = Math.log(d[0]), l1 = Math.log(d[1]);
  const f = v => r[0] + (Math.log(v) - l0) / (l1 - l0) * (r[1] - r[0]);
  f.invert = p => Math.exp(l0 + (p - r[0]) / (r[1] - r[0]) * (l1 - l0));
  f.ticks = () => {
    const t = [];
    for (let e = Math.floor(Math.log10(d[0])); e <= Math.ceil(Math.log10(d[1])); e++)
      for (const m of [1, 2, 5]) { const v = +(m * 10 ** e).toPrecision(6); if (v >= d[0] && v <= d[1]) t.push(v); }
    return t.length > 8 ? t.filter(v => /^1/.test(v.toExponential())) : t;
  };
  f.domain = d;
  return f;
}

// A chart: a responsive SVG with a plot area inside margins, a layer for axes and one for marks
export class Chart {
  constructor(host, { w = 560, h = 360, m = { l: 62, r: 18, t: 16, b: 52 }, label = "" } = {}) {
    host.innerHTML = "";
    this.svg = el("svg", { viewBox: `0 0 ${w} ${h}`, class: "chart", role: "group", "aria-label": label }, host);
    this.w = w; this.h = h; this.m = m;
    // Legends and controls under the plot center on the plot area, under the x-axis title (style.css)
    host.parentElement?.style.setProperty("--plot-shift", `${((m.l - m.r) / w) * 100}%`);
    this.x0 = m.l; this.x1 = w - m.r; this.y0 = h - m.b; this.y1 = m.t;
    el("defs", {}, this.svg).innerHTML =
      `<clipPath id="${(this.clip = "c" + Math.random().toString(36).slice(2))}">` +
      `<rect x="${this.x0}" y="${this.y1}" width="${this.x1 - this.x0}" height="${this.y0 - this.y1}"/></clipPath>`;
    this.grid = el("g", { class: "grid" }, this.svg);
    this.axes = el("g", { class: "axes" }, this.svg);
    this.marks = el("g", { "clip-path": `url(#${this.clip})` }, this.svg);
    this.top = el("g", {}, this.svg);
  }

  scales(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  // Axes with ticks and labels. xlabel/ylabel may hold SVG markup (for italic symbols).
  frame({ xlabel = "", ylabel = "", xfmt = tick, yfmt = tick, xticks, yticks } = {}) {
    this.grid.innerHTML = "";
    this.axes.innerHTML = "";
    for (const v of yticks || this.y.ticks()) {
      const py = this.y(v);
      el("line", { x1: this.x0, x2: this.x1, y1: py, y2: py }, this.grid);
      el("text", { x: this.x0 - 8, y: py + 5, "text-anchor": "end", class: "tick" }, this.axes).textContent = yfmt(v);
    }
    for (const v of xticks || this.x.ticks()) {
      const px = this.x(v);
      el("text", { x: px, y: this.y0 + 22, "text-anchor": "middle", class: "tick" }, this.axes).textContent = xfmt(v);
    }
    el("path", { d: `M${this.x0},${this.y1}V${this.y0}H${this.x1}`, class: "axis" }, this.axes);
    el("text", { x: (this.x0 + this.x1) / 2, y: this.h - 8, "text-anchor": "middle", class: "label" }, this.axes).innerHTML = xlabel;
    el("text", { transform: `translate(16,${(this.y0 + this.y1) / 2}) rotate(-90)`, "text-anchor": "middle", class: "label" },
      this.axes).innerHTML = ylabel;
    return this;
  }

  clear() {
    this.marks.innerHTML = "";
    this.top.innerHTML = "";
  }

  // A polyline through data points; points outside a log domain are skipped
  line(pts, attrs = {}, layer = this.marks) {
    const d = pts.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
      .map(([a, b], i) => `${i ? "L" : "M"}${this.x(a).toFixed(1)},${this.y(b).toFixed(1)}`).join("");
    return d ? el("path", { d, fill: "none", ...attrs }, layer) : null;
  }

  dot(a, b, r, attrs = {}, layer = this.marks) {
    return el("circle", { cx: this.x(a), cy: this.y(b), r, ...attrs }, layer);
  }

  text(a, b, s, attrs = {}, layer = this.top) {
    const t = el("text", { x: this.x(a), y: this.y(b), ...attrs }, layer);
    t.textContent = s;
    return t;
  }

  // Pointer position in data coordinates
  pointer(ev) {
    const p = this.svg.createSVGPoint();
    p.x = ev.clientX;
    p.y = ev.clientY;
    const q = p.matrixTransform(this.svg.getScreenCTM().inverse());
    return [this.x.invert(q.x), this.y.invert(q.y)];
  }
}

// The BF colour scale: blue (low) to grey to the accent red (high)
const STOPS = [[0x2f, 0x6d, 0xb5], [0xb8, 0xb8, 0xb8], [0xc7, 0x00, 0x0b]];
export function bfColor(t) {
  const u = Math.max(0, Math.min(1, t)) * 2, i = Math.min(1, Math.floor(u)), f = u - i;
  const c = STOPS[i].map((v, k) => Math.round(v + f * (STOPS[i + 1][k] - v)));
  return `rgb(${c.join(",")})`;
}
