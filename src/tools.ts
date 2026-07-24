/**
 * MCP tool definitions for OVERDARE Studio.
 *
 * Each tool maps to a Studio RPC method (see rpcClient.ts). Schemas reflect the
 * methods VERIFIED against a live Studio build:
 *   working : level.browse, level.apply, level.save.file, level.publish,
 *             game.play/stop/screenshot, script.add, instance.delete
 *   absent  : instance.read/upsert/move, script.read/edit/grep (server returns
 *             -32002 on this build) — reachable later via the .ovdrjm edit path.
 *
 * The model drives Studio by GUID: call overdare_browse first to learn the
 * tree, then act on nodes by their `guid`.
 */

import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const execFileP = promisify(execFile);

/** Read the last N bytes of a (possibly huge) file. */
function tailFile(path: string, bytes = 512 * 1024): string {
  const st = statSync(path);
  const start = Math.max(0, st.size - bytes);
  const len = st.size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("latin1");
  } finally {
    closeSync(fd);
  }
}

/**
 * Which project is loaded, from Studio's own log — light and side-effect free.
 * Studio logs `... FILE="../../../../Users/<u>/.../<name>/<name>.umap"` on every
 * (auto)save; the newest one identifies the open project.
 */
function discoverProjectDirFromLog(): string | null {
  try {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    const log = join(local, "Sandbox", "Saved", "Logs", "Sandbox.log");
    if (!existsSync(log)) return null;
    const txt = tailFile(log);
    const re = /FILE="([^"]+\.umap)"/g;
    let m: RegExpExecArray | null;
    let last: string | null = null;
    while ((m = re.exec(txt)) !== null) last = m[1];
    if (!last) return null;
    const tail = last.replace(/^(\.\.[\\/])+/, "").replace(/\\/g, "/");
    const drive = (log.match(/^[A-Za-z]:/) ?? ["C:"])[0];
    const dir = dirname(`${drive}/${tail}`);
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Locate a Blender executable: env override, then common Windows installs, then PATH. */
function findBlender(): string {
  const env = process.env.OVERDARE_BLENDER || process.env.BLENDER_PATH;
  if (env && existsSync(env)) return env;
  // direct, non-versioned locations (Steam installs blender.exe here)
  for (const p of [
    "C:/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe",
    "C:/Program Files/Steam/steamapps/common/Blender/blender.exe",
  ]) {
    if (existsSync(p)) return p;
  }
  const bases = [
    "C:/Program Files/Blender Foundation",
    "C:/Program Files (x86)/Blender Foundation",
  ];
  const found: string[] = [];
  for (const base of bases) {
    try {
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base)) {
        const exe = `${base}/${d}/blender.exe`;
        if (existsSync(exe)) found.push(exe);
      }
    } catch {
      /* ignore */
    }
  }
  if (found.length) return found.sort().reverse()[0]; // newest version dir
  return "blender"; // rely on PATH
}
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StudioRpcClient } from "./rpcClient.js";
import { StudioRpcError } from "./rpcClient.js";
import { RemoteControlClient } from "./remoteControl.js";
import {
  loadDoc,
  saveDoc,
  resolveNode,
  subtreeBounds,
  createInstance,
  createInstances,
  updateInstance,
  moveInstance,
  duplicateInstance,
  findNodes,
  deleteByGuid,
  findProjectFile,
  type CreateProps,
} from "./ovdrjm.js";
import { ASSET_CATALOG, findAsset, isOvdrAssetId } from "./assets.js";
import { registerKnowledge } from "./knowledge.js";

type Json = Record<string, unknown>;

const clean = (obj: Json): Json =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function ok(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: text || "(no result)" }] };
}

