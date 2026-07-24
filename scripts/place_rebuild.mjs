/**
 * place_rebuild.mjs — reassemble the whole map from the bulk-imported converted assets.
 *
 *   node place_rebuild.mjs <geom.json> <rebuild_bundles.json> <manifest.json> \
 *        <gen17.json> <project-dir> <out.json>
 *
 * Each converted asset was cut into objects (one material / one texture each), packed
 * into rb_NN bundles, and Bulk-Imported. OVERDARE registered each object as
 * "rb_NN_<objectName>" (STATIC_MESH) plus its "<image>" (TEXTURE). To rebuild:
 *
 *   for each asset instance in the layout (gen17: map position, size, yaw):
 *     scale = layoutSize / (assetOrigDims -> OVERDARE cm)
 *     for each object of that asset:
 *       worldPos = instancePos + Rz(yaw) * (objCenter * 100 * scale)   [x,z,y axis map]
 *       size     = objDim * 100 * scale
 *       meshId   = registry["rb_NN_<objectName>"]
 *       texId    = registry[<image>]
 *
 * so every material-piece lands in place with its own texture. Emits the items array.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [geomPath, bundlesPath, manifestPath, layoutPath, projDir, /*out via stdout*/] = process.argv.slice(2);
const geom = JSON.parse(readFileSync(geomPath, "utf8"));           // fileBasename -> {objName -> {center_m,dim_m,image}}
const bundles = JSON.parse(readFileSync(bundlesPath, "utf8"));      // [{i,bundle,sources:[{asset,objects:[{object,images}]}]}]
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));    // asset -> {orig_dims,files,...}
const layout = JSON.parse(readFileSync(layoutPath, "utf8"));        // gen17 items

// registry: name -> contentId
const buf = readFileSync(`${projDir}/UGCLocalAssetTable.json`);
const enc = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : "utf8";
const L = JSON.parse(buf.toString(enc).replace(/^﻿/, "")).localAssetList;
// Importing one bundle registers SEVERAL assets under the same name — a STATIC_MESH
// and a MODEL wrapper at least — and the MODEL usually gets the higher id. Indexing by
// name alone and keeping the newest therefore hands a MeshPart a MODEL id, which it
// cannot render: that is why whole landmarks went invisible while their bbox looked
// right. Keep one index per asset type and resolve meshes and textures from their own.
const meshIdByName = {};
const texIdByName = {};
const idBySuffix = {};   // objName with the "rb_NN_" prefix stripped -> newest mesh id
for (const [id, v] of Object.entries(L)) {
  // OVERDARE rewrites '.' to '_' in object names on import (cv.002 -> cv_002), and a
  // name can repeat across import sessions, so index by the normalised name and keep
  // the newest id.
  const n = String(v.name).replace(/\./g, "_");
  const type = String(v.worldAssetType);
  if (type === "TEXTURE") {
    if (!texIdByName[n] || Number(id) > texIdByName[n]) texIdByName[n] = Number(id);
  } else if (type === "STATIC_MESH") {
    if (!meshIdByName[n] || Number(id) > meshIdByName[n]) meshIdByName[n] = Number(id);
    // The bundle a given object actually landed in can differ from the planned
    // rebuild_bundles.json (imports weren't done in plan order). Object names are
    // globally unique across bundles, so strip the "rb_NN" prefix and index by the
    // object suffix to recover the mesh regardless of which bundle it registered under.
    const suf = n.replace(/^rb_\d+_/, "");
    if (!idBySuffix[suf] || Number(id) > idBySuffix[suf]) idBySuffix[suf] = Number(id);
  }
}
const norm = (s) => s.replace(/\./g, "_");
const texBase = (s) => s.replace(/\.\d+$/, "");   // drop Blender's ".005" duplicate suffix

