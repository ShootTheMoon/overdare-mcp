/**
 * layout_to_overdare.mjs — turn a Blender-authored layout dump into OVERDARE
 * instance definitions.
 *
 *   node layout_to_overdare.mjs <layout.json> [batchIndex]
 *
 * Reads the MAP_* collections produced by dump_layout.py, groups the multi-part
 * meshes back into asset instances, maps each authored asset onto an imported
 * OVERDARE mesh, and prints the `items` array for overdare_create_instances.
 *
 * Blender is Z-up/metres, OVERDARE is Y-up/centimetres:  (X, Y, Z) = (bx, bz, by).
 * Long thin authored pieces (walls, roads) become tiled runs of their mesh so the
 * texture is not stretched — scaling a MeshPart stretches the mesh itself.
 */
import { readFileSync } from "node:fs";

const layoutPath = process.argv[2];
const batch = process.argv[3] && process.argv[3] !== "all" ? Number(process.argv[3]) : null;
const overridePath = process.argv[4];        // optional slot -> {mesh,tex,nat} table
const doc = JSON.parse(readFileSync(layoutPath, "utf8"));

// The authored scene keeps its detailed landmarks and high-quality vehicle
// replacements outside the MAP_* groups, but they sit at real map coordinates —
// leaving them out is what made the port feel empty.
const MAP = [
  "MAP_Wall", "MAP_Roads", "MAP_Ground", "MAP_Buildings", "MAP_Monuments",
  "MAP_Landmarks", "MAP_Vehicles", "MAP_Props",
  "ReichstagAsset", "HQ_Replacements", "Scene Collection",
];

// --- regroup parts into physical instances -----------------------------------
// Instance names are not reliable: some assets keep several copies under one name
// with the parts simply scattered across the map. Placing by name then puts a
// single object at the centroid of all copies — the wrong spot, and one where
// there should be several. Cluster the parts by proximity instead.
const byKey = {};
for (const o of doc.objects) {
  if (!(o.coll || []).some((c) => MAP.includes(c))) continue;
  const key = o.name.split("__")[0].replace(/\.[0-9]{3}$/, "");
  (byKey[key] ??= []).push(o);
}

function clusterParts(parts) {
  const span = Math.max(...parts.map((p) => Math.max(p.dim_m[0], p.dim_m[1])));
  const reach = Math.max(3, span * 1.2);        // parts of one object sit this close
  const parent = parts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const dx = parts[i].ctr_m[0] - parts[j].ctr_m[0];
      const dy = parts[i].ctr_m[1] - parts[j].ctr_m[1];
      if (Math.hypot(dx, dy) <= reach) parent[find(i)] = find(j);
    }
  }
  const out = new Map();
  parts.forEach((p, i) => {
    const r = find(i);
    if (!out.has(r)) out.set(r, []);
    out.get(r).push(p);
  });
  return [...out.values()];
}

const instances = [];
for (const [key, parts] of Object.entries(byKey)) {
  const clusters = clusterParts(parts);
  // Some assets leave a stray leaf part sitting off on its own — a 10 cm sliver of
  // the food cart, metres from the cart. Clustering hands that back as its own
  // "copy", and placing the full mesh on it drops a whole second cart in mid-air.
  // Anything far smaller than the biggest cluster is scrap, not a copy.
  const diag = (c) => {
    const lo = [0, 1].map((i) => Math.min(...c.map((p) => p.ctr_m[i] - p.dim_m[i] / 2)));
    const hi = [0, 1].map((i) => Math.max(...c.map((p) => p.ctr_m[i] + p.dim_m[i] / 2)));
    return Math.hypot(hi[0] - lo[0], hi[1] - lo[1]);
  };
  const biggest = Math.max(...clusters.map(diag));
  for (const cluster of clusters) {
    if (clusters.length > 1 && diag(cluster) < biggest * 0.25) continue;
    const lo = [0, 1, 2].map((i) => Math.min(...cluster.map((p) => p.ctr_m[i] - p.dim_m[i] / 2)));
    const hi = [0, 1, 2].map((i) => Math.max(...cluster.map((p) => p.ctr_m[i] + p.dim_m[i] / 2)));
    // the biggest footprint is the body of the thing; its axis is the one to face
    const body = cluster.reduce((a, b) =>
      a.dim_m[0] * a.dim_m[1] >= b.dim_m[0] * b.dim_m[1] ? a : b);
    instances.push({
      key,
      ctr: [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2),
      dim: [0, 1, 2].map((i) => hi[i] - lo[i]),
      baseZ: lo[2],
      yaw: typeof body.yaw === "number" ? body.yaw : null,
      skew: typeof body.skew === "number" ? body.skew : null,
    });
  }
}

