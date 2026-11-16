// The machines page: one card per shipped calibration, from data/machines.js.
import data from "../data/machines.js";
import { addCopyButtons } from "./copy.js";

const $ = s => document.querySelector(s);
const one = v => (Math.round(v * 10) / 10).toFixed(1);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function card(m) {
  const c = m.conditions, id = m.identity, rows = [];
  if (id) rows.push(["Identity", `${esc(id.vendor)}, family ${id.family}, model ${id.model}, name contains ${esc(id.name)}`]);
  if (c) {
    rows.push(["Clock", `${c.ghz.toFixed(2)} GHz fixed, governor ${esc(c.governor)}, boost ${c.boost ? "on" : "off"}`]);
    rows.push(["Pinned CPU", String(c.cpu)]);
    rows.push(["Sweep clocks", `${c.sweep_ghz.map(g => g.toFixed(2)).join(", ")} GHz`]);
    const extra = [...(c.kernel_args || []).map(a => `kernel argument <code>${esc(a)}</code>`),
      ...Object.entries(c.sysfs || {}).map(([p, v]) => `<code>${esc(p)}</code> = ${esc(v)}`), ...(c.notes || []).map(esc)];
    if (extra.length) rows.push(["Other conditions", extra.join("<br>")]);
  } else {
    rows.push(["Sweep", "DRAM latency, fixed core clock"]);
  }
  rows.push(["Workloads", `${m.workloads.length} kept, ${m.excluded} excluded`]);
  rows.push(["Unloaded latency", `${Math.round(m.unloaded_ns)} ns`]);
  const errs = data.technologies.map(t => `<tr><td>${esc(t.name)}</td><td>${t.ns}</td><td>${one(m.errors[t.name][0])}</td><td>${one(m.errors[t.name][1])}</td></tr>`).join("");
  const recipe = m.recipe ? `<details><summary>Counter recipe</summary><pre>${esc(JSON.stringify(m.recipe, null, 1))}</pre></details>` : "";
  return `<section class="machine">
    <h2>${esc(m.label)} <code>${esc(m.id)}</code></h2>
    <p class="sub">${esc(m.machine)}${m.memory ? `, ${esc(m.memory)}` : ""}, ${m.kind}</p>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <table class="errs"><tr><th>Target</th><th>ns</th><th>P50 %</th><th>P90 %</th></tr>${errs}</table>
    ${recipe}
  </section>`;
}

$("#summary").textContent = `${data.machines.length} calibrations.`;
$("#machines").innerHTML = data.machines.map(card).join("");
addCopyButtons($("#machines"));
