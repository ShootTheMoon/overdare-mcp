// place_asset_abs.mjs — build placement items for ONE asset from its recentered split
// and the freshly imported meshes in UGCLocalAssetTable.json.
//
//   node place_asset_abs.mjs <assetName> <outItemsJson> [minContentId]
//
// Each piece is placed at its OWN measured world centre (from split_absolute.py, which
// re-centres each mesh on its origin). Mapping OVERDARE(X,Y,Z) = Blender(x, z, y) * 100.
// No rotation/offset/scale term — the mesh origin already sits at its geometry centre.
import fs from "node:fs";

const asset = process.argv[2];
const outFile = process.argv[3];
const minId = Number(process.argv[4] || 0);
if (!asset || !outFile) { console.error("usage: node place_asset_abs.mjs <asset> <out.json> [minContentId]"); process.exit(1); }

const split = JSON.parse(fs.readFileSync(`C:/Users/29/Desktop/MeshTest/Abs/${asset}_split.json`, "utf8"));
const reg = Object.values(JSON.parse(fs.readFileSync("C:/Users/29/Desktop/onlyoneshot/UGCLocalAssetTable.json", "utf8")).localAssetList);

// newest mesh per piece-base name; newest texture per name
const mesh = {}, tex = {};
for (const r of reg.sort((a, b) => Number(a.contentId) - Number(b.contentId))) {
  if (minId && Number(r.contentId) < minId) continue;
  const id = "ovdrassetid://" + r.contentId;
  if (r.worldAssetType === "STATIC_MESH") {
    const m = r.name.match(/([A-Za-z0-9_]+_p\d+)$/);
    if (m) mesh[m[1]] = id;                 // bare piece name, e.g. HQ_Trabant_p00
  }
  if (r.worldAssetType === "TEXTURE") tex[r.name] = id;
}

const short = asset.replace(/^(HQ_|WB_|PROP_|DDR_)/, "");
const items = [];
let miss = 0, notex = 0;
for (const p of split.pieces) {
  const base = p.file.replace(/\.fbx$/, "");
  const mid = mesh[base];
  if (!mid) { miss++; continue; }
  let tid = null;
  if (p.image) {
    const nm = p.image.replace(/\.(jpe?g|png|tga|bmp|tif)$/i, "");
    tid = tex[nm] || tex[nm + "_ncl1_1"] || tex[nm.replace(/\./g, "_")] || null;
  }
  if (!tid) notex++;
  const c = p.center_m, d = p.dims_m;
  const props = {
    meshId: mid, anchored: true,
    position: [Math.round(c[0] * 100), Math.round(c[2] * 100), Math.round(c[1] * 100)],
    size: [Math.max(1, Math.round(d[0] * 100)), Math.max(1, Math.round(d[2] * 100)), Math.max(1, Math.round(d[1] * 100))],
    orientation: [0, 0, 0],
  };
  if (tid) props.raw = { TextureId: tid };
  items.push({ className: "MeshPart", name: short + "_" + base.replace(asset + "_", ""), props });
}
fs.writeFileSync(outFile, JSON.stringify(items, null, 1));
console.log(`${asset}: 배치 ${items.length} | 메시매칭실패 ${miss} | 텍스처없음 ${notex}`);
