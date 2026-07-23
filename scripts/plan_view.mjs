/**
 * plan_view.mjs — emit a top-down plan of a generated placement as drawable rects.
 *
 *   node plan_view.mjs <layout.json> <items.json> <out.json>
 *
 * Checking 170 objects through the editor viewport is slow and, at map scale,
 * mostly shows the nearest wall. A plan view of the authored footprints with the
 * placed ones drawn over them makes a wrong position or a quarter-turn obvious at
 * a glance. Coordinates come out in OVERDARE centimetres; the renderer scales.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [layoutPath, itemsPath, outPath] = process.argv.slice(2);
const layout = JSON.parse(readFileSync(layoutPath, "utf8"));
const items = JSON.parse(readFileSync(itemsPath, "utf8"));

const MAP = [
  "MAP_Wall", "MAP_Roads", "MAP_Ground", "MAP_Buildings", "MAP_Monuments",
  "MAP_Landmarks", "MAP_Vehicles", "MAP_Props",
  "ReichstagAsset", "HQ_Replacements", "Scene Collection",
];

// authored footprints, one rect per part (no clustering — this is the ground truth)
const authored = [];
for (const o of layout.objects) {
  if (!(o.coll || []).some((c) => MAP.includes(c))) continue;
  if (Math.max(o.dim_m[0], o.dim_m[1]) > 100) continue;      // skip ground slabs
  authored.push({
    x: o.ctr_m[0] * 100, z: o.ctr_m[1] * 100,
    w: Math.max(20, o.dim_m[0] * 100), d: Math.max(20, o.dim_m[1] * 100),
    yaw: 0,
  });
}

const placed = [];
for (const it of items) {
  const p = it.props ?? {};
  if (!p.position || !p.size) continue;
  if (Math.max(p.size[0], p.size[2]) > 10000) continue;      // skip ground slabs
  placed.push({
    x: p.position[0], z: p.position[2],
    w: p.size[0], d: p.size[2],
    yaw: p.orientation?.[1] ?? 0,
    mesh: it.className === "MeshPart",
    name: it.name,
  });
}

writeFileSync(outPath, JSON.stringify({ authored, placed }));
console.log(`plan: ${authored.length} authored parts, ${placed.length} placed -> ${outPath}`);
