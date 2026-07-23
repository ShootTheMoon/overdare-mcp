/**
 * .ovdrjm edit engine.
 *
 * OVERDARE's RPC on the current Studio build does not expose instance.upsert,
 * so (like the built-in diligent agent) we create/modify/delete instances by
 * editing the project's `.ovdrjm` JSON directly, then call `level.apply` to
 * make Studio reload it. This gives EDIT-TIME, persistent instances (real
 * Parts, MeshParts, Folders, Models, UI) — not just runtime script creation.
 *
 * The file is UTF-16 LE with a BOM; we preserve that. Object refs/типы use
 * tagged objects ({ObjectType:"Vector3"|"CFrame"|"Color3"|...}).
 *
 * IMPORTANT: only edit when NOT playing — writing during an active playtest
 * hangs Studio's main thread (caller must game.stop first).
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BOM = "﻿";

export interface OvNode {
  InstanceType?: string;
  ActorGuid?: string;
  ObjectKey?: number;
  Name?: string;
  LuaChildren?: OvNode[];
  [k: string]: unknown;
}
export interface OvDoc {
  FileVersion: string;
  MapObjectKeyIndex: number;
  Root: OvNode;
}

/**
 * Studio writes the project as UTF-16 LE with a BOM most of the time, but some
 * saves come back as plain UTF-8. Decoding with the wrong one yields mojibake and
 * a baffling "Unexpected token" from JSON.parse, so sniff the BOM and remember
 * what each file used — a rewrite must not silently flip the encoding either.
 */
type Enc = "utf16le" | "utf8";
const fileEncoding = new Map<string, Enc>();

export function loadDoc(file: string): OvDoc {
  const buf = readFileSync(file);
  const enc: Enc = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? "utf16le" : "utf8";
  fileEncoding.set(file, enc);
  const raw = buf.toString(enc).replace(/^﻿/, "");
  return JSON.parse(raw) as OvDoc;
}

export function saveDoc(file: string, doc: OvDoc): void {
  const enc = fileEncoding.get(file) ?? "utf16le";
  const text = JSON.stringify(doc, null, "\t");
  writeFileSync(file, enc === "utf16le" ? BOM + text : text, enc);
}

/** Find the single .ovdrjm in a project directory. */
export function findProjectFile(dir: string): string {
  const f = readdirSync(dir).find((n) => n.toLowerCase().endsWith(".ovdrjm"));
  if (!f) throw new Error(`No .ovdrjm found in ${dir}`);
  return join(dir, f);
}

export function findByGuid(node: OvNode, guid: string): OvNode | null {
  if (node.ActorGuid === guid) return node;
  for (const c of node.LuaChildren ?? []) {
    const r = findByGuid(c, guid);
    if (r) return r;
  }
  return null;
}

export function findByName(node: OvNode, name: string): OvNode | null {
  if (node.Name === name) return node;
  for (const c of node.LuaChildren ?? []) {
    const r = findByName(c, name);
    if (r) return r;
  }
  return null;
}

/** Resolve a dotted path like "Workspace.Folder.Part" from the DataModel root. */
export function findByPath(root: OvNode, path: string): OvNode | null {
  let cur: OvNode | undefined = root;
  for (const seg of path.split(".")) {
    cur = (cur?.LuaChildren ?? []).find((c) => c.Name === seg);
    if (!cur) return null;
  }
  return cur ?? null;
}

/** Accept a 32-hex ActorGuid or a dotted path; return the node. */
export function resolveNode(doc: OvDoc, ref: string): OvNode | null {
  if (/^[0-9A-Fa-f]{32}$/.test(ref)) return findByGuid(doc.Root, ref);
  if (ref === "" || ref === "Game" || ref === "DataModel") return doc.Root;
  return findByPath(doc.Root, ref);
}

export function genGuid(): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16).toUpperCase();
  return s;
}

export function nextKey(doc: OvDoc): number {
  doc.MapObjectKeyIndex = (doc.MapObjectKeyIndex || 0) + 1;
  return doc.MapObjectKeyIndex;
}

// ---- value encoders ------------------------------------------------------
type V3 = [number, number, number] | { x?: number; y?: number; z?: number; X?: number; Y?: number; Z?: number };

function vec3(v: V3) {
  const a = Array.isArray(v);
  return {
    ObjectType: "Vector3",
    X: a ? v[0] : (v.X ?? v.x ?? 0),
    Y: a ? v[1] : (v.Y ?? v.y ?? 0),
    Z: a ? v[2] : (v.Z ?? v.z ?? 0),
  };
}
function color3(c: V3) {
  const a = Array.isArray(c);
  return {
    ObjectType: "Color3",
    R: a ? c[0] : (c as any).R ?? (c as any).r ?? 200,
    G: a ? c[1] : (c as any).G ?? (c as any).g ?? 200,
    B: a ? c[2] : (c as any).B ?? (c as any).b ?? 200,
  };
}
function cframe(pos: V3, orient?: V3) {
  return {
    ObjectType: "CFrame",
    Position: vec3(pos),
    Orientation: orient ? vec3(orient) : { ObjectType: "Vector3", X: 0, Y: 0, Z: 0 },
  };
}