// export_asset.py exports one copy of each asset — the instance name with the most
// parts, ties to the lowest-numbered — so THAT copy's angle is the resting angle of
// the imported mesh. Every other copy is a rotation away from it. Measuring against
// an absolute axis instead assumes the exported copy happened to be axis-aligned,
// and when it was not, every copy of that asset came out turned the same wrong way.
const refYaw = {};
const refSkew = {};
for (const [key, parts] of Object.entries(byKey)) {
  const groups = {};
  for (const p of parts) (groups[p.name.split("__")[0]] ??= []).push(p);
  const pick = Object.keys(groups).sort(
    (x, y) => groups[y].length - groups[x].length || (x < y ? -1 : 1))[0];
  const body = groups[pick].reduce((a, b) =>
    a.dim_m[0] * a.dim_m[1] >= b.dim_m[0] * b.dim_m[1] ? a : b);
  refYaw[key] = typeof body.yaw === "number" ? body.yaw : 0;
  refSkew[key] = typeof body.skew === "number" ? body.skew : 0;
}

// A principal axis is a line, so it cannot tell a car from the same car turned
// around — which is why so many props sat in the right place facing backwards.
// The third moment along that axis can: one end of a model is bulkier than the
// other, so the sign of the skew belongs to the model, and a copy whose sign
// disagrees with the exported reference is half a turn away from it. Below this
// magnitude the body really is symmetric end-to-end and 180 makes no difference.
const SKEW_MIN = 0.15;

/**
 * Which way an asset should face, in OVERDARE degrees.
 *
 * dump_layout measures each authored object's principal axis, because the .blend
 * bakes placement into the vertices and every object transform reads zero. Blender
 * measures that angle in its XY plane and OVERDARE's yaw turns the other way, so
 * the sign flips. The imported mesh has its own resting direction — some models
 * lie along X, some along Z — and that decides the extra quarter turn.
 */
function faceYaw(inst, a, authored, aspect) {
  // A hardcoded yaw is calibrated against a particular library mesh. Once the same
  // asset is re-imported from the .blend its resting direction changes, and the old
  // override then turns it the wrong way.
  if (a.yaw != null && !a.blend) return a.yaw;
  if (typeof inst.yaw === "number") {
    const ref = a.blend ? (refYaw[inst.key] ?? 0) : 0;
    let yaw = -(inst.yaw - ref) + (a.yawOff ?? 0);

    // Same asset, opposite ends heavy => this copy is the reference turned around.
    if (a.blend) {
      const s = inst.skew, r = refSkew[inst.key];
      if (typeof s === "number" && typeof r === "number" &&
          Math.abs(s) >= SKEW_MIN && Math.abs(r) >= SKEW_MIN &&
          Math.sign(s) !== Math.sign(r)) {
        yaw += 180;
      }
    }
    yaw = ((yaw % 360) + 360) % 360;

    // A library mesh has no authored twin, so nothing ties its resting direction to
    // the map's. Lay it along the same axis the authored footprint runs along —
    // otherwise a 13 m bus ends up parked across the road instead of down it.
    if (!a.blend) {
      const longX = authored[0] > authored[2];
      const turned = Math.abs(Math.round(yaw / 90) % 2) === 1;
      const meshLongX = (turned ? a.nat[2] > a.nat[0] : a.nat[0] > a.nat[2]);
      const elongated = aspect(Math.max(authored[0], authored[2]), Math.min(authored[0], authored[2])) > 1.3 &&
                        aspect(Math.max(a.nat[0], a.nat[2]), Math.min(a.nat[0], a.nat[2])) > 1.3;
      if (elongated && meshLongX !== longX) yaw = (yaw + 90) % 360;
    }

    // A principal axis only means something for an elongated footprint. A tower,
    // a hydrant or a Czech hedgehog is near-square, so the measured angle is
    // noise — that is what left buildings standing at 61 degrees. Square things
    // snap outright; long things snap only when they were authored near an axis,
    // so a car genuinely parked on a diagonal keeps its angle.
    const square = aspect(Math.max(authored[0], authored[2]), Math.min(authored[0], authored[2])) < 1.2;
    const snapped = Math.round(yaw / 90) * 90;
    if (square || Math.abs(yaw - snapped) <= 15) yaw = ((snapped % 360) + 360) % 360;
    return yaw;
  }
  const wantsTurn =
    Math.max(aspect(authored[0], authored[2]), aspect(authored[2], authored[0])) > 1.3 &&
    aspect(authored[0], authored[2]) > 1 !== aspect(a.nat[0], a.nat[2]) > 1;
  return wantsTurn ? 90 : 0;
}

