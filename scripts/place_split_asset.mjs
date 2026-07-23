/**
 * place_split_asset.mjs — turn a split asset's registered pieces into placement items.
 *
 *   node place_split_asset.mjs <split.json> <project-dir> <bundlePrefixList> \
 *        <anchorX,anchorY,anchorZ> <scaleX,scaleY,scaleZ> [yawDeg]
 *
 * A landmark was cut into pieces, each exported re-centred on its own origin with
 * its offset from the asset centre recorded (Blender metres, Z-up). After the
 * pieces are Bulk-Imported they carry names "<bundle>_<pieceName>", with the texture
 * as "00_<image>". This reads the registry back, pairs each piece with its mesh and
 * texture, and places it at:
 *
 *     worldPos = anchor + Rz(yaw) * (offset * 100 * scale)     // (x,z,y) axis map
 *
 * so the pieces reassemble into the whole landmark at the anchor.
 *
 * Prints the items array (JSON) for overdare_create_instances.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [splitPath, projDir, bundleCsv, anchorCsv, scaleCsv, yawArg] = process.argv.slice(2);
const split = JSON.parse(readFileSync(splitPath, "utf8"));
const bundles = bundleCsv.split(",").map((s) => s.trim()).filter(Boolean);
const anchor = anchorCsv.split(",").map(Number);
const scale = scaleCsv.split(",").map(Number);
const yaw = (Number(yawArg) || 0) * Math.PI / 180;

const tablePath = join(projDir, "UGCLocalAssetTable.json");
const buf = readFileSync(tablePath);
const enc = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : "utf8";
const L = JSON.parse(buf.toString(enc).replace(/^﻿/, "")).localAssetList;
const byName = {};
for (const [id, v] of Object.entries(L)) byName[String(v.name)] = Number(id);

const cos = Math.cos(yaw), sin = Math.sin(yaw);
const items = [];
const missing = [];

for (const piece of split.pieces) {
  // The piece's mesh asset is "<bundle>_<piece.name>" — try each bundle prefix.
  let meshId = null, matchedBundle = null;
  for (const b of bundles) {
    const id = byName[`${b}_${piece.name}`];
    if (id) { meshId = id; matchedBundle = b; break; }
  }
  if (!meshId) { missing.push(piece.name); continue; }

  // texture: "00_<image>" — the piece may reference one colour image
  let texId = null;
  for (const img of piece.materials?.length ? [] : []) {} // materials are names, not images
  // piece.file's image name isn't in split.json; texture pairing is by the piece's
  // known colour image recorded at bundle time. Fall back: look for any "00_*" that
  // this bundle registered whose stem matches the piece. Simpler: the split step
  // stripped to one colour image per piece; its name is <image>. We stored it under
  // piece — if absent, leave texture null (mesh still shows, untextured).
  if (piece.image) texId = byName[`00_${piece.image}`] ?? null;

  // offset (Blender m, Z-up) -> OVERDARE cm (x, z, y), scaled, then yaw-rotated in XZ
  const ox = piece.offset_m[0] * 100 * scale[0];
  const oy = piece.offset_m[2] * 100 * scale[1];   // Blender Z -> OVERDARE Y
  const oz = piece.offset_m[1] * 100 * scale[2];   // Blender Y -> OVERDARE Z
  const rx = ox * cos - oz * sin;
  const rz = ox * sin + oz * cos;

  const size = [
    piece.dim_m[0] * 100 * scale[0],
    piece.dim_m[2] * 100 * scale[1],
    piece.dim_m[1] * 100 * scale[2],
  ];

  items.push({
    className: "MeshPart",
    name: `Church_${piece.name.replace(/^HQ_Church_/, "")}`,
    props: {
      position: [anchor[0] + rx, anchor[1] + oy, anchor[2] + rz],
      size,
      meshId: `ovdrassetid://${meshId}`,
      anchored: true,
      ...(yawArg ? { orientation: [0, Number(yawArg), 0] } : {}),
      ...(texId ? { raw: { TextureId: `ovdrassetid://${texId}` } } : {}),
    },
  });
}

if (missing.length) console.error(`missing meshes (not registered): ${missing.join(", ")}`);
console.error(`placed ${items.length}/${split.pieces.length} pieces`);
console.log(JSON.stringify(items));