/** First existing instance of a class anywhere under root — used as a full-schema template. */
export function findFirstByType(node: OvNode, type: string): OvNode | null {
  if (node.InstanceType === type) return node;
  for (const c of node.LuaChildren ?? []) {
    const r = findFirstByType(c, type);
    if (r) return r;
  }
  return null;
}

/** Known Part Material values (guidance; not necessarily exhaustive — the value
 *  is passed through verbatim, so unknown-but-valid materials still work). */
export const MATERIALS = [
  "Basic", "Plastic", "Brick", "Rock", "Metal", "Unlit", "Bark", "SmallBrick",
  "LeafyGround", "MossyGround", "Ground", "Glass", "Paving", "MossyRock", "Plank",
  "Wood", "Neon", "Asphalt", "Concrete", "Marble", "MetalPlate", "Rust", "Snow",
  "StoneBrick", "StoneFloor", "SilverMetal",
] as const;

/** Friendly props -> encoded ovdrjm fields. Only confirmed-real keys are typed;
 *  use `raw` for anything else (e.g. BrickColor's nested {Number,r,g,b} form). */
export interface CreateProps {
  position?: V3;
  orientation?: V3;
  size?: V3;
  color?: V3;
  anchored?: boolean;
  canCollide?: boolean;
  transparency?: number;
  mobility?: "Movable" | "Static";
  meshId?: string;
  // additional confirmed Part fields (see instancePropertiesSchema)
  shape?: "Block" | "Ball" | "Cylinder";
  material?: string;
  castShadow?: boolean;
  canTouch?: boolean;
  canQuery?: boolean;
  canClimb?: boolean;
  locked?: boolean;
  collisionProfile?: string;
  collisionGroup?: string;
  materialVariant?: string;
  raw?: Record<string, unknown>; // escape hatch: set fields verbatim
}

export function createInstance(
  doc: OvDoc,
  parent: OvNode,
  className: string,
  name: string,
  props: CreateProps = {},
): OvNode {
  // Clone an existing instance of the same class as a full-schema template
  // (OVERDARE requires many fields, e.g. Part needs Material/Shape/BrickColor).
  // Fall back to a minimal node when no template exists (e.g. Folder).
  const template = findFirstByType(doc.Root, className);
  let node: OvNode;
  if (template) {
    node = JSON.parse(JSON.stringify(template)) as OvNode;
    delete node.LuaChildren;
  } else {
    node = { InstanceType: className };
  }
  node.ActorGuid = genGuid();
  node.ObjectKey = nextKey(doc);
  node.Name = name;
  node.Archivable = true;
  node.bDisableAdaptiveNetUpdateFrequency = false;
  // New nodes default to Movable; the update path leaves Mobility unless given.
  if (props.mobility === undefined && node.Mobility === undefined) node.Mobility = "Movable";
  applyProps(node, props);

  parent.LuaChildren = parent.LuaChildren ?? [];
  parent.LuaChildren.push(node);
  return node;
}

/** Map friendly CreateProps onto a node's encoded ovdrjm fields. Shared by
 *  createInstance and updateInstance; only sets fields that are provided. */
export function applyProps(node: OvNode, props: CreateProps): void {
  if (props.size) node.Size = vec3(props.size);
  if (props.position) node.CFrame = cframe(props.position, props.orientation);
  else if (props.orientation && node.CFrame) (node.CFrame as any).Orientation = vec3(props.orientation);
  if (props.color) node.Color = color3(props.color);
  if (props.anchored !== undefined) node.Anchored = props.anchored;
  if (props.canCollide !== undefined) node.CanCollide = props.canCollide;
  if (props.transparency !== undefined) node.Transparency = props.transparency;
  if (props.mobility !== undefined) node.Mobility = props.mobility;
  if (props.meshId) node.MeshId = props.meshId;
  if (props.shape) node.Shape = props.shape;
  if (props.material) node.Material = props.material;
  if (props.castShadow !== undefined) node.CastShadow = props.castShadow;
  if (props.canTouch !== undefined) node.CanTouch = props.canTouch;
  if (props.canQuery !== undefined) node.CanQuery = props.canQuery;
  if (props.canClimb !== undefined) node.CanClimb = props.canClimb;
  if (props.locked !== undefined) node.Locked = props.locked;
  if (props.collisionProfile) node.CollisionProfile = props.collisionProfile;
  if (props.collisionGroup) node.CollisionGroup = props.collisionGroup;
  if (props.materialVariant) node.MaterialVariant = props.materialVariant;
  if (props.raw) Object.assign(node, props.raw);
}

/** Modify an existing node in place (by guid). Reuses applyProps. */
export function updateInstance(doc: OvDoc, guid: string, props: CreateProps, name?: string): OvNode {
  const node = findByGuid(doc.Root, guid);
  if (!node) throw new Error(`GUID not found: ${guid}`);
  applyProps(node, props);
  if (name !== undefined) node.Name = name;
  return node;
}