function fail(err: unknown) {
  const msg =
    err instanceof StudioRpcError
      ? err.message
      : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

/** A clean validation/guard-rail error (no "Unexpected error:" prefix). */
function errOut(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Friendly instance props (mirrors ovdrjm CreateProps) — shared by the
 *  create/update/bulk edit tools. All optional; `raw` is the escape hatch. */
const PROPS_SHAPE = z.object({
  position: z.array(z.number()).length(3).optional().describe("[X,Y,Z] world position."),
  orientation: z.array(z.number()).length(3).optional().describe("[X,Y,Z] degrees."),
  size: z.array(z.number()).length(3).optional().describe("[X,Y,Z] size."),
  color: z.array(z.number()).length(3).optional().describe("[R,G,B] 0-255."),
  anchored: z.boolean().optional(),
  canCollide: z.boolean().optional(),
  transparency: z.number().optional().describe("0 (opaque) - 1 (invisible)."),
  mobility: z.enum(["Movable", "Static"]).optional(),
  meshId: z.string().optional(),
  shape: z.enum(["Block", "Ball", "Cylinder"]).optional(),
  material: z.string().optional().describe("e.g. Plastic, Metal, Glass, Neon, Wood, Marble, Concrete, Brick."),
  castShadow: z.boolean().optional(),
  canTouch: z.boolean().optional(),
  canQuery: z.boolean().optional(),
  canClimb: z.boolean().optional(),
  locked: z.boolean().optional(),
  collisionProfile: z.string().optional(),
  collisionGroup: z.string().optional(),
  materialVariant: z.string().optional(),
  raw: z.record(z.any()).optional().describe("Verbatim ovdrjm fields (e.g. UDim2 Position/Size for UI, nested BrickColor)."),
});

export function registerTools(server: McpServer, client: StudioRpcClient) {
  const tool = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    method: string,
    map: (args: Json) => Json = (a) => a,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: shape },
      async (args: Json) => {
        try {
          return ok(await client.call(method, clean(map(args))));
        } catch (err) {
          return fail(err);
        }
      },
    );
  };

  // Recipes/knowledge (MCP resources + overdare_recipe) — battle-tested
  // build playbooks adapted from the built-in agent's skills.
  registerKnowledge(server);

  // ---- Read --------------------------------------------------------------
  tool(
    "overdare_browse",
    "Browse the live OVERDARE DataModel tree (Workspace, Players, ReplicatedStorage, ServerScriptService, StarterGui, etc). Returns nodes as { guid, name, class, children }. ALWAYS call this first — every other tool targets nodes by their `guid`.",
    {},
    "level.browse",
  );

  // ---- Scripts (Luau) ----------------------------------------------------
  tool(
    "overdare_script_add",
    "Create a Luau script under a parent instance (found via overdare_browse). Use TABS for indentation. Good parents: ServerScriptService (Script), StarterPlayer.StarterPlayerScripts (LocalScript), ReplicatedStorage (ModuleScript).",
    {
      class: z
        .enum(["Script", "LocalScript", "ModuleScript"])
        .describe("Script kind: Script=server, LocalScript=client, ModuleScript=shared library."),
      parentGuid: z.string().describe("GUID of the parent instance (from overdare_browse)."),
      name: z.string().describe("Script name."),
      source: z.string().describe("Luau source code (tabs for indentation)."),
    },
    "script.add",
  );

  // ---- Mutate ------------------------------------------------------------
  tool(
    "overdare_instance_delete",
    "Delete one or more instances by GUID (and their descendants). Irreversible — confirm intent before calling.",
    {
      guids: z
        .array(z.string())
        .min(1)
        .describe("GUIDs to delete (from overdare_browse)."),
    },
    "instance.delete",
    (a) => ({ items: (a.guids as string[]).map((targetGuid) => ({ targetGuid })) }),
  );

  // ---- Project / lifecycle ----------------------------------------------
  tool(
    "overdare_save",
    "Save the project to disk (.ovdrjm/.umap). Call after meaningful changes.",
    {},
    "level.save.file",
  );

  tool(
    "overdare_apply",
    "Tell Studio to apply/reload pending level changes. Used after low-level edits; safe to call to refresh state.",
    {},
    "level.apply",
  );

  tool(
    "overdare_publish",
    "Publish the world to the OVERDARE Hub.",
    {},
    "level.publish",
  );

  // ---- Playtest ----------------------------------------------------------
  tool(
    "overdare_play",
    "Start a playtest of the current level. Optionally simulate multiple players.",
    { numberOfPlayer: z.number().int().positive().optional().describe("Number of players to simulate (default 1).") },
    "game.play",
  );
  tool("overdare_stop", "Stop the running playtest.", {}, "game.stop");

  // Screenshot returns a saved PNG path — read it back so the model can SEE it.
  server.registerTool(
    "overdare_screenshot",
    {
      description:
        "Capture the live Studio viewport / running game and return the image so you can visually verify the scene. Great for 'visual-first' iteration: change something, then look.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = (await client.call("game.screenshot", {})) as {
          path?: string;
          success?: boolean;
        };
        const path = res?.path;
        if (!path) return ok(res);
        try {
          const buf = await readFile(path);
          return {
            content: [
              { type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" },
              { type: "text" as const, text: `Saved: ${path}` },
            ],
          };
        } catch {
          // Couldn't read the file (e.g. path on another machine) — return path only.
          return ok(res);
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ======================================================================
  //  ASSET IMPORT  (Asset Drawer models + local images)
  //  Pull in pro-made content by id instead of hand-building primitives.
  //  A BAD asset id HANGS Studio — pick ids via overdare_assets, import only
  //  with the playtest STOPPED.
  // ======================================================================
  server.registerTool(
    "overdare_assets",
    {
      description:
        "List the curated OVERDARE Asset Drawer catalog (official UI screens + a PvP combat template) so you can pick a KNOWN-GOOD id to import with overdare_asset_import. Guessing an id is dangerous (a bad id hangs Studio). No Studio call; safe anytime.",
      inputSchema: {
        category: z.enum(["ui", "combat", "world"]).optional().describe("Filter by category."),
        query: z.string().optional().describe("Case-insensitive substring match on name/description."),
      },
    },
    async (a: Json) => {
      const cat = a.category as string | undefined;
      const q = (a.query as string | undefined)?.toLowerCase();
      const rows = ASSET_CATALOG.filter(
        (e) =>
          (!cat || e.category === cat) &&
          (!q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)),
      );
      return ok(rows);
    },
  );

  server.registerTool(
    "overdare_asset_import",
    {
      description:
        "Import an Asset Drawer model into the level by id (a full UI screen, the combat template, etc.). It lands under Workspace — relocate with overdare_move_instance (UI -> StarterGui). DANGER: a wrong id permanently HANGS Studio. Pick ids from overdare_assets, STOP the playtest, then set confirmStopped=true.",
      inputSchema: {
        assetId: z.string().describe('Asset Drawer id "ovdrassetid://NUMBER" (use overdare_assets to pick).'),
        assetName: z.string().optional().describe("Display name; defaults from the catalog when the id is known."),
        confirmStopped: z
          .boolean()
          .default(false)
          .describe("Must be true: confirms the playtest is STOPPED. Importing during play (or a bad id) hangs Studio."),
      },
    },
    async (a: Json) => {
      const assetId = (a.assetId as string)?.trim();
      if (!isOvdrAssetId(assetId))
        return errOut(
          `Invalid assetId "${assetId}". Must be "ovdrassetid://NUMBER". Use overdare_assets to pick a known-good id.`,
        );
      if (a.confirmStopped !== true)
        return errOut(
          "Refusing to import: stop the playtest (overdare_stop), then call again with confirmStopped=true. Importing during play hangs Studio.",
        );
      const known = findAsset(assetId);
      const assetName = (a.assetName as string) ?? known?.name;
      if (!assetName)
        return errOut(`assetName is required for an id not in the catalog (${assetId}).`);
      try {
        const result = await client.call("asset_drawer.import", {
          assetid: assetId,
          assetName,
          assetType: "MODEL",
        });
        const warn = known
          ? ""
          : `WARNING: ${assetId} is not in the curated catalog — verify it is a real Asset Drawer MODEL id (a bad id hangs Studio).\n`;
        return ok(warn + JSON.stringify({ imported: assetId, assetName, result }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_image_import",
    {
      description:
        "Import a local image file (PNG/JPG) into the asset manager and return the created asset id — use it as Image/Decal content (e.g. on an ImageLabel or a Texture). STOP the playtest first. Not subject to the bad-id hang (no id input).",
      inputSchema: {
        file: z.string().describe("Absolute path to a local image file (PNG/JPG)."),
      },
    },
    async (a: Json) => {
      const file = (a.file as string)?.trim();
      if (!file) return errOut("file (absolute path) is required.");
      if (!existsSync(file)) return errOut(`File not found: ${file}`);
      try {
        return ok(await client.call("asset_manager.image.import", { file }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ======================================================================
  //  SMART MESH IMPORT PREP  (headless Blender: fit the 30k-tri + texture limits)
  // ======================================================================
  server.registerTool(
    "overdare_mesh_prepare",
    {
      description:
        "Make any 3D file OVERDARE-import-ready via headless Blender: joins meshes, decimates to the per-mesh triangle budget (OVERDARE limit = 30,000), and downscales textures (OVERDARE recommends 512; large 4K textures OOM the importer). Accepts .fbx/.obj/.glb/.gltf/.blend and writes <name>_overdare.fbx (textures embedded) next to the input (or in outDir). The final Import into Studio is still a manual GUI step (Home > Import). Requires Blender installed — set OVERDARE_BLENDER to override the path.",
      inputSchema: {
        file: z
          .string()
          .describe("Absolute path to the source 3D file (.fbx/.obj/.glb/.gltf/.blend)."),
        maxTris: z
          .number()
          .int()
          .default(30000)
          .describe("Triangle budget per mesh (OVERDARE limit = 30000)."),
        textureSize: z
          .number()
          .int()
          .default(1024)
          .describe("Max texture dimension in px (OVERDARE recommends 512; 1024 balances detail/size)."),
        mode: z
          .enum(["decimate", "keep"])
          .default("decimate")
          .describe("'decimate' reduces an over-budget mesh to fit; 'keep' only fits textures."),
        outDir: z
          .string()
          .optional()
          .describe("Output directory (default: same folder as the input file)."),
      },
    },
    async (a: Json) => {
      try {
        const file = a.file as string;
        if (!existsSync(file)) return errOut(`File not found: ${file}`);
        const maxTris = (a.maxTris as number) ?? 30000;
        const texSize = (a.textureSize as number) ?? 1024;
        const mode = (a.mode as string) ?? "decimate";
        const outDir = (a.outDir as string) || dirname(file);
        const blender = findBlender();
        const script = fileURLToPath(new URL("../scripts/prepare_mesh.py", import.meta.url));
        if (!existsSync(script)) return errOut(`prepare_mesh.py not found at ${script}`);
        const args = [
          "--background",
          "--python",
          script,
          "--",
          file,
          outDir,
          String(maxTris),
          String(texSize),
          mode,
        ];
        let stdout = "";
        try {
          const r = await execFileP(blender, args, {
            timeout: 300000,
            maxBuffer: 32 * 1024 * 1024,
          });
          stdout = r.stdout || "";
        } catch (e) {
          const err = e as { stdout?: string; message?: string };
          stdout = err.stdout || "";
          if (!stdout.includes("PREPARE_RESULT_JSON")) {
            return errOut(`Blender run failed (${blender}): ${err.message ?? String(e)}`);
          }
        }
        const line = stdout
          .split(/\r?\n/)
          .find((l) => l.startsWith("PREPARE_RESULT_JSON "));
        if (!line) return errOut(`No result from Blender. Output tail:\n${stdout.slice(-1200)}`);
        const res = JSON.parse(line.slice("PREPARE_RESULT_JSON ".length));
        if (!res.ok) return errOut(`Mesh prep failed: ${res.error ?? "unknown"}`);
        return ok({
          ...res,
          blender,
          nextStep:
            "Import the output FBX in OVERDARE Studio: Home > Import > select the file > Import (keep defaults).",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_mesh_bulk_import",
    {
      description:
        "Get many prepared meshes into Studio in ONE trip through the UI. Packs up to 200 _overdare.fbx files into a single bundle, drives Bulk Import once, then reads the new asset ids back out of UGCLocalAssetTable.json and pairs each mesh with its texture. Returns [{asset, meshId, textureId}] ready for overdare_create_instances. Importing one file at a time costs a dialog per asset and each one is a chance for Studio to be busy or for another window to steal focus. STOP any playtest first.",
      inputSchema: {
        files: z
          .array(z.string())
          .min(1)
          .max(200)
          .describe("Absolute paths to prepared *_overdare.fbx files (max 200 — the Bulk Import limit)."),
        bundleName: z
          .string()
          .optional()
          .describe("Name for the bundle file; becomes the asset name prefix. Default: bundle_<timestamp>."),
        outDir: z.string().optional().describe("Where to write the bundle (default: folder of the first input)."),
        waitSec: z
          .number()
          .int()
          .default(300)
          .describe("How long to wait for Studio to cook and register the assets."),
      },
    },
    async (a: Json) => {
      try {
        const files = (a.files as string[]).map((f) => f.trim()).filter(Boolean);
        const missing = files.filter((f) => !existsSync(f));
        if (missing.length) return errOut(`Not found: ${missing.slice(0, 5).join(", ")}`);

        const projectDir = dirname(await getProjectFile());
        const tablePath = join(projectDir, "UGCLocalAssetTable.json");
        if (!existsSync(tablePath))
          return errOut(`No UGCLocalAssetTable.json in ${projectDir} — is that the open project?`);

        /** Registered assets, newest-id first. The table is how Studio records what it uploaded. */
        const readTable = (): Array<{ id: number; name: string; type: string }> => {
          const buf = readFileSync(tablePath);
          const enc = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : "utf8";
          const doc = JSON.parse(buf.toString(enc).replace(/^﻿/, "")) as {
            localAssetList?: Record<string, { name?: string; worldAssetType?: string }>;
          };
          return Object.entries(doc.localAssetList ?? {}).map(([id, v]) => ({
            id: Number(id),
            name: String(v?.name ?? ""),
            type: String(v?.worldAssetType ?? ""),
          }));
        };
        const beforeMaxId = Math.max(0, ...readTable().map((r) => r.id));

        // 1) bundle
        const blender = findBlender();
        const bundleScript = fileURLToPath(new URL("../scripts/bundle_meshes.py", import.meta.url));
        if (!existsSync(bundleScript)) return errOut(`bundle_meshes.py not found at ${bundleScript}`);
        const bundleName =
          (a.bundleName as string) || `bundle_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
        const outDir = (a.outDir as string) || dirname(files[0]);
        const bundlePath = join(outDir, `${bundleName}.fbx`);

        const br = await execFileP(
          blender,
          ["--background", "--python", bundleScript, "--", bundlePath, ...files],
          { timeout: 900000, maxBuffer: 64 * 1024 * 1024 },
        ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
        const bLine = (br.stdout || "").split(/\r?\n/).find((l) => l.startsWith("BUNDLE_JSON "));
        if (!bLine) return errOut("Bundling failed — no BUNDLE_JSON from Blender.");
        const bundle = JSON.parse(bLine.slice("BUNDLE_JSON ".length)) as {
          ok: boolean; error?: string; assets: Array<{ meshObject: string; images: string[] }>;
          duplicateNames?: string[]; meshObjects?: number; totalTris?: number; fileSizeMB?: number;
        };
        if (!bundle.ok) return errOut(`Bundling failed: ${bundle.error}`);
        if (bundle.duplicateNames?.length)
          return errOut(
            `Duplicate mesh names ${bundle.duplicateNames.join(", ")} — they would collide into one asset and the texture pairing would attach the wrong image. Rename the inputs.`,
          );

        // 2) one trip through Bulk Import
        const importer = fileURLToPath(new URL("../scripts/gui_import.ps1", import.meta.url));
        const ir = await execFileP(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", importer, "-Files", bundlePath, "-Bulk"],
          { timeout: 600000, maxBuffer: 16 * 1024 * 1024 },
        ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
        const importOut = ir.stdout || "";
        if (!/STATUS=IMPORTED/.test(importOut))
          return errOut(`Bulk Import did not complete:\n${importOut.trim().slice(-800)}`);

        // 3) wait for registration — cooking and uploading each mesh takes far longer
        //    than the dialog does to close, and the table only gains the ids at the end.
        const deadline = Date.now() + ((a.waitSec as number) ?? 300) * 1000;
        let fresh: Array<{ id: number; name: string; type: string }> = [];
        for (;;) {
          fresh = readTable().filter((r) => r.id > beforeMaxId);
          if (fresh.filter((r) => r.type === "STATIC_MESH").length >= bundle.assets.length) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 5000));
        }

        // 4) pair by name. Studio names the mesh "<bundle>_<meshObject>" and each
        //    texture "00_<image datablock>", and records no link between the two.
        const byName = (n: string) => fresh.find((r) => r.name === n);
        const results = bundle.assets.map((asset) => {
          const mesh = byName(`${bundleName}_${asset.meshObject}`);
          const tex = asset.images.map((i) => byName(`00_${i}`)).find(Boolean);
          return {
            asset: asset.meshObject,
            meshId: mesh ? `ovdrassetid://${mesh.id}` : null,
            textureId: tex ? `ovdrassetid://${tex.id}` : null,
          };
        });
        const incomplete = results.filter((r) => !r.meshId);

        return ok(
          JSON.stringify(
            {
              bundle: bundlePath,
              meshes: bundle.meshObjects,
              totalTris: bundle.totalTris,
              fileSizeMB: bundle.fileSizeMB,
              registered: fresh.length,
              results,
              ...(incomplete.length
                ? {
                    warning: `${incomplete.length} asset(s) have no id yet — Studio may still be uploading. Re-read UGCLocalAssetTable.json in ${projectDir} shortly.`,
                  }
                : {}),
              nextStep:
                "Place them with overdare_create_instances (meshId + raw.TextureId), then overdare_save.",
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ======================================================================
  //  EDIT-TIME ENGINE  (.ovdrjm direct edit + level.apply)
  //  Creates persistent instances the RPC can't (instance.upsert is absent).
  //  MUST NOT run during an active playtest (hangs Studio) — stop first.
  // ======================================================================
  let projectFile: string | null = null;
  let projectOverrideDir: string | null = null;

  // The project currently LOADED in Studio is the source of truth: its screenshot
  // path is <dir>/Screenshots/Agent/*.png, so we recover the dir from there. This
  // follows project switches (unlike a pinned env var).
  async function discoverLoadedProjectDir(): Promise<string | null> {
    try {
      const res = (await client.call("game.screenshot", {})) as { path?: string };
      if (res?.path) return res.path.replace(/[\\/]+Screenshots[\\/].*$/i, "");
    } catch {
      /* Studio down or method unavailable — fall through to env */
    }
    return null;
  }

  /** Project directories to consider: everything holding a .ovdrjm near the user. */
  function candidateProjectDirs(): string[] {
    const dirs = new Set<string>();
    const add = (d: string | null | undefined) => {
      if (d && existsSync(d)) dirs.add(d);
    };
    add(projectOverrideDir);
    add(discoverProjectDirFromLog());
    add(process.env.OVERDARE_PROJECT_DIR);
    const home = process.env.USERPROFILE;
    for (const base of home ? [join(home, "Desktop"), join(home, "Documents")] : []) {
      try {
        for (const name of readdirSync(base)) {
          const d = join(base, name);
          try {
            if (statSync(d).isDirectory() && readdirSync(d).some((f) => f.toLowerCase().endsWith(".ovdrjm"))) {
              dirs.add(d);
            }
          } catch {
            /* unreadable entry */
          }
        }
      } catch {
        /* no such base dir */
      }
    }
    return [...dirs];
  }

  /**
   * Identify the open project by matching the live tree's GUIDs against the files
   * on disk. Studio's log only names a project when it saves, so it can point at
   * one the user closed long ago — and editing the wrong project is silent damage.
   */
  async function discoverProjectDirByGuid(): Promise<string | null> {
    let guids: string[] = [];
    try {
      const res = (await client.call("level.browse", { depth: 0 })) as {
        level?: Array<{ guid?: string }>;
      };
      guids = (res?.level ?? [])
        .map((n) => n?.guid)
        .filter((g): g is string => typeof g === "string" && g.length > 8)
        .slice(0, 5);
    } catch {
      return null;
    }
    if (guids.length < 2) return null;
    // A project saved under a new name keeps the GUIDs of the one it came from, so
    // several files can match the same live tree. Returning the first is a coin
    // flip that silently edits the wrong project — only a unique match is an answer.
    const hits: string[] = [];
    for (const dir of candidateProjectDirs()) {
      try {
        const buf = readFileSync(findProjectFile(dir));
        const enc = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : "utf8";
        const txt = buf.toString(enc);
        if (guids.every((g) => txt.includes(g))) hits.push(dir);
      } catch {
        /* unreadable or no project file here */
      }
    }
    return hits.length === 1 ? hits[0] : null;
  }

  async function getProjectFile(): Promise<string> {
    if (projectFile) return projectFile;
    // 1) explicit override (overdare_set_project)
    if (projectOverrideDir) return (projectFile = findProjectFile(projectOverrideDir));
    // 2) ask Studio where it puts screenshots. This is the only signal that comes
    //    from the running editor itself, so it cannot name a project that is not
    //    the open one — worth the extra round trip, because every other method
    //    guesses, and a wrong guess edits somebody else's project in silence.
    const live = await discoverLoadedProjectDir();
    if (live) {
      try {
        return (projectFile = findProjectFile(live));
      } catch {
        /* keep looking */
      }
    }
    // 3) match the live tree's GUIDs against the projects on disk (unique match only)
    const byGuid = await discoverProjectDirByGuid();
    if (byGuid) {
      try {
        return (projectFile = findProjectFile(byGuid));
      } catch {
        /* keep looking */
      }
    }
    // 4) Studio's own log names the loaded project — cheap, but only rewritten on
    //    save, so it can confidently name one the user closed long ago
    const fromLog = discoverProjectDirFromLog();
    if (fromLog) {
      try {
        return (projectFile = findProjectFile(fromLog));
      } catch {
        /* no .ovdrjm there — keep looking */
      }
    }
    // 4) env fallback
    const envDir = process.env.OVERDARE_PROJECT_DIR;
    if (envDir) return (projectFile = findProjectFile(envDir));
    throw new Error(
      "Could not determine which project is loaded. Open a project in Studio, then call overdare_set_project (or set OVERDARE_PROJECT_DIR).",
    );
  }

  async function applyEdit(mutate: (doc: ReturnType<typeof loadDoc>) => unknown) {
    const file = await getProjectFile();
    const doc = loadDoc(file);
    const result = mutate(doc);
    saveDoc(file, doc);
    const apply = await client.call("level.apply", {});
    return { result, apply };
  }

  server.registerTool(
    "overdare_set_project",
    {
      description:
        "Point the .ovdrjm file-edit tools at a project, or re-detect the loaded one. By default the server auto-follows whichever project is open in Studio (via its screenshot path); call this after switching projects in Studio, or to force a specific directory. Pass no dir to clear the cache and re-detect the loaded project.",
      inputSchema: {
        dir: z
          .string()
          .optional()
          .describe(
            "Absolute path to the project directory (the folder containing the .ovdrjm). Omit to clear the cached target and re-detect the currently loaded project.",
          ),
      },
    },
    async (a: Json) => {
      try {
        projectFile = null; // invalidate cache
        const dir = (a.dir as string | undefined)?.trim();
        if (dir) {
          projectOverrideDir = dir;
          projectFile = findProjectFile(dir);
          return ok({ mode: "override", projectFile });
        }
        projectOverrideDir = null;
        const file = await getProjectFile(); // re-detects the loaded project
        return ok({ mode: "auto-detected", projectFile: file });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_create_part",
    {
      description:
        "Create a persistent Part in the editor (not runtime) by editing the .ovdrjm and reloading. Use for real, saveable map geometry. STOP any playtest first. Position/size/color scale to the world (character height ~160; baseplate is huge).",
      inputSchema: {
        parent: z.string().default("Workspace").describe("Parent GUID or dotted path (default Workspace)."),
        name: z.string().describe("Part name."),
        position: z.array(z.number()).length(3).describe("[X,Y,Z] world position."),
        size: z.array(z.number()).length(3).default([300, 300, 300]).describe("[X,Y,Z] size."),
        color: z.array(z.number()).length(3).default([163, 162, 165]).describe("[R,G,B] 0-255."),
        anchored: z.boolean().default(true),
        material: z.string().optional().describe("e.g. Plastic, Metal, Glass, Neon, Wood, Marble, Concrete."),
        shape: z.enum(["Block", "Ball", "Cylinder"]).optional(),
        transparency: z.number().optional().describe("0 (opaque) - 1 (invisible)."),
        canCollide: z.boolean().optional(),
      },
    },
    async (a: Json) => {
      try {
        const out = await applyEdit((doc) => {
          const parent = resolveNode(doc, (a.parent as string) ?? "Workspace");
          if (!parent) throw new Error(`Parent not found: ${a.parent}`);
          const node = createInstance(doc, parent, "Part", a.name as string, {
            position: a.position as CreateProps["position"],
            size: a.size as CreateProps["size"],
            color: a.color as CreateProps["color"],
            anchored: a.anchored as boolean,
            material: a.material as string | undefined,
            shape: a.shape as CreateProps["shape"],
            transparency: a.transparency as number | undefined,
            canCollide: a.canCollide as boolean | undefined,
          });
          return { guid: node.ActorGuid, objectKey: node.ObjectKey };
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_create_instance",
    {
      description:
        "Create a persistent instance of any class in the editor by editing the .ovdrjm (e.g. Folder, Model, MeshPart, Part). STOP any playtest first. `props` accepts position/size/color/anchored/meshId, plus `raw` for verbatim fields.",
      inputSchema: {
        className: z.string().describe('e.g. "Folder", "Model", "Part", "MeshPart".'),
        parent: z.string().default("Workspace").describe("Parent GUID or dotted path."),
        name: z.string(),
        props: PROPS_SHAPE.optional(),
      },
    },
    async (a: Json) => {
      try {
        const out = await applyEdit((doc) => {
          const parent = resolveNode(doc, (a.parent as string) ?? "Workspace");
          if (!parent) throw new Error(`Parent not found: ${a.parent}`);
          const node = createInstance(doc, parent, a.className as string, a.name as string, (a.props as CreateProps) ?? {});
          return { guid: node.ActorGuid, objectKey: node.ObjectKey };
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_delete_instance",
    {
      description:
        "Permanently delete an instance by GUID by editing the .ovdrjm and reloading. STOP any playtest first. (For scripts, prefer overdare_rpc script.delete.)",
      inputSchema: { guid: z.string().describe("ActorGuid to delete (from overdare_browse).") },
    },
    async (a: Json) => {
      try {
        const out = await applyEdit((doc) => {
          const removed = deleteByGuid(doc.Root, a.guid as string);
          if (!removed) throw new Error(`GUID not found: ${a.guid}`);
          return { deleted: a.guid };
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_update_instance",
    {
      description:
        "Modify existing instances' properties (and/or rename) — edits the .ovdrjm and reloads. STOP any playtest first. Use after import/create to tweak material, color, size, transparency, etc. `props` is the same shape as overdare_create_instance. Pass `guids` instead of `guid` to apply the same props to many instances in ONE reload — far faster than one call per instance when restyling a whole set (e.g. recolouring every wall segment).",
      inputSchema: {
        guid: z.string().optional().describe("ActorGuid to update (from overdare_browse)."),
        // Some clients hand arrays over as a JSON string, so accept either form.
        guids: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe("ActorGuids to update with the same props, in a single edit (max 500)."),
        props: PROPS_SHAPE.optional(),
        name: z.string().optional().describe("New name (optional; only with a single `guid`)."),
      },
    },
    async (a: Json) => {
      try {
        const raw = a.guids;
        const list: string[] =
          typeof raw === "string"
            ? (JSON.parse(raw) as string[])
            : ((raw as string[] | undefined) ?? (a.guid ? [a.guid as string] : []));
        if (list.length === 0) throw new Error("Provide `guid` or `guids`.");
        if (list.length > 500) throw new Error("At most 500 guids per call.");
        if (list.length > 1 && a.name) throw new Error("`name` only applies to a single `guid`.");
        const out = await applyEdit((doc) => {
          const done = list.map((g) => {
            const node = updateInstance(
              doc,
              g,
              (a.props as CreateProps) ?? {},
              a.name as string | undefined,
            );
            return { guid: node.ActorGuid, name: node.Name };
          });
          return done.length === 1 ? done[0] : { updated: done.length, items: done };
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_camera",
    {
      description:
        "Aim the editor viewport camera, so the next overdare_screenshot shows what you want. Editing Workspace.Camera does NOT move the viewport — this drives it for real, via the Studio's MUnrealEditorSubsystem over Remote Control.\n" +
        "Four ways to use it: `focus` frames an instance or a whole Folder/Model (it measures the subtree's bounds and backs off to fit); `position` + `lookAt` points at a world point; `position` + `orientation` sets the angle by hand; no arguments at all just reads back where the camera is.\n" +
        "All coordinates are OVERDARE cm with Y up — the UE-native axis swap is handled for you.",
      inputSchema: {
        focus: z
          .string()
          .optional()
          .describe(
            "GUID or dotted path to frame. Measures the node's subtree bounds and places the camera to fit it — the easy way to look at a landmark.",
          ),
        position: z
          .array(z.number())
          .length(3)
          .optional()
          .describe("[X,Y,Z] camera position. Ignored when `focus` is given."),
        lookAt: z
          .array(z.number())
          .length(3)
          .optional()
          .describe("[X,Y,Z] world point to face; the orientation is computed for you."),
        orientation: z
          .array(z.number())
          .length(3)
          .optional()
          .describe("[pitch,yaw,roll] degrees. Negative pitch looks down. Overridden by `lookAt`."),
        distance: z
          .number()
          .optional()
          .describe("With `focus`: how far back to sit, in cm. Default fits the bounds."),
        yaw: z
          .number()
          .optional()
          .describe("With `focus`: compass angle to view from, degrees. Default 180 (looking +Z)."),
        pitch: z
          .number()
          .optional()
          .describe("With `focus`: downward tilt, degrees. Default -20."),
      },
    },
    async (a: Json) => {
      // The subsystem is reachable through its CDO; the function operates on the live
      // editor viewport regardless. UE is Z-up, OVERDARE is Y-up, so the two axes swap.
      const SUBSYS = "/Script/UnrealEd.Default__MUnrealEditorSubsystem";
      const toUe = (p: number[]) => ({ X: p[0], Y: p[2], Z: p[1] });
      const round = (n: number) => Math.round(n * 10) / 10;
      try {
        const wantsRead =
          !a.focus && !a.position && !a.lookAt && !a.orientation;
        if (wantsRead) {
          const cur = (await rc.call(SUBSYS, "GetLevelViewportCameraInfo", {})) as Json;
          const L = cur.CameraLocation as Record<string, number>;
          const R = cur.CameraRotation as Record<string, number>;
          return ok({
            position: [round(L.X), round(L.Z), round(L.Y)],
            rotation: { pitch: round(R.Pitch), yaw: round(R.Yaw), roll: round(R.Roll) },
          });
        }

        let pos = a.position as number[] | undefined;
        let target = a.lookAt as number[] | undefined;

        if (a.focus) {
          const doc = loadDoc(await getProjectFile());
          const node = resolveNode(doc, a.focus as string);
          if (!node) throw new Error(`focus not found: ${a.focus as string}`);
          const b = subtreeBounds(node);
          if (!b) throw new Error(`focus has no positioned geometry: ${a.focus as string}`);
          target = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
          const span = Math.max(...[0, 1, 2].map((i) => b.max[i] - b.min[i]), 100);
          const dist = (a.distance as number | undefined) ?? span * 1.6;
          const yr = (((a.yaw as number | undefined) ?? 180) * Math.PI) / 180;
          const pr = (((a.pitch as number | undefined) ?? -20) * Math.PI) / 180;
          // OVERDARE-space forward for that yaw/pitch, then step back along it.
          const fwd = [-Math.sin(yr) * Math.cos(pr), Math.sin(pr), -Math.cos(yr) * Math.cos(pr)];
          pos = [0, 1, 2].map((i) => Math.round(target![i] - fwd[i] * dist));
        }

        if (!pos) throw new Error("Provide `focus`, or `position` (with `lookAt` or `orientation`).");

        let rot: { Pitch: number; Yaw: number; Roll: number };
        if (target) {
          // UE yaw measures from +X toward +Y; OVERDARE X/Z are UE X/Y.
          const d = [0, 1, 2].map((i) => target![i] - pos![i]);
          rot = {
            Pitch: round((Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI),
            Yaw: round((Math.atan2(d[2], d[0]) * 180) / Math.PI),
            Roll: 0,
          };
        } else {
          const o = (a.orientation as number[] | undefined) ?? [0, 0, 0];
          rot = { Pitch: o[0], Yaw: o[1], Roll: o[2] };
        }

        await rc.call(SUBSYS, "SetLevelViewportCameraInfo", {
          CameraLocation: toUe(pos),
          CameraRotation: rot,
        });
        return ok({ position: pos, rotation: rot, lookAt: target ?? null });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // Every editor subsystem below answers on its CDO while still acting on the live
  // editor — the same trick overdare_camera uses.
  const EDSYS = (cls: string) => `/Script/UnrealEd.Default__${cls}`;
  const LEVEL_ED = EDSYS("MLevelEditorSubsystem");
  const ACTOR_ED = EDSYS("MEditorActorSubsystem");
  const UNREAL_ED = EDSYS("MUnrealEditorSubsystem");
  const retOf = (r: unknown) => (r as Json | undefined)?.ReturnValue;

  server.registerTool(
    "overdare_viewport",
    {
      description:
        "Read or change how the editor viewport renders, which is what overdare_screenshot captures. `gameView` hides the editor-only overlay (grid, gizmo, billboards) for a clean shot; `invalidate` forces a redraw when a screenshot looks stale. Called with no arguments it just reports the current state.",
      inputSchema: {
        gameView: z
          .boolean()
          .optional()
          .describe("true hides the editor overlay for clean screenshots; false restores it."),
        invalidate: z.boolean().optional().describe("Force the viewport to redraw."),
      },
    },
    async (a: Json) => {
      try {
        if (a.gameView !== undefined) {
          await rc.call(LEVEL_ED, "EditorSetGameView", {
            bGameView: a.gameView as boolean,
            ViewportConfigKey: "",
          });
        }
        if (a.invalidate) await rc.call(LEVEL_ED, "EditorInvalidateViewports", {});
        const gv = await rc.call(LEVEL_ED, "EditorGetGameView", { ViewportConfigKey: "" });
        const playing = await rc.call(LEVEL_ED, "IsInPlayInEditor", {});
        return ok({ gameView: retOf(gv), isPlaying: retOf(playing) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_actors",
    {
      description:
        "List the LIVE actors in the editor world with their Unreal object paths — the handles the selection and low-level Remote Control tools need. This is the engine's view, not the DataModel: use overdare_browse for the Luau tree and its GUIDs. Filter by substring and cap the count, since a built map runs to hundreds of actors.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring of the actor path."),
        limit: z.number().optional().describe("Max paths to return (default 50)."),
      },
    },
    async (a: Json) => {
      try {
        const all = (retOf(await rc.call(ACTOR_ED, "GetAllLevelActors", {})) ?? []) as string[];
        const f = (a.filter as string | undefined)?.toLowerCase();
        const hits = f ? all.filter((p) => p.toLowerCase().includes(f)) : all;
        const limit = (a.limit as number | undefined) ?? 50;
        const world = retOf(await rc.call(UNREAL_ED, "GetEditorWorld", {}));
        return ok({ world, total: all.length, matched: hits.length, actors: hits.slice(0, limit) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_selection",
    {
      description:
        "Read or change the editor's actor selection — handy for showing the user what you are talking about, since selected actors are outlined in the viewport (and in a screenshot). Takes Unreal actor paths from overdare_actors, not DataModel GUIDs. With no arguments it reports the current selection.",
      inputSchema: {
        actors: z
          .array(z.string())
          .optional()
          .describe("Actor paths to select (replaces the selection unless `add` is true)."),
        add: z.boolean().optional().describe("Add to the selection instead of replacing it."),
        clear: z.boolean().optional().describe("Deselect everything."),
        all: z.boolean().optional().describe("Select every actor in the level."),
        invert: z.boolean().optional().describe("Invert the current selection."),
      },
    },
    async (a: Json) => {
      try {
        const world = retOf(await rc.call(UNREAL_ED, "GetEditorWorld", {})) as string;
        if (a.clear || (a.actors && !a.add)) await rc.call(ACTOR_ED, "SelectNothing", {});
        if (a.all) await rc.call(ACTOR_ED, "SelectAll", { InWorld: world });
        if (a.invert) await rc.call(ACTOR_ED, "InvertSelection", { InWorld: world });
        for (const p of (a.actors as string[] | undefined) ?? []) {
          await rc.call(ACTOR_ED, "SetActorSelectionState", { Actor: p, bShouldBeSelected: true });
        }
        const sel = (retOf(await rc.call(ACTOR_ED, "GetSelectedLevelActors", {})) ?? []) as string[];
        return ok({ selected: sel.length, actors: sel.slice(0, 50) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_console",
    {
      description:
        "Run an Unreal console command in Studio, or read a console variable. This is the widest lever the server has — the whole `r.*`, `show`, `stat` and `HighResShot` surface — so it is also the sharpest: commands are executed verbatim and some (quit, level travel) will disrupt the session. Prefer a dedicated tool when one exists.\n" +
        "Examples: `r.ScreenPercentage 150` then a screenshot for a crisper shot; `stat fps` for an FPS overlay; `HighResShot 2` for a high-resolution capture.",
      inputSchema: {
        command: z.string().optional().describe('Console command, e.g. "r.ScreenPercentage 150".'),
        cvar: z.string().optional().describe("Console variable to read back, e.g. \"r.ScreenPercentage\"."),
      },
    },
    async (a: Json) => {
      const KISMET = "/Script/Engine.Default__KismetSystemLibrary";
      try {
        if (!a.command && !a.cvar) throw new Error("Provide `command` and/or `cvar`.");
        const world = retOf(await rc.call(UNREAL_ED, "GetEditorWorld", {})) as string;
        if (a.command) {
          await rc.call(KISMET, "ExecuteConsoleCommand", {
            WorldContextObject: world,
            Command: a.command as string,
          });
        }
        // A cvar has one real type; read every getter and let the caller pick, rather
        // than guessing wrong and reporting 0 for a string.
        let value: Json | undefined;
        if (a.cvar) {
          const name = a.cvar as string;
          const read = async (fn: string) => {
            try {
              return retOf(await rc.call(KISMET, fn, { VariableName: name }));
            } catch {
              return undefined;
            }
          };
          value = {
            float: await read("GetConsoleVariableFloatValue"),
            int: await read("GetConsoleVariableIntValue"),
            bool: await read("GetConsoleVariableBoolValue"),
            string: await read("GetConsoleVariableStringValue"),
          };
        }
        return ok({ executed: (a.command as string) ?? null, cvar: (a.cvar as string) ?? null, value });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_engine_assets",
    {
      description:
        "Query the engine's asset registry — what Unreal actually has loaded, as opposed to UGCLocalAssetTable.json (the project's own contentId registry, which only updates on save). Useful for confirming an import really landed: freshly imported meshes and textures appear under /Asset/TempImportedAssetDir. Pass `directory` to list, or `assetPath` to test one.",
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe('Directory to list, e.g. "/Asset/TempImportedAssetDir". Default that path.'),
        recursive: z.boolean().optional().describe("Recurse into subdirectories (default true)."),
        assetPath: z.string().optional().describe("Instead of listing, test whether this asset exists."),
        limit: z.number().optional().describe("Max entries to return (default 100)."),
      },
    },
    async (a: Json) => {
      const ASSET_ED = EDSYS("MEditorAssetSubsystem");
      try {
        if (a.assetPath) {
          const r = await rc.call(ASSET_ED, "DoesAssetExist", { AssetPath: a.assetPath as string });
          return ok({ assetPath: a.assetPath, exists: retOf(r) });
        }
        const dir = (a.directory as string | undefined) ?? "/Asset/TempImportedAssetDir";
        const r = await rc.call(ASSET_ED, "ListAssets", {
          DirectoryPath: dir,
          bRecursive: (a.recursive as boolean | undefined) ?? true,
          bIncludeFolder: false,
        });
        const list = (retOf(r) ?? []) as string[];
        const limit = (a.limit as number | undefined) ?? 100;
        return ok({ directory: dir, total: list.length, assets: list.slice(0, limit) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_move_instance",
    {
      description:
        'Reparent an instance under a new parent — edits the .ovdrjm and reloads. STOP any playtest first. Essential after overdare_asset_import (imports land under Workspace; move UI to "StarterGui").',
      inputSchema: {
        guid: z.string().describe("ActorGuid to move (from overdare_browse)."),
        newParent: z.string().describe('New parent GUID or dotted path (e.g. "StarterGui").'),
      },
    },
    async (a: Json) => {
      try {
        const out = await applyEdit((doc) => {
          const parent = resolveNode(doc, a.newParent as string);
          if (!parent) throw new Error(`New parent not found: ${a.newParent}`);
          if (!parent.ActorGuid) throw new Error(`New parent has no GUID (cannot move here): ${a.newParent}`);
          moveInstance(doc.Root, a.guid as string, parent.ActorGuid);
          return { moved: a.guid, to: parent.ActorGuid, parentName: parent.Name };
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_create_instances",
    {
      description:
        "Bulk-create multiple instances under one parent in a single edit (one reload). STOP any playtest first. Best for classes already present in the project (e.g. Part); for novel classes, import a template first. Max 50.",
      inputSchema: {
        parent: z.string().default("Workspace").describe("Parent GUID or dotted path."),
        items: z
          .array(
            z.object({
              className: z.string(),
              name: z.string(),
              props: PROPS_SHAPE.optional(),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe("Instances to create."),
        itemsFile: z
          .string()
          .optional()
          .describe(
            "Path to a JSON file holding the same array as `items` (max 200). Use this when a generator script produced the layout — it avoids pasting a large array through the tool call.",
          ),
      },
    },
    async (a: Json) => {
      try {
        const out = await applyEdit((doc) => {
          const parent = resolveNode(doc, (a.parent as string) ?? "Workspace");
          if (!parent) throw new Error(`Parent not found: ${a.parent}`);
          type NewItem = { className: string; name: string; props?: CreateProps };
          let list = a.items as NewItem[] | undefined;
          if (a.itemsFile) {
            const txt = readFileSync(a.itemsFile as string, "utf8");
            list = JSON.parse(txt) as NewItem[];
          }
          if (!Array.isArray(list) || list.length === 0) {
            throw new Error("Provide `items` or `itemsFile`.");
          }
          if (list.length > 200) throw new Error("At most 200 items per call.");
          const nodes = createInstances(doc, parent, list);
          return nodes.map((n) => ({ guid: n.ActorGuid, name: n.Name }));
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ======================================================================
  //  READ / SEARCH / EDIT existing content (.ovdrjm — fills absent RPCs)
  //  instance.read / script.read / script.edit are -32002 on this build, but
  //  the data lives in the .ovdrjm, so we serve it from the file.
  // ======================================================================
  server.registerTool(
    "overdare_read_instance",
    {
      description:
        "Read an instance's properties from the saved project (.ovdrjm) — fills the gap left by the absent instance.read RPC. Returns the node's fields (Material, Size, CFrame, Transparency, …) plus a summary of its children. Pair with overdare_update_instance to change them. (Reads the saved file — overdare_save first if you have unsaved edits.)",
      inputSchema: {
        ref: z.string().describe('ActorGuid or dotted path (e.g. "Workspace.Baseplate").'),
      },
    },
    async (a: Json) => {
      try {
        const doc = loadDoc(await getProjectFile());
        const node = resolveNode(doc, a.ref as string);
        if (!node) return errOut(`Not found: ${a.ref}`);
        const { LuaChildren, ...props } = node;
        const children = (LuaChildren ?? []).map((c) => ({ guid: c.ActorGuid, name: c.Name, class: c.InstanceType }));
        return ok({ ...props, childCount: children.length, children: children.slice(0, 50) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_script_read",
    {
      description:
        "Read an existing script's Luau source from the saved project (.ovdrjm) — fills the gap left by the absent script.read RPC. Use before overdare_script_edit to see what you're changing.",
      inputSchema: {
        ref: z.string().describe("ActorGuid or dotted path of a Script/LocalScript/ModuleScript."),
      },
    },
    async (a: Json) => {
      try {
        const doc = loadDoc(await getProjectFile());
        const node = resolveNode(doc, a.ref as string);
        if (!node) return errOut(`Not found: ${a.ref}`);
        if (node.Source === undefined)
          return errOut(`Not a script (no Source field): ${a.ref} [${node.InstanceType}]`);
        return ok({
          guid: node.ActorGuid,
          name: node.Name,
          class: node.InstanceType,
          enabled: node.Enabled,
          source: node.Source,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_find",
    {
      description:
        "Search the project tree by name substring and/or class, returning matching nodes with guid + dotted path. Far more practical than overdare_browse on large projects (e.g. after importing the TPA combat template).",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive name substring."),
        className: z.string().optional().describe('Exact InstanceType, e.g. "Part", "Script", "TextButton".'),
        limit: z.number().int().default(50),
      },
    },
    async (a: Json) => {
      try {
        if (!a.query && !a.className) return errOut("Provide query and/or className.");
        const doc = loadDoc(await getProjectFile());
        const hits = findNodes(doc.Root, {
          name: a.query as string | undefined,
          className: a.className as string | undefined,
          limit: a.limit as number,
        });
        return ok(hits.map((h) => ({ guid: h.node.ActorGuid, name: h.node.Name, class: h.node.InstanceType, path: h.path })));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_script_edit",
    {
      description:
        "Replace an existing script's Luau source (and/or toggle Enabled) by editing the .ovdrjm and reloading — fills the gap left by the absent script.edit RPC. STOP any playtest first. Use TABS for indentation. (To create a NEW script use overdare_script_add.)",
      inputSchema: {
        guid: z.string().describe("ActorGuid of the script (from overdare_find/browse)."),
        source: z.string().optional().describe("New full Luau source (tabs for indentation)."),
        enabled: z.boolean().optional().describe("Enable/disable the script."),
      },
    },
    async (a: Json) => {
      try {
        if (a.source === undefined && a.enabled === undefined) return errOut("Provide source and/or enabled.");
        const out = await applyEdit((doc) => {
          const node = resolveNode(doc, a.guid as string);
          if (!node) throw new Error(`Not found: ${a.guid}`);
          if (node.Source === undefined)
            throw new Error(`Not a script (no Source field): ${a.guid} [${node.InstanceType}]`);
          if (a.source !== undefined) node.Source = a.source as string;
          if (a.enabled !== undefined) node.Enabled = a.enabled as boolean;
          return { guid: node.ActorGuid, name: node.Name, enabled: node.Enabled };
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_duplicate_instance",
    {
      description:
        "Duplicate an existing instance (and its whole subtree) with fresh GUIDs by editing the .ovdrjm and reloading. STOP any playtest first. Great for replicating a built platform or decorated model. Internal weld/ref links aren't remapped (fine for parts/models/scripts/UI).",
      inputSchema: {
        guid: z.string().describe("ActorGuid to duplicate (from overdare_find/browse)."),
        parent: z.string().optional().describe("New parent GUID/path (default: same parent as the original)."),
        name: z.string().optional().describe("Name for the copy (default: <Original>_Copy)."),
      },
    },
    async (a: Json) => {
      try {
        const out = await applyEdit((doc) => {
          let newParentGuid: string | undefined;
          if (a.parent) {
            const parent = resolveNode(doc, a.parent as string);
            if (!parent || !parent.ActorGuid) throw new Error(`Parent not found / no GUID: ${a.parent}`);
            newParentGuid = parent.ActorGuid;
          }
          const copy = duplicateInstance(doc, a.guid as string, newParentGuid, a.name as string | undefined);
          return { guid: copy.ActorGuid, name: copy.Name };
        });
        return ok(out.result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ======================================================================
  //  UNREAL REMOTE CONTROL  (127.0.0.1:30010) — low-level engine layer
  // ======================================================================
  const rc = new RemoteControlClient();

  // Unreal Python is optional in OVERDARE's UE build — probe once (read-only,
  // via describe) and cache the result so we never run code on a missing plugin.
  const PY_OBJ = "/Script/PythonScriptPlugin.Default__PythonScriptLibrary";
  let pythonProbe: boolean | null = null;
  async function pythonAvailable(): Promise<boolean> {
    if (pythonProbe !== null) return pythonProbe;
    try {
      await rc.describe(PY_OBJ);
      pythonProbe = true;
    } catch {
      pythonProbe = false;
    }
    return pythonProbe;
  }

  server.registerTool(
    "overdare_rc_search_assets",
    {
      description:
        "Search OVERDARE's Unreal asset library (StaticMesh, Texture2D, etc.) via Remote Control. Use to find 3D meshes/textures by name or class. e.g. classNames=['StaticMesh'], query='tree'.",
      inputSchema: {
        query: z.string().default("").describe("Name substring."),
        classNames: z.array(z.string()).optional().describe('e.g. ["StaticMesh"].'),
        packagePaths: z.array(z.string()).optional().describe('e.g. ["/Game/CreatorPlatform"].'),
        recursive: z.boolean().default(true),
        limit: z.number().int().default(25),
      },
    },
    async (a: Json) => {
      try {
        return ok(
          await rc.searchAssets({
            query: a.query as string,
            classNames: a.classNames as string[] | undefined,
            packagePaths: a.packagePaths as string[] | undefined,
            recursive: a.recursive as boolean,
            limit: a.limit as number,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_rc_call",
    {
      description:
        "Call a UFunction on an Unreal object via Remote Control (advanced, low-level). objectPath is a UObject path; functionName + parameters per the UFunction signature.",
      inputSchema: {
        objectPath: z.string(),
        functionName: z.string(),
        parameters: z.record(z.any()).optional(),
      },
    },
    async (a: Json) => {
      try {
        return ok(await rc.call(a.objectPath as string, a.functionName as string, (a.parameters as Json) ?? {}));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_rc_property",
    {
      description:
        "Read or write a property on an Unreal object via Remote Control. Omit `value` to read; provide it to write.",
      inputSchema: {
        objectPath: z.string(),
        propertyName: z.string(),
        value: z.any().optional().describe("If provided, writes; otherwise reads."),
      },
    },
    async (a: Json) => {
      try {
        if (a.value === undefined)
          return ok(await rc.getProperty(a.objectPath as string, a.propertyName as string));
        return ok(await rc.setProperty(a.objectPath as string, a.propertyName as string, a.value));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_rc_describe",
    {
      description: "Describe an Unreal object (its properties/functions) via Remote Control.",
      inputSchema: { objectPath: z.string() },
    },
    async (a: Json) => {
      try {
        return ok(await rc.describe(a.objectPath as string));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_rc_batch",
    {
      description:
        "Run several Unreal Remote Control requests in one round-trip (PUT /remote/batch). Each item is {URL, Verb, Body?}. Advanced/low-level — efficient for bulk property reads/writes on UObjects.",
      inputSchema: {
        requests: z
          .array(
            z.object({
              RequestId: z.number().optional(),
              URL: z.string().describe('e.g. "/remote/object/property".'),
              Verb: z.string().describe('"GET" | "PUT".'),
              Body: z.record(z.any()).optional(),
            }),
          )
          .min(1)
          .describe("Remote Control requests to batch."),
      },
    },
    async (a: Json) => {
      try {
        return ok(
          await rc.batch(
            a.requests as Array<{ RequestId?: number; URL: string; Verb: string; Body?: unknown }>,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_rc_python",
    {
      description:
        "Run an Unreal Python command in the editor (ExecutePythonCommand) via Remote Control. EXPERIMENTAL — OVERDARE's build may omit/sandbox the Python plugin; this tool first probes availability (read-only) and refuses if absent. NOTE: Python acts on the live Unreal level, NOT the saveable Lua/.ovdrjm layer — changes won't persist to the game.",
      inputSchema: {
        command: z.string().describe('Unreal Python source, e.g. "import unreal; print(unreal.SystemLibrary.get_engine_version())".'),
      },
    },
    async (a: Json) => {
      try {
        if (!(await pythonAvailable()))
          return errOut("Unreal Python is not available in this OVERDARE build (PythonScriptLibrary not found via Remote Control).");
        return ok(await rc.call(PY_OBJ, "ExecutePythonCommand", { CommandString: a.command as string }, false));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "overdare_rc_list_actors",
    {
      description:
        "Introspect a live Unreal object via Remote Control describe (EXPERIMENTAL, low-level). The OVERDARE world/level object path is build-specific — pass objectPath to inspect a known object. For the game DataModel tree, use overdare_browse instead.",
      inputSchema: {
        objectPath: z
          .string()
          .optional()
          .describe('UObject path to describe (e.g. a path from overdare_rc_search_assets). Defaults to a generic engine object.'),
      },
    },
    async (a: Json) => {
      try {
        const path = (a.objectPath as string) ?? "/Script/Engine.Default__GameInstance";
        return ok(await rc.describe(path));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- Diagnostics (capability/health, à la Blender MCP's *_status) ------
  server.registerTool(
    "overdare_status",
    {
      description:
        "Diagnostic: report what's reachable and configured — Studio RPC (13377), UE Remote Control (30010), Unreal Python availability, the resolved project file, and OVERDARE_PROJECT_DIR. Call this first when something isn't working, or to confirm the environment before building. (May take a few seconds if Studio is down.)",
      inputSchema: {},
    },
    async () => {
      const out: Record<string, unknown> = { server: "overdare-mcp" };
      try {
        await client.call("level.browse", {});
        out.studioRpc = `reachable (${client.endpoint})`;
      } catch (e) {
        out.studioRpc = `UNREACHABLE — is OVERDARE Studio running with a project open? (${client.endpoint})`;
      }
      let rcUp = false;
      try {
        await rc.info();
        rcUp = true;
        out.ueRemoteControl = `reachable (${rc.endpoint})`;
      } catch {
        out.ueRemoteControl = `unreachable (${rc.endpoint})`;
      }
      out.unrealPython = rcUp ? ((await pythonAvailable()) ? "available" : "absent") : "unknown (Remote Control down)";
      out.projectDirEnv = process.env.OVERDARE_PROJECT_DIR ?? "(not set — discovered from a screenshot path)";
      try {
        out.projectFile = await getProjectFile();
      } catch (e) {
        out.projectFile = `unresolved (${(e as Error).message.slice(0, 70)})`;
      }
      return ok(out);
    },
  );

  // ---- Escape hatch ------------------------------------------------------
  server.registerTool(
    "overdare_rpc",
    {
      description:
        "Low-level escape hatch: call any Studio RPC method with raw params. Use for methods without a dedicated tool or to probe the protocol. Verified methods: level.browse/apply/save.file/publish, script.add, instance.delete, game.play/stop/screenshot. (Note: instance.read/upsert/move and script.read/edit/grep are NOT available on the current Studio build.)",
      inputSchema: {
        method: z.string().describe('RPC method, e.g. "level.browse".'),
        params: z.record(z.any()).optional().describe("Raw params object."),
      },
    },
    async (args: Json) => {
      try {
        return ok(await client.call(args.method as string, (args.params as Json) ?? {}));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
