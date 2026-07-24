/**
 * layout_from_blend.mjs — build a placement layout straight from the authored .blend.
 *
 *   node layout_from_blend.mjs <blend_layout.json> <manifest.json> > layout.json
 *
 * The map was composed in Blender, so the authored scene — not a generated guess —
 * is the ground truth for where every asset sits. dump_layout.py reports each object
 * with its centre and dimensions in Blender metres; objects belonging to one placed
 * copy share a "<Asset>.<NNN>" prefix, so grouping by that prefix recovers the
 * instances. Emitting each instance's own bounding box as the layout size makes the
 * downstream scale exactly 1, which is the point: reproduce the original, don't rescale it.
 *
 * Blender is Z-up/metres, OVERDARE is Y-up/centimetres: (X, Y, Z) = (x, z, y) * 100.
 */
import { readFileSync } from "node:fs";

const [layoutPath, manifestPath] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(layoutPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// place_rebuild keys its layout by the short names below; invert that table so an
// authored object name can be turned back into the name the placer expects.
const LAYOUT_TO_MANIFEST = {
  Trabant: "HQ_Trabant", Lada: "HQ_Lada", GAZ53: "HQ_GAZ53", UAZ: "HQ_UAZ",
  Ikarus280: "HQ_Ikarus280", Bicycle: "HQ_Bicycle", T34: "HQ_T34", Bench: "HQ_Bench",
  TrashBin: "HQ_TrashBin", StreetLamp: "HQ_StreetLamp", TrafficLight: "HQ_TrafficLight",
  BusShelter: "HQ_BusShelter", Vending: "HQ_Vending", Mailbox: "HQ_Mailbox",
  FireHydrant: "HQ_FireHydrant", CzechHedgehog: "HQ_CzechHedgehog", FoodCart: "HQ_FoodCart",
  Watchtower: "DDR_Watchtower", Barrier: "DDR_Barrier", BrandenburgGate: "HQ_BrandenburgGate",
  Reichstag: "HQ_Reichstag", Fernsehturm_AI: "HQ_Fernsehturm_AI", School: "HQ_School",
  TowerCrane: "HQ_TowerCrane", FerrisWheel: "HQ_FerrisWheel", Church: "HQ_Church",
  Factory: "HQ_Factory", Plattenbau1: "HQ_Plattenbau1", Plattenbau2: "HQ_Plattenbau2",
  Lenin: "HQ_Lenin", EastHousing_AI: "HQ_EastHousing_AI", WB_Altbau: "WB_Altbau",
  WB_Stadium: "WB_Stadium", PROP_Scooter_A: "PROP_Scooter_A", PROP_TramTatraT3_A: "PROP_TramTatraT3_A",
};
const manifestToLayout = {};
for (const [k, v] of Object.entries(LAYOUT_TO_MANIFEST)) manifestToLayout[v] = k;

/** "HQ_Lada.001__005" -> {asset:"HQ_Lada", copy:"001"}; the first copy carries no .NNN. */
function parseName(raw) {
  const noPart = String(raw).replace(/__\d+$/, "").replace(/_cv.*$/, "");
  const m = noPart.match(/^(.*?)\.(\d+)$/);
  return m ? { asset: m[1], copy: m[2] } : { asset: noPart.replace(/_$/, ""), copy: "000" };
}

// Union each placed copy's parts into one bounding box, and keep the yaw the authored
// object reports — a copy's parts all share it.
const insts = {};
for (const o of dump.objects) {
  const { asset, copy } = parseName(o.name);
  if (!manifestToLayout[asset] || !manifest[asset]) continue;
  const key = `${asset}#${copy}`;
  const e = (insts[key] ??= { asset, min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], yaw: o.yaw ?? 0, n: 0 });
  for (let a = 0; a < 3; a++) {
    e.min[a] = Math.min(e.min[a], o.ctr_m[a] - o.dim_m[a] / 2);
    e.max[a] = Math.max(e.max[a], o.ctr_m[a] + o.dim_m[a] / 2);
  }
  e.n++;
}

const items = [];
const perAsset = {};
for (const e of Object.values(insts)) {
  const lname = manifestToLayout[e.asset];
  const ctr = [0, 1, 2].map((a) => (e.min[a] + e.max[a]) / 2);
  const dim = [0, 1, 2].map((a) => e.max[a] - e.min[a]);
  if (dim.some((d) => !(d > 0))) continue;              // degenerate, nothing to place
  const n = (perAsset[lname] = (perAsset[lname] ?? 0) + 1);
  items.push({
    className: "MeshPart",
    name: `${lname}_${String(n).padStart(3, "0")}`,
    props: {
      // Blender (x, y, z) -> OVERDARE (x, z, y), metres -> centimetres.
      position: [Math.round(ctr[0] * 100), Math.round(ctr[2] * 100), Math.round(ctr[1] * 100)],
      size: [
        Math.round(dim[0] * 100 * 10) / 10,
        Math.round(dim[2] * 100 * 10) / 10,
        Math.round(dim[1] * 100 * 10) / 10,
      ],
      anchored: true,
      ...(e.yaw ? { orientation: [0, e.yaw, 0] } : {}),
    },
  });
}

console.error(
  `instances ${items.length} across ${Object.keys(perAsset).length} assets: ` +
    Object.entries(perAsset).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", "),
);
console.log(JSON.stringify(items));
