/**
 * audit_layout.mjs — check a generated placement against the authored layout.
 *
 *   node audit_layout.mjs <layout.json> <items.json>
 *
 * Eyeballing 170 objects in the viewport is slow and misses things; the failures
 * that actually show up in-game are mechanical, so check them mechanically:
 * objects that float or sink, objects with no surface at all, and assets whose
 * footprint ends up nothing like the one the map was composed with.
 */
import { readFileSync } from "node:fs";

const layout = JSON.parse(readFileSync(process.argv[2], "utf8"));
const items = JSON.parse(readFileSync(process.argv[3], "utf8"));

const authored = new Map();               // key -> list of world bboxes, metres
for (const o of layout.objects) {
  const key = o.name.split("__")[0].replace(/\.[0-9]{3}$/, "");
  (authored.get(key) ?? authored.set(key, []).get(key)).push(o);
}

const problems = { untextured: [], floating: [], sunk: [], oversized: [], flat: [] };

for (const it of items) {
  const p = it.props ?? {};
  const [, , ] = p.position ?? [];
  const size = p.size ?? [0, 0, 0];
  const base = (p.position?.[1] ?? 0) - size[1] / 2;

  if (it.className === "MeshPart" && !p.raw?.TextureId && !p.color) {
    problems.untextured.push(it.name);
  }
  if (size.some((v) => v < 5)) problems.flat.push(`${it.name} ${size.join("x")}`);
  if (Math.max(...size) > 12000) problems.oversized.push(`${it.name} ${size.join("x")}`);
  if (base > 400) problems.floating.push(`${it.name} base=${Math.round(base)}`);
  if (base < -400) problems.sunk.push(`${it.name} base=${Math.round(base)}`);
}

// Which authored assets never made it into the scene at all.
const placed = new Set(items.map((i) => i.name.replace(/_\d+$/, "")));
const missing = [...authored.keys()].filter((k) => {
  const short = k.replace(/^(HQ_|DDR_|WB_)/, "");
  return !placed.has(short) && !placed.has(k);
});

const yaws = {};
for (const it of items) {
  const y = it.props?.orientation?.[1] ?? 0;
  const n = it.name.replace(/_\d+$/, "");
  (yaws[n] ??= []).push(Math.round(y));
}

console.log(`items ${items.length}`);
for (const [k, v] of Object.entries(problems)) {
  if (v.length) console.log(`\n${k} (${v.length}): ${v.slice(0, 25).join(", ")}`);
}
console.log(`\nauthored keys with no placement (${missing.length}): ${missing.join(", ")}`);
console.log(`\nyaw by asset:`);
for (const [k, v] of Object.entries(yaws)) console.log(`  ${k}: ${[...new Set(v)].join(", ")}`);
