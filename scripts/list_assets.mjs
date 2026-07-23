/**
 * list_assets.mjs — print every imported MeshPart in a project with its size and
 * asset ids, so placements can reuse the mesh without re-importing.
 *
 *   node list_assets.mjs <projectDir> [nameFilter]
 *
 * The .ovdrjm is normally UTF-16LE with a BOM, but tools that rewrite it can leave
 * UTF-8; sniff rather than assume, otherwise JSON.parse dumps the whole file into
 * the error message.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function loadDoc(dir) {
  const name = readdirSync(dir).find((n) => n.toLowerCase().endsWith(".ovdrjm"));
  if (!name) throw new Error(`no .ovdrjm in ${dir}`);
  const buf = readFileSync(join(dir, name));
  const utf16 = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe;
  const txt = (utf16 ? buf.toString("utf16le") : buf.toString("utf8")).replace(/^﻿/, "");
  return { name, doc: JSON.parse(txt) };
}

const dir = process.argv[2];
const filter = (process.argv[3] || "").toLowerCase();
const { name, doc } = loadDoc(dir);

const rows = [];
(function walk(n) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) return n.forEach(walk);
  if (n.InstanceType === "MeshPart" && typeof n.Name === "string" && n.Size) {
    rows.push({
      name: n.Name,
      guid: n.ActorGuid,
      size: [n.Size.X, n.Size.Y, n.Size.Z].map((v) => Math.round(v * 10) / 10),
      mesh: (n.MeshId || "").replace("ovdrassetid://", ""),
      tex: (n.TextureId || "").replace("ovdrassetid://", ""),
    });
  }
  for (const k of Object.keys(n)) walk(n[k]);
})(doc);

const seen = new Set();
const list = rows
  .filter((r) => r.name.endsWith("_overdare"))
  .filter((r) => !filter || r.name.toLowerCase().includes(filter))
  .filter((r) => (seen.has(r.mesh) ? false : (seen.add(r.mesh), true)));

console.log(`project ${name} — imported meshes: ${list.length}`);
for (const r of list.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(
    "  " + r.name.replace("_overdare", "").padEnd(28),
    JSON.stringify(r.size).padEnd(24),
    "m" + r.mesh.padEnd(9),
    r.tex ? "t" + r.tex : "NO-TEXTURE",
  );
}
