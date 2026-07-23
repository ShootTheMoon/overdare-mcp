/**
 * build_asset_table.mjs — read the imported meshes out of a project and emit the
 * slot -> {mesh, tex, nat} table the layout generator consumes.
 *
 *   node build_asset_table.mjs <projectDir> <out.json>
 *
 * Asset ids are assigned at import time, so transcribing 30+ of them by hand is
 * both slow and a reliable source of mistakes. This reads them back instead.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outPath, ...dirs] = process.argv.slice(2);

// Asset ids are account-wide, so a mesh imported in one project can be referenced
// from another — scan every project the user has, not just the open one.
const found = new Map();
for (const dir of dirs) {
  let doc;
  try {
    const file = readdirSync(dir).find((n) => n.toLowerCase().endsWith(".ovdrjm"));
    const buf = readFileSync(join(dir, file));
    const enc = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : "utf8";
    doc = JSON.parse(buf.toString(enc).replace(/^﻿/, ""));
  } catch {
    continue;
  }
  // newest import of a given name wins — ObjectKey rises with each one
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.InstanceType === "MeshPart" && typeof n.Name === "string" && n.Name.endsWith("_overdare") && n.Size && n.MeshId) {
      const base = n.Name.replace(/_overdare$/, "");
      const prev = found.get(base);
      if (!prev || (n.ObjectKey ?? 0) > (prev.key ?? 0)) {
        found.set(base, {
          key: n.ObjectKey ?? 0,
          mesh: String(n.MeshId).replace("ovdrassetid://", ""),
          tex: n.TextureId ? String(n.TextureId).replace("ovdrassetid://", "") : null,
          nat: [n.Size.X, n.Size.Y, n.Size.Z].map((v) => Math.round(v * 10) / 10),
        });
      }
    }
    for (const k of Object.keys(n)) walk(n[k]);
  })(doc);
}

// authored asset name -> generator slot
const SLOT = {
  HQ_Trabant: "trabant", HQ_Lada: "lada", HQ_GAZ53: "truck", HQ_UAZ: "jeep",
  HQ_Ikarus280: "ikarus", HQ_Bicycle: "bicycle", HQ_T34: "t34",
  HQ_Bench: "bench", HQ_TrashBin: "bin", HQ_StreetLamp: "lamp",
  HQ_TrafficLight: "trafficlt", HQ_BusShelter: "busstop", HQ_Vending: "vending",
  HQ_Mailbox: "mailbox", HQ_FireHydrant: "hydrant", HQ_CzechHedgehog: "hedgehog",
  HQ_FoodCart: "foodcart",
  DDR_Watchtower: "tower", HQ_BrandenburgGate: "gate", HQ_Reichstag: "reichstag",
  HQ_VictoryColumn: "victory", HQ_Fernsehturm_AI: "tvtower", HQ_School: "school",
  HQ_TowerCrane: "crane", HQ_FerrisWheel: "ferris", HQ_Church: "church",
  HQ_Factory: "factory", HQ_Plattenbau1: "platten", HQ_Plattenbau2: "plattentw",
  HQ_Palast: "palast", HQ_SovietMemorial: "memorial", HQ_Lenin: "lenin",
  HQ_EastHousing_AI: "housing", WB_Altbau: "altbau", WB_Stadium: "stadium",
};

// Nothing is preferred from the library any more. These four used to be, because
// exporting them from the .blend produced a single object 6x too large — that was
// the exporter dropping object scale, not the .blend merging copies, and it is
// fixed in export_asset.py. Keep the map on one source so sizes stay consistent.
const PREFER_LIBRARY = {};

const table = {};
const missing = [];
for (const [name, slot] of Object.entries(SLOT)) {
  const a = found.get(PREFER_LIBRARY[slot] ?? name) ?? found.get(name);
  // Record where the mesh came from. A mesh exported straight out of the .blend
  // keeps the orientation of the instance it was exported from, so the layout can
  // place every other copy relative to that one; a library FBX has no such link.
  const fromLibrary = Boolean(PREFER_LIBRARY[slot] && found.get(PREFER_LIBRARY[slot]));
  // A few props are authored as degenerate boxes — the mailbox is 4 cm across, the
  // hydrant 5 — so the mesh exported from them is an invisible speck. Leave those
  // slots out and let the generator's library default stand.
  if (a && Math.max(...a.nat) < 60) {
    missing.push(`${name} (degenerate ${a.nat.join("x")} — using library)`);
  } else if (a) {
    table[slot] = { mesh: a.mesh, tex: a.tex, nat: a.nat, ...(fromLibrary ? { lib: true } : { blend: true }) };
  } else missing.push(name);
}

writeFileSync(outPath, JSON.stringify(table, null, 2));
console.log(`asset table: ${Object.keys(table).length} slots -> ${outPath}`);
if (missing.length) console.log(`not imported yet (${missing.length}): ${missing.join(", ")}`);
