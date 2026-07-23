/**
 * diff_layout.mjs — what the authored Blender map contains that the port does not.
 *
 *   node diff_layout.mjs <layout.json> <layout_to_overdare.mjs> <convertedRoot>
 *
 * Groups the authored objects into asset instances the same way the generator does,
 * subtracts the asset types the generator knows how to place, and for each missing
 * type reports whether a converted FBX exists to import.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [layoutPath, genPath, convRoot] = process.argv.slice(2);
const doc = JSON.parse(readFileSync(layoutPath, "utf8"));
const gen = readFileSync(genPath, "utf8");

const MAP = [
  "MAP_Wall", "MAP_Roads", "MAP_Ground", "MAP_Buildings", "MAP_Monuments",
  "MAP_Landmarks", "MAP_Vehicles", "MAP_Props",
  "ReichstagAsset", "HQ_Replacements", "Scene Collection",
];

// --- authored instances -------------------------------------------------------
const groups = {};
for (const o of doc.objects) {
  if (!(o.coll || []).some((c) => MAP.includes(c))) continue;
  const inst = o.name.split("__")[0];
  const key = inst.replace(/\.[0-9]{3}$/, "");
  const id = `${key}|${inst}`;
  const lo = [0, 1, 2].map((i) => o.ctr_m[i] - o.dim_m[i] / 2);
  const hi = [0, 1, 2].map((i) => o.ctr_m[i] + o.dim_m[i] / 2);
  groups[id] ??= { key, lo: lo.slice(), hi: hi.slice() };
  const g = groups[id];
  for (let i = 0; i < 3; i++) { g.lo[i] = Math.min(g.lo[i], lo[i]); g.hi[i] = Math.max(g.hi[i], hi[i]); }
}
const byKey = {};
for (const g of Object.values(groups)) {
  const dim = [0, 1, 2].map((i) => +(g.hi[i] - g.lo[i]).toFixed(2));
  (byKey[g.key] ??= { count: 0, dim }).count++;
}

// --- what the generator already handles --------------------------------------
const handled = new Set();
for (const m of gen.matchAll(/(\w+)\s*:\s*"(?:wall|tower|hedgehog|lamp|trabant|truck|jeep|bench|bin|tree|gate|altbau|housing|kaufhalle|lenin|memorial|trafficlt|busstop|vending|mailbox|hydrant|scooter|barrier|tvtower|reichstag|victory|school|crane|ferris|lada|kino|palast|tram|ikarus)"/g)) {
  handled.add(m[1]);
}
for (const m of gen.matchAll(/^\s{2}(\w+):\s*\{\s*color/gm)) handled.add(m[1]);          // SURFACE entries
for (const m of gen.matchAll(/"(\w+)"/g)) if (/^(cwc|cwg)\d$|c$/.test(m[1])) handled.add(m[1]);
for (const k of ["Vorder_0", "Vorder_1", "Vorder_2", "Hinter_0", "Hinter_1", "Hinter_2"]) handled.add(k);

// --- converted library --------------------------------------------------------
const library = [];
(function scan(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) scan(p);
    else if (n.endsWith("_overdare.fbx")) library.push({ name: n.replace("_overdare.fbx", ""), path: p, mb: +(statSync(p).size / 1048576).toFixed(2) });
  }
})(convRoot);

const norm = (s) => s.toLowerCase().replace(/^(hq_|ddr_|prop_|wall_|eb_|wb_|gdr_|landmark_|cp_|road_)/, "").replace(/[^a-z0-9]/g, "");
function findAsset(key) {
  const k = norm(key);
  return library.find((f) => norm(f.name) === k)
      || library.find((f) => norm(f.name).includes(k) || k.includes(norm(f.name)));
}

const missing = Object.entries(byKey)
  .filter(([k]) => !handled.has(k))
  .sort((a, b) => b[1].count - a[1].count);

console.log(`authored asset types: ${Object.keys(byKey).length}  |  handled: ${Object.keys(byKey).length - missing.length}  |  MISSING: ${missing.length}`);
console.log(`missing instances: ${missing.reduce((s, [, v]) => s + v.count, 0)}\n`);
console.log("type".padEnd(26), "inst".padStart(4), "  dim(m)".padEnd(22), "converted asset");
for (const [k, v] of missing) {
  const a = findAsset(k);
  console.log(
    "  " + k.padEnd(24),
    String(v.count).padStart(4),
    ("  " + v.dim.join(" x ")).padEnd(24),
    a ? `${a.name} (${a.mb}MB)` : "— 없음",
  );
}