// --- imported OVERDARE meshes ------------------------------------------------
const M = {
  wall:      { mesh: "39150200", tex: "39151100", nat: [120, 361.81, 57.81] },
  tower:     { mesh: "39153100", tex: null,       nat: [467.9, 1015.3, 467.9] },
  hedgehog:  { mesh: "39159100", tex: null,       nat: [177.8, 156.8, 168.7] },
  lamp:      { mesh: "39195400", tex: null,       nat: [72.9, 500, 32.9] },
  trabant:   { mesh: "39206100", tex: "39208100", nat: [150.8, 144.4, 355] },
  truck:     { mesh: "39238100", tex: "39234700", nat: [246.7, 240.3, 640] },
  jeep:      { mesh: "39208200", tex: "39208300", nat: [176.8, 208.5, 400] },
  bench:     { mesh: "39202200", tex: "39202300", nat: [180, 104.5, 101.7] },
  bin:       { mesh: "39203100", tex: "39200500", nat: [95, 73.6, 64.5] },
  tree:      { mesh: "39199100", tex: "39201100", nat: [596, 800, 606.2] },
  // Imported at real-world scale (65 m wide); the authored map uses a 34 m game
  // version, so scale uniformly by 0.523 and turn it to face along the wall.
  gate:      { mesh: "39234300", tex: "39235800", nat: [3400, 1517, 1642], yaw: 90 },
  altbau:    { mesh: "39236100", tex: "39227700", nat: [2100, 2751.9, 1479.7] },
  housing:   { mesh: "39227500", tex: null,       nat: [2680, 2375, 1480] },
  kaufhalle: { mesh: "39234100", tex: null,       nat: [2460, 570, 1472.5] },
  lenin:     { mesh: "39234800", tex: "39235000", nat: [296, 548.1, 323.3] },
  memorial:  { mesh: "39240500", tex: "39233200", nat: [546.9, 454.1, 241.1] },
  // Assets whose source FBX carries no baked texture render with raw vertex
  // colours (a mottled camo look), so give them a plain colour + material instead.
  tower:     { mesh: "39153100", tex: null, nat: [467.9, 1015.3, 467.9], color: [124, 116, 96], mat: "Wood" },
  lamp:      { mesh: "39195400", tex: null, nat: [72.9, 500, 32.9], color: [46, 48, 50], mat: "Metal" },
  hedgehog:  { mesh: "39159100", tex: null, nat: [177.8, 156.8, 168.7], color: [86, 86, 82], mat: "Metal" },
  housing:   { mesh: "39227500", tex: null, nat: [2680, 2375, 1480], color: [176, 170, 156], mat: "Concrete" },
  trafficlt: { mesh: "39246100", tex: null, nat: [26, 375, 34.6], color: [52, 54, 52], mat: "Metal" },
  busstop:   { mesh: "39247200", tex: null, nat: [423.8, 300, 213.1], color: [120, 126, 128], mat: "Metal" },
  vending:   { mesh: "39249100", tex: null, nat: [61, 196, 54], color: [140, 60, 52], mat: "Metal" },
  mailbox:   { mesh: "39250200", tex: null, nat: [50, 168.1, 38.5], color: [150, 130, 40], mat: "Metal" },
  hydrant:   { mesh: "39250400", tex: null, nat: [38, 97.5, 39], color: [130, 40, 36], mat: "Metal" },
  scooter:   { mesh: "39246500", tex: "39246700", nat: [89.4, 143.2, 179.9] },
  barrier:   { mesh: "39251100", tex: "39251300", nat: [200, 90, 57.9] },
  // 368 m tall as imported — the authored map uses a 130 m game-scale version,
  // so shrink uniformly rather than squashing it to the authored bounding box.
  tvtower:   { mesh: "39250600", tex: null, nat: [1180, 13000, 1180], color: [196, 196, 192], mat: "Concrete" },
  reichstag: { mesh: "39257100", tex: null, nat: [5100, 2900, 3280], color: [198, 192, 180], mat: "Concrete" },
  victory:   { mesh: "39257300", tex: null, nat: [2778.9, 6602.6, 2799.3], color: [178, 168, 132], mat: "Marble" },
  school:    { mesh: "39261100", tex: null, nat: [3640, 1180, 1860], color: [206, 198, 178], mat: "Concrete" },
  crane:     { mesh: "39257400", tex: null, nat: [2606.4, 2827.4, 400], color: [214, 158, 54], mat: "Metal" },
  ferris:    { mesh: "39259300", tex: null, nat: [1670, 1717.5, 400], color: [182, 184, 188], mat: "Metal" },
  lada:      { mesh: "39262300", tex: null, nat: [176.5, 142.8, 410], color: [116, 128, 140], mat: "Metal" },
  kino:      { mesh: "39260200", tex: null, nat: [3580, 1470, 1800], color: [202, 196, 184], mat: "Concrete" },
  palast:    { mesh: "39265100", tex: null, nat: [5100, 1875, 3100], color: [148, 158, 170], mat: "Metal" },
  tram:      { mesh: "39252100", tex: null, nat: [275.8, 486.9, 1400], color: [188, 168, 60], mat: "Metal" },
  ikarus:    { mesh: "39272100", tex: "39274100", nat: [293.6, 317.3, 1650] },
  // Imported with "Import Only as Model" cleared, so these carry their textures.
  church:    { mesh: "39319100", tex: "39319300", nat: [1294.9, 2840, 2950] },
  factory:   { mesh: "39319400", tex: "39323100", nat: [2820, 2000, 1620] },
  platten:   { mesh: "39323200", tex: "39323500", nat: [3040, 1560, 1340] },
  plattentw: { mesh: "39321200", tex: "39322800", nat: [1430, 4420, 1585] },
  // The pre-exported FBX ships a 1,144-triangle stand-in; this one comes straight
  // out of the .blend's HQ_Replacements collection at 28k — 25x the detail.
  t34:       { mesh: "39331100", tex: "39332400", nat: [682.9, 233.4, 323.7] },
  bicycle:   { mesh: "39325300", tex: "39326000", nat: [151.9, 85.7, 48.6] },
};