/** Bulk-create instances under one parent (caller saves/applies once). */
export function createInstances(
  doc: OvDoc,
  parent: OvNode,
  items: Array<{ className: string; name: string; props?: CreateProps }>,
): OvNode[] {
  return items.map((it) => createInstance(doc, parent, it.className, it.name, it.props ?? {}));
}

/** Detach a node (by guid) from its parent and RETURN it (or null if absent). */
export function detachByGuid(root: OvNode, guid: string): OvNode | null {
  const kids = root.LuaChildren;
  if (kids) {
    const i = kids.findIndex((c) => c.ActorGuid === guid);
    if (i >= 0) {
      const [removed] = kids.splice(i, 1);
      return removed;
    }
    for (const c of kids) {
      const r = detachByGuid(c, guid);
      if (r) return r;
    }
  }
  return null;
}

/** Remove a node (by guid) from anywhere under root. Returns true if removed. */
export function deleteByGuid(root: OvNode, guid: string): boolean {
  return detachByGuid(root, guid) != null;
}

/** Reparent a node (by guid) under newParentGuid. Returns true on success.
 *  Validates parent existence and guards against cycles BEFORE detaching, so a
 *  bad move never loses the node. */
export function moveInstance(root: OvNode, guid: string, newParentGuid: string): boolean {
  const node = findByGuid(root, guid);
  if (!node) throw new Error(`GUID not found: ${guid}`);
  if (guid === newParentGuid) throw new Error("Cannot parent a node to itself.");
  if (findByGuid(node, newParentGuid))
    throw new Error("Cannot move a node under its own descendant (would orphan the subtree).");
  const newParent = findByGuid(root, newParentGuid);
  if (!newParent) throw new Error(`New parent not found: ${newParentGuid}`);
  const detached = detachByGuid(root, guid);
  if (!detached) return false;
  newParent.LuaChildren = newParent.LuaChildren ?? [];
  newParent.LuaChildren.push(detached);
  return true;
}

/** Find the direct parent of the node with `guid` (or null). */
export function findParentOf(root: OvNode, guid: string): OvNode | null {
  for (const c of root.LuaChildren ?? []) {
    if (c.ActorGuid === guid) return root;
    const r = findParentOf(c, guid);
    if (r) return r;
  }
  return null;
}

/** Search the tree for nodes matching a name substring and/or class.
 *  Returns matches with their dotted path. Skips the root itself. */
export function findNodes(
  root: OvNode,
  opts: { name?: string; className?: string; limit?: number } = {},
): Array<{ node: OvNode; path: string }> {
  const out: Array<{ node: OvNode; path: string }> = [];
  const limit = opts.limit ?? 100;
  const nameLc = opts.name?.toLowerCase();
  const walk = (n: OvNode, path: string) => {
    if (out.length >= limit) return;
    if (path) {
      const matchName = !nameLc || (n.Name?.toLowerCase().includes(nameLc) ?? false);
      const matchClass = !opts.className || n.InstanceType === opts.className;
      if (matchName && matchClass) out.push({ node: n, path });
    }
    for (const c of n.LuaChildren ?? [])
      walk(c, path ? `${path}.${c.Name ?? "?"}` : (c.Name ?? "?"));
  };
  walk(root, "");
  return out;
}

/** Deep-clone a subtree, assigning fresh ActorGuids + ObjectKeys to every node.
 *  NOTE: internal ObjectKey cross-references are NOT remapped — safe for parts/
 *  models/scripts/UI; complex rigs with internal welds/refs may need fixup. */
export function cloneSubtree(doc: OvDoc, node: OvNode): OvNode {
  const copy = JSON.parse(JSON.stringify(node)) as OvNode;
  const reassign = (n: OvNode) => {
    n.ActorGuid = genGuid();
    n.ObjectKey = nextKey(doc);
    for (const c of n.LuaChildren ?? []) reassign(c);
  };
  reassign(copy);
  return copy;
}

/** Duplicate an existing node (by guid) under a parent (default: same parent). */
export function duplicateInstance(
  doc: OvDoc,
  guid: string,
  newParentGuid?: string,
  newName?: string,
): OvNode {
  const orig = findByGuid(doc.Root, guid);
  if (!orig) throw new Error(`GUID not found: ${guid}`);
  const copy = cloneSubtree(doc, orig);
  copy.Name = newName ?? `${orig.Name ?? "Instance"}_Copy`;
  const parent = newParentGuid
    ? findByGuid(doc.Root, newParentGuid)
    : findParentOf(doc.Root, guid);
  if (!parent) throw new Error(newParentGuid ? `New parent not found: ${newParentGuid}` : `Could not find parent of ${guid}`);
  parent.LuaChildren = parent.LuaChildren ?? [];
  parent.LuaChildren.push(copy);
  return copy;
}