// Which bundle each object landed in → its registered mesh name "rb_NN_<object>".
// Build object → {meshName, sourceAsset, sourceFile-less}. genbundles recorded per bundle.
const objToBundle = {};   // objectName -> bundleIndex
const objToAsset = {};    // objectName -> assetName (e.g. HQ_Trabant_overdare)
const bundleSize = {};    // bundleIndex -> how many mesh objects it held
for (const b of bundles) {
  const idx = String(b.i).padStart(2, "0");
  bundleSize[idx] = (b.sources || []).reduce((n, s) => n + (s.objects || []).length, 0);
  for (const src of b.sources || []) {
    for (const o of src.objects || []) {
      objToBundle[o.object] = idx;
      objToAsset[o.object] = src.asset;
    }
  }
}

// geom is keyed by file basename incl. _pNN. An object's center_m is measured FROM the
// converted FBX, so it is already the position OVERDARE will import the piece at. The
// manifest also records a per-file offset from the asset centre — but that is only a
// real correction for assets whose split files were re-exported around their OWN origin
// (their pieces would otherwise stack at one point). For assets whose pieces kept their
// position in the FBX, center_m is already correct and adding the offset DOUBLE-counts,
// shearing the internal assembly (the whole reason the gate looked "not quite right").
//
// Decide per asset by reconstruction: assemble from center_m alone and compare to the
// authored orig_dims. If it collapses (much smaller than orig on some axis) the pieces
// are stacked → apply the offset; if it already matches orig, the offset is spurious.
const fileToAsset = {};   // file basename -> manifest key
const assetNeedsOffset = {};
for (const [key, entry] of Object.entries(manifest)) {
  for (const f of entry.files || []) if (f?.file) fileToAsset[String(f.file)] = key;
}
for (const [key, entry] of Object.entries(manifest)) {
  if (!entry.files || entry.files.length < 2) { assetNeedsOffset[key] = false; continue; }
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  let any = false;
  for (const f of entry.files) {
    const objs = geom[f.file];
    if (!objs || objs.error) continue;
    for (const g of Object.values(objs)) {
      any = true;
      for (let a = 0; a < 3; a++) {
        mn[a] = Math.min(mn[a], g.center_m[a] - g.dim_m[a] / 2);
        mx[a] = Math.max(mx[a], g.center_m[a] + g.dim_m[a] / 2);
      }
    }
  }
  const od = entry.orig_dims || [0, 0, 0];
  const minRatio = any
    ? Math.min(...[0, 1, 2].map((a) => (od[a] > 0 ? (mx[a] - mn[a]) / od[a] : 1)))
    : 1;
  // Collapsed on some axis → the FBX stacked the pieces → the offset is the real fix.
  assetNeedsOffset[key] = any && minRatio < 0.7;
}

const fileOffset = {};    // file basename -> Blender-m offset, only where the asset needs it
for (const [key, entry] of Object.entries(manifest)) {
  if (!assetNeedsOffset[key]) continue;
  for (const f of entry.files || []) if (f?.file) fileOffset[String(f.file)] = f.offset || [0, 0, 0];
}

const objGeom = {};       // objectName -> {center_m (asset space), dim_m, image}
for (const [file, objs] of Object.entries(geom)) {
  if (objs.error) continue;
  const off = fileOffset[file] || [0, 0, 0];
  for (const [name, g] of Object.entries(objs)) {
    objGeom[name] = { ...g, center_m: [0, 1, 2].map((i) => g.center_m[i] + (off[i] || 0)) };
  }
}

// manifest key (HQ_Trabant) from converted asset base (HQ_Trabant_overdare or _overdare_pNN)
function manifestKey(assetBase) {
  return assetBase.replace(/_overdare(_p\d+)?$/, "");
}

// layout instance list, grouped by asset name (gen17 name may be "Trabant" without HQ_)
// gen17 names strip HQ_/DDR_ prefixes and add _N for copies. Map layout name -> manifest key.
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

// objects belonging to an asset (manifest key) across all its files, from geom
const objsByAsset = {};
for (const [objName, g] of Object.entries(objGeom)) {
  const asset = objToAsset[objName];             // HQ_Trabant_overdare[_pNN]
  if (!asset) continue;
  const key = manifestKey(asset);
  (objsByAsset[key] ??= []).push({ objName, ...g });
}

const items = [];
const missing = new Set();
const placedAssets = new Set();