// Asset ids change every time something is re-imported, so let a generated table
// override the defaults instead of hand-editing ids into this file.
if (overridePath) {
  try {
    const over = JSON.parse(readFileSync(overridePath, "utf8"));
    for (const [slot, v] of Object.entries(over)) M[slot] = { ...(M[slot] ?? {}), ...v };
    // The Victory Column is a photogrammetry scan: a million triangles reduced to
    // fit the 30k budget, which leaves its UVs in shreds, and Blender's FBX export
    // drops its texture besides. Baking into those UVs produced a white surface
    // full of unbaked holes — worse than no texture. Its own flat stone colour
    // reads correctly at the distance it is actually seen from.
    if (M.victory) M.victory = { ...M.victory, tex: null };
  } catch {
    /* no override table yet */
  }
}

// authored asset -> imported mesh
const ASSET = {
  DDR_Watchtower: "tower", HQ_CzechHedgehog: "hedgehog", HQ_StreetLamp: "lamp",
  HQ_Trabant: "trabant", HQ_Lada: "lada", HQ_GAZ53: "truck", HQ_UAZ: "jeep",
  HQ_Bench: "bench", HQ_TrashBin: "bin", HQ_BrandenburgGate: "gate",
  WB_Altbau: "altbau", HQ_EastHousing_AI: "housing", Lenin_Plinth: "lenin",
  HQ_Ikarus280: "ikarus", HQ_Church: "church", HQ_Factory: "factory",
  HQ_Plattenbau1: "platten", HQ_Plattenbau2: "plattentw", HQ_T34: "t34",
  HQ_Bicycle: "bicycle", HQ_Palast: "palast", HQ_SovietMemorial: "memorial",
  HQ_Lenin: "lenin", WB_Stadium: "stadium",
  HQ_Reichstag: "reichstag", HQ_VictoryColumn: "victory", HQ_School: "school",
  HQ_TowerCrane: "crane", HQ_FerrisWheel: "ferris", PROP_TramTatraT3_A: "tram",
  HQ_KinoInternational: "kino", HQ_PalastDerRepublik: "palast",
  HQ_TrafficLight: "trafficlt", TLpole_0: "trafficlt", TLpole_1: "trafficlt", TLpole_2: "trafficlt",
  HQ_BusShelter: "busstop", HQ_Vending: "vending", HQ_Mailbox: "mailbox",
  HQ_FoodCart: "foodcart",
  HQ_FireHydrant: "hydrant", PROP_Scooter_A: "scooter", DDR_Barrier: "barrier",
  HQ_Fernsehturm_AI: "tvtower",
};

