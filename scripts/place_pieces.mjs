/**
 * place_pieces.mjs — reassemble a split landmark from its registered pieces.
 *
 *   node place_pieces.mjs <split.json> <bins.json> <project-dir> <bundlePrefix> \
 *        <name> <anchorX,Y,Z> <scaleX,Y,Z> [yawDeg]
 *
 * A landmark was cut into pieces (split.json: each piece's offset from the asset
 * centre in Blender metres, and its size), bin-packed into bundles (bins.json:
 * arrays of piece file paths), and Bulk-Imported. OVERDARE names a bundle's asset
 * "<bundle>" when the bundle held ONE mesh and "<bundle>_<pieceName>" when it held
 * several, so recovering which registered mesh is which piece needs both the naming
 * and the bin membership. All pieces of one landmark share the same source image, so
 * any of that landmark's textures is the right one for every piece.
 *
 * Emits the items array for overdare_create_instances, placing each piece at
 *   anchor + Rz(yaw) * (offset * 100 * scale)     (Blender x,z,y -> OVERDARE x,y,z)
 */
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";

const [splitPath, binsPath, projDir, prefix, name, anchorCsv, scaleCsv, yawArg, texArg] = process.argv.slice(2);
const split = JSON.parse(readFileSync(splitPath, "utf8"));
const bins = JSON.parse(readFileSync(binsPath, "utf8"));
const anchor = anchorCsv.split(",").map(Number);
const scale = scaleCsv.split(",").map(Number);
const yaw = (Number(yawArg) || 0) * Math.PI / 180;

const buf = readFileSync(join(projDir, "UGCLocalAssetTable.json"));
const enc = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : "utf8";
const L = JSON.parse(buf.toString(enc).replace(/^﻿/, "")).localAssetList;
const entries = Object.entries(L).map(([id, v]) => ({ id: Number(id), name: String(v.name), type: String(v.worldAssetType) }));

// piece name -> its bundle index (from bin membership)
const pieceToBin = {};
bins.forEach((files, i) => files.forEach((f) => { pieceToBin[basename(String(f)).replace(/\.fbx$/i, "")] = i; }));
// bundle index -> how many pieces it held (single vs multi changes the registered name)
const binSize = bins.map((f) => f.length);

// resolve each piece to a registered STATIC_MESH id
const meshes = entries.filter((e) => e.type === "STATIC_MESH");
function meshIdFor(pieceName) {
  const bin = pieceToBin[pieceName];
  if (bin === undefined) return null;
  if (binSize[bin] > 1) {
    const m = meshes.find((e) => e.name === `${prefix}${bin}_${pieceName}`);
    return m ? m.id : null;
  }
  // single-mesh bundle: registered under the bundle name itself
  const m = meshes.find((e) => e.name === `${prefix}${bin}`);
  return m ? m.id : null;
}

// All pieces of this landmark share one image, so any of its textures fits — but
// "any baseColor" would happily grab an unrelated asset's texture, so the caller
// passes the right id explicitly (the name alone is ambiguous across imports).
const texId = texArg ? Number(texArg) : null;

const cos = Math.cos(yaw), sin = Math.sin(yaw);
const items = [];
const missing = [];
for (const p of split.pieces) {
  const meshId = meshIdFor(p.name);
  if (!meshId) { missing.push(p.name); continue; }
  const ox = p.offset_m[0] * 100 * scale[0];
  const oy = p.offset_m[2] * 100 * scale[1];   // Blender Z -> OVERDARE Y
  const oz = p.offset_m[1] * 100 * scale[2];   // Blender Y -> OVERDARE Z
  const rx = ox * cos - oz * sin;
  const rz = ox * sin + oz * cos;
  items.push({
    className: "MeshPart",
    name: `${name}_${p.name.replace(/^HQ_/, "").replace(/^[A-Za-z]+_/, "")}`,
    props: {
      position: [Math.round(anchor[0] + rx), Math.round(anchor[1] + oy), Math.round(anchor[2] + rz)],
      size: [
        Math.round(p.dim_m[0] * 100 * scale[0] * 10) / 10,
        Math.round(p.dim_m[2] * 100 * scale[1] * 10) / 10,
        Math.round(p.dim_m[1] * 100 * scale[2] * 10) / 10,
      ],
      meshId: `ovdrassetid://${meshId}`,
      anchored: true,
      ...(yawArg && Number(yawArg) ? { orientation: [0, Number(yawArg), 0] } : {}),
      ...(texId ? { raw: { TextureId: `ovdrassetid://${texId}` } } : {}),
    },
  });
}

console.error(`placed ${items.length}/${split.pieces.length}${missing.length ? ", missing: " + missing.join(",") : ""}`);
console.log(JSON.stringify(items));