for (const inst of layout) {
  const lname = inst.name.replace(/_\d+$/, "");
  const mkey = LAYOUT_TO_MANIFEST[lname];
  if (!mkey || !manifest[mkey]) continue;         // not a converted asset (Parts, walls, etc.)
  const objs = objsByAsset[mkey];
  if (!objs || !objs.length) { missing.add(mkey); continue; }
  placedAssets.add(mkey);

  const orig = manifest[mkey].orig_dims;          // Blender m (x,y,z)
  // authored size in OVERDARE cm: (x, z, y) * 100
  const authored = [orig[0] * 100, orig[2] * 100, orig[1] * 100];
  // These are RIGID props/buildings, so they must scale uniformly — the layout box's
  // aspect ratio is unreliable (it was authored for differently-proportioned versions,
  // e.g. a 7 m barrier wall boxed as a 0.58 m barricade), and per-axis scaling shears
  // such assets into slivers. Take the median per-axis ratio as one uniform factor:
  // it's 1.0 for the many assets already authored at true size, and it discards the
  // one rogue axis for the mismatched few instead of stretching the mesh along it.
  const ratios = [0, 1, 2].map((i) => (authored[i] > 0 ? inst.props.size[i] / authored[i] : 1));
  const uni = [...ratios].sort((a, b) => a - b)[1];
  const scale = [uni, uni, uni];
  const yaw = ((inst.props.orientation || [0, 0, 0])[1] || 0) * Math.PI / 180;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const anchor = inst.props.position;
  const suffix = inst.name.match(/_\d+$/)?.[0] || "";

  for (const o of objs) {
    // Bulk Import names a bundle's asset after the OBJECT only when the file held
    // several meshes; a single-mesh file registers under the bundle name alone.
    const bi = objToBundle[o.objName];
    const meshName = bundleSize[bi] === 1 ? `rb_${bi}` : norm(`rb_${bi}_${o.objName}`);
    // exact bundle match first, then bundle-agnostic suffix fallback
    const meshId = meshIdByName[meshName] || idBySuffix[norm(o.objName)];
    if (!meshId) { missing.add(meshName); continue; }
    // Blender appends a duplicate suffix (".005") to an image datablock reused across
    // objects, but the texture registers under the base image name — so try the raw
    // name, then the name with that suffix dropped, before giving up.
    const texId = o.image
      ? texIdByName[o.image] ?? texIdByName[texBase(o.image)] ?? texIdByName[norm(texBase(o.image))] ?? null
      : null;

    // object center (Blender m, Z-up) -> OVERDARE cm (x, z, y), scaled, yaw-rotated in XZ
    const ox = o.center_m[0] * 100 * scale[0];
    const oy = o.center_m[2] * 100 * scale[1];
    const oz = o.center_m[1] * 100 * scale[2];
    const rx = ox * cos - oz * sin;
    const rz = ox * sin + oz * cos;

    items.push({
      className: "MeshPart",
      name: `${lname}${suffix}_${o.objName.replace(/^[A-Za-z]+_[A-Za-z0-9]+__/, "").replace(/_cv.*$/, "")}`,
      props: {
        position: [Math.round(anchor[0] + rx), Math.round(anchor[1] + oy), Math.round(anchor[2] + rz)],
        size: [
          Math.max(1, Math.round(o.dim_m[0] * 100 * scale[0] * 10) / 10),
          Math.max(1, Math.round(o.dim_m[2] * 100 * scale[1] * 10) / 10),
          Math.max(1, Math.round(o.dim_m[1] * 100 * scale[2] * 10) / 10),
        ],
        meshId: `ovdrassetid://${meshId}`,
        anchored: true,
        ...(inst.props.orientation && yaw ? { orientation: [0, (inst.props.orientation[1] || 0), 0] } : {}),
        ...(texId ? { raw: { TextureId: `ovdrassetid://${texId}` } } : {}),
      },
    });
  }
}

console.error(`items ${items.length} | placed assets ${placedAssets.size} | missing ${[...missing].slice(0, 10).join(", ")}${missing.size > 10 ? " …" : ""}`);
console.log(JSON.stringify(items));