// flat ground / road planes become coloured Parts — Parts scale without distortion
const SURFACE = {
  GND_BASE:      { color: [92, 94, 88],    h: 20 },
  GND_WestGrass: { color: [104, 112, 88],  h: 24 },
  GND_East:      { color: [96, 96, 92],    h: 24 },
  GND_Strip:     { color: [198, 182, 142], h: 28 },
  GND_Patrol:    { color: [138, 136, 130], h: 30 },
  Axis:       { color: [58, 58, 60], h: 32 }, Checkpoint: { color: [58, 58, 60], h: 32 },
  KMA:        { color: [58, 58, 60], h: 32 }, Ebert0:     { color: [58, 58, 60], h: 32 },
  EastA0:     { color: [58, 58, 60], h: 32 }, EastB0:     { color: [58, 58, 60], h: 32 },
  EastC0:     { color: [58, 58, 60], h: 32 }, WestA0:     { color: [58, 58, 60], h: 32 },
  WestA1:     { color: [58, 58, 60], h: 32 },
};

// Lane centre lines and crosswalk stripes — flat white paint that sits 1 cm proud
// of the road slabs, which is what makes the roads read as roads.
const PAINT = ["Axisc", "Checkpointc", "EastA0c", "EastB0c", "EastC0c", "Ebert0c",
  "KMAc", "WestA0c", "WestA1c",
  "cwc0", "cwc1", "cwc2", "cwc3", "cwg0", "cwg1", "cwg2", "cwg3", "cwg4"];
for (const p of PAINT) SURFACE[p] = { color: [226, 226, 220], h: 6, paint: true };

const WALL_RUN = { Vorder_0: 1, Vorder_1: 1, Vorder_2: 1, Hinter_0: 1, Hinter_1: 1, Hinter_2: 1 };

const items = [];
const B2O = (c) => [Math.round(c[0] * 100), Math.round(c[2] * 100), Math.round(c[1] * 100)];

for (const inst of instances) {
  const { key, ctr, dim, baseZ } = inst;

  if (SURFACE[key]) {                                   // flat plane -> Part slab
    const s = SURFACE[key];
    // Paint sits on top of its road; ground/road slabs hang below their surface.
    const y = s.paint
      ? Math.round(baseZ * 100) + s.h / 2
      : Math.round(baseZ * 100) - s.h / 2;
    items.push({ className: "Part", name: key, props: {
      position: [Math.round(ctr[0] * 100), y, Math.round(ctr[1] * 100)],
      size: [Math.max(20, Math.round(dim[0] * 100)), s.h, Math.max(20, Math.round(dim[1] * 100))],
      color: s.color, material: "Concrete", anchored: true } });
    continue;
  }

  if (WALL_RUN[key]) {
    // The authored wall is a thin slab, and a Part reproduces that exactly. Tiling
    // 100+ mesh segments per run would cost hundreds of objects for the same look,
    // and stretching one mesh to 60 m would smear its texture.
    const heightCm = Math.round(dim[2] * 100);
    items.push({ className: "Part", name: key, props: {
      position: [Math.round(ctr[0] * 100), Math.round(baseZ * 100) + heightCm / 2, Math.round(ctr[1] * 100)],
      size: [Math.max(30, Math.round(dim[0] * 100)), heightCm, Math.round(dim[1] * 100)],
      color: key.startsWith("Vorder") ? [176, 174, 168] : [140, 138, 132],
      material: "Concrete", anchored: true } });
    continue;
  }

  const slot = ASSET[key];
  if (!slot) continue;                                  // no imported equivalent yet
  const a = M[slot];

  // Match the authored footprint. The imported mesh is rarely the same size as the
  // one the map was composed with, so using its natural size leaves objects out of
  // proportion with their neighbours. Scale uniformly — a per-axis fit would
  // distort the mesh — using the median axis ratio, and clamp so a bad asset match
  // cannot produce something absurd.
  const authored = [dim[0] * 100, dim[2] * 100, dim[1] * 100];   // OVERDARE axes
  // Size is local to the object, so a quarter-turned asset compares its own X
  // against the authored footprint's Z. Pairing them straight across makes every
  // rotated asset fit to the wrong axis.
  const aspect = (w, d) => (d > 0 ? w / d : 1);
  const yaw = faceYaw(inst, a, authored, aspect);
  const turned = Math.abs(Math.round(yaw / 90) % 2) === 1;
  const pair = turned ? [2, 1, 0] : [0, 1, 2];
  const ratios = [0, 1, 2]
    .map((i) => authored[pair[i]] / a.nat[i])
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((x, y) => x - y);
  // Small props have unusable authored boxes — a mailbox recorded as 0.1 m, a
  // hydrant as 0.05 — so fitting to them produces nonsense (a 12 m traffic light).
  // Only rescale when the authored box is both substantial and consistent.
  const plausible =
    Math.min(...authored) > 50 &&                       // no axis under 0.5 m
    ratios.length === 3 &&
    ratios[2] / ratios[0] < 4;                          // axes agree on a scale
  let s = plausible ? ratios[1] : 1;
  s = Math.min(4, Math.max(0.25, s));
  const size = a.nat.map((v) => Math.round(v * s * 10) / 10);

  if (process.env.LAYOUT_DEBUG) {
    // authored footprint vs the footprint the placed mesh will actually cover
    const fx = turned ? size[2] : size[0];
    const fz = turned ? size[0] : size[2];
    console.error(`DBG ${key} yaw=${Math.round(yaw)} authored=${Math.round(authored[0])}x${Math.round(authored[2])} placed=${Math.round(fx)}x${Math.round(fz)} instYaw=${inst.yaw} ref=${refYaw[key] ?? "-"} src=${a.blend ? "blend" : "lib"}`);
  }

  const pos = B2O(ctr);
  pos[1] = Math.round(baseZ * 100) + size[1] / 2;       // sit on the authored ground
  items.push({ className: "MeshPart", name: key.replace(/^(HQ_|DDR_)/, ""), props: {
    position: pos, size, meshId: `ovdrassetid://${a.mesh}`, anchored: true,
    ...(yaw ? { orientation: [0, yaw, 0] } : {}),
    // The flat colour stands in for a missing texture. Once the asset is re-imported
    // with a real one, leaving the colour on tints the texture — which is what made
    // so many of these look wrong rather than merely untextured.
    ...(a.color && !a.tex ? { color: a.color } : {}),
    ...(a.mat && !a.tex ? { material: a.mat } : {}),
    ...(a.tex ? { raw: { TextureId: `ovdrassetid://${a.tex}` } } : {}) } });
}

// unique names
const seen = {};
for (const it of items) {
  const b = it.name;
  seen[b] = (seen[b] ?? -1) + 1;
  if (seen[b] > 0) it.name = `${b}_${seen[b]}`;
}

if (process.argv[3] === "all") {
  console.log(JSON.stringify(items));                  // whole map, for itemsFile
} else if (batch === null) {
  console.error(`items=${items.length}`);
  const counts = {};
  for (const it of items) counts[it.name.replace(/_?\d+$/, "")] = (counts[it.name.replace(/_?\d+$/, "")] || 0) + 1;
  console.error(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join("  "));
} else {
  const size = 48;
  console.log(JSON.stringify(items.slice(batch * size, (batch + 1) * size)));
}
