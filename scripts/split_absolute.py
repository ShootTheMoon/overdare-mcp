"""
split_absolute.py — cut one authored asset into <=30k-tri pieces that need NO reassembly math.

  blender --background --python split_absolute.py -- <file.blend> <objectName> <outDir> [maxTris]

Why this exists: the previous splitter re-centred every piece on its own origin and reported an
offset, so placing the asset meant recomputing  piecePos = assetPos + Rz(yaw)*(offset*scale)  for
each piece. Every term there is a chance to be wrong, and it was wrong (offsets got double-counted,
assemblies sheared).

This splitter never moves anything. Each piece is exported with the asset's WORLD coordinates baked
into its vertices, so all pieces share one origin: the world origin. Placing the asset is then a
single anchor for every piece — same position, same rotation, no offsets, no per-piece math. The
pieces cannot drift relative to each other because nothing ever recomputed their relation.

Pieces are cut by material first (each piece keeps its own original texture at full resolution),
then any piece still over budget is cut again by connected geometry / bisection.

Prints one line:  SPLIT_JSON {"asset":..., "anchor":[x,y,z], "dims":[...], "pieces":[{file,tris,image}]}
"""
import bpy, sys, os, json, bmesh
from mathutils import Vector

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
blend    = argv[0]
obj_name = argv[1]
outdir   = argv[2]
max_tris = int(argv[3]) if len(argv) > 3 else 30000

if blend:
    bpy.ops.wm.open_mainfile(filepath=blend)
os.makedirs(outdir, exist_ok=True)


def tris(o):
    return sum((len(p.vertices) - 2) for p in o.data.polygons)


def image_of(mat):
    if mat and mat.use_nodes:
        for n in mat.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                return n.image.name
    return ""


def deselect():
    bpy.ops.object.select_all(action='DESELECT')


src = bpy.data.objects[obj_name]

# --- 1. Collect the asset's geometry and bake world transforms into vertices. --
# Most assets are an EMPTY at the top with the real meshes parented underneath
# (sometimes several levels down); a few, like the gate, are a mesh themselves.
# Gather every MESH descendant, duplicate it, and apply its full world transform.
# After that the mesh data itself carries the asset's world position, so every
# piece cut from it inherits those coordinates and needs no offset to be placed.
def mesh_descendants(root):
    found = []
    stack = [root]
    while stack:
        n = stack.pop()
        if n.type == 'MESH' and n.data:
            found.append(n)
        stack.extend(n.children)
    return found


sources = mesh_descendants(src)
if not sources:
    print("SPLIT_JSON " + json.dumps({"asset": obj_name, "error": "no mesh geometry"}))
    sys.exit(0)

deselect()
for s in sources:
    s.hide_set(False)
    s.select_set(True)
bpy.context.view_layer.objects.active = sources[0]
bpy.ops.object.duplicate()
dups = [o for o in bpy.context.selected_objects if o.type == 'MESH']
# Detach from the parent EMPTY chain FIRST, keeping the world transform. Without
# this, transform_apply only bakes the object's own local matrix and the parent's
# placement is silently dropped — the asset lands near the origin at the wrong size.
deselect()
for o in dups:
    o.select_set(True)
bpy.context.view_layer.objects.active = dups[0]
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
# apply each copy's own world transform before joining — a shared join would
# otherwise collapse their differing local origins onto one.
for o in dups:
    deselect()
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
deselect()
for o in dups:
    o.select_set(True)
bpy.context.view_layer.objects.active = dups[0]
if len(dups) > 1:
    bpy.ops.object.join()
work = bpy.context.active_object
work.name = obj_name + "_ABS"

# Measure straight off the vertices, never off bound_box: bound_box is cached and
# still holds pre-join values right after a join, which reads as a wildly wrong size.
def bbox(o):
    vs = o.data.vertices
    if not vs:
        return [0.0] * 3, [0.0] * 3
    mn = [min(v.co[i] for v in vs) for i in range(3)]
    mx = [max(v.co[i] for v in vs) for i in range(3)]
    return ([(mn[i] + mx[i]) / 2 for i in range(3)],
            [mx[i] - mn[i] for i in range(3)])


anchor, dims = bbox(work)

# --- 2. Cut by material. Each piece keeps its own texture. --------------------
pieces = []
if len(work.material_slots) > 1:
    deselect()
    work.select_set(True)
    bpy.context.view_layer.objects.active = work
    bpy.ops.mesh.separate(type='MATERIAL')
    pieces = [o for o in bpy.context.selected_objects if o.type == 'MESH']
else:
    pieces = [work]

# --- 3. Any piece still over budget is cut again — never scaled, never moved. -
# Everything below tracks objects by NAME, never by Python reference: separate() and
# remove() invalidate held references, and a stale one shows up later as `o.data is
# None` mid-loop. Names survive those operations.
def alive(name):
    o = bpy.data.objects.get(name)
    return o if (o and o.type == 'MESH' and o.data) else None


def split_over_budget(names):
    out = []
    queue = list(names)
    guard = 0
    while queue and guard < 8000:
        guard += 1
        nm = queue.pop(0)
        o = alive(nm)
        if not o:
            continue
        t = tris(o)
        if t == 0:
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        if t <= max_tris:
            out.append(nm)
            continue
        # try loose parts first — keeps whole sub-objects intact
        deselect()
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        before = set(bpy.data.objects.keys())
        bpy.ops.mesh.separate(type='LOOSE')
        made = list(set(bpy.data.objects.keys()) - before)
        if made:
            queue.extend([nm] + made)
            continue
        # single connected blob: bisect along its longest axis at the median
        o = alive(nm)
        if not o:
            continue
        bb = [Vector(c) for c in o.bound_box]
        axis = max(range(3), key=lambda i: max(v[i] for v in bb) - min(v[i] for v in bb))
        mid = sum(v[axis] for v in bb) / 8
        no = [0.0, 0.0, 0.0]
        no[axis] = 1.0
        bm = bmesh.new()
        bm.from_mesh(o.data)
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6,
                               plane_co=tuple(mid * no[i] for i in range(3)),
                               plane_no=tuple(no))
        bm.to_mesh(o.data)
        bm.free()
        deselect()
        o = alive(nm)
        if not o:
            continue
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        before = set(bpy.data.objects.keys())
        bpy.ops.mesh.separate(type='LOOSE')
        made = list(set(bpy.data.objects.keys()) - before)
        if made:
            queue.extend([nm] + made)
        else:
            out.append(nm)  # cannot cut further; accept it
    return out


pieces = split_over_budget([o.name for o in pieces])

# --- 3b. Pack the fragments back up to the budget. ---------------------------
# Cutting by material and then by loose part leaves hundreds of tiny shells (a single
# bolt, one letter of an inscription). Each one would cost a whole import slot and a
# whole MeshPart. Merging is free here precisely because nothing was re-centred: two
# pieces that share a texture can be joined and the result still sits in world space.
# So refill: greedily join same-texture pieces until the next one would break 30k.
def pack(names):
    by_img = {}
    for nm in names:
        o = alive(nm)
        if not o:
            continue
        mat = o.material_slots[0].material if o.material_slots else None
        by_img.setdefault(image_of(mat), []).append(nm)
    packed = []
    for img, group in by_img.items():
        group.sort(key=lambda n: -tris(alive(n)))
        bins = []  # [[names], total]
        for nm in group:
            t = tris(alive(nm))
            for b in bins:
                if b[1] + t <= max_tris:
                    b[0].append(nm)
                    b[1] += t
                    break
            else:
                bins.append([[nm], t])
        for names_in_bin, _ in bins:
            if len(names_in_bin) == 1:
                packed.append(names_in_bin[0])
                continue
            deselect()
            objs = [alive(n) for n in names_in_bin]
            objs = [o for o in objs if o]
            if not objs:
                continue
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            keep = objs[0].name
            bpy.ops.object.join()
            packed.append(keep)
    return packed


pieces = pack(pieces)

# --- 4. Re-centre each piece on its own origin, then export. -----------------
# CRITICAL: the vertices currently hold WORLD coordinates, but the object origin is
# still at (0,0,0). OVERDARE seats a MeshPart's mesh by its ORIGIN, and sizes it by
# the origin-relative bounds — so a mesh whose geometry sits 40 m from its origin is
# rendered 40 m off and its Size balloons to ~80 m. That is exactly what blew the
# Trabant up to 105 m.
#
# The fix: measure the piece's world centre FIRST (from the world-space verts), then
# move the origin to the geometry and drop the object to (0,0,0) so the mesh is
# centred on its own origin with tight bounds. The recorded world centre becomes the
# MeshPart position. Each piece is still placed at its own absolute centre — there is
# no shared anchor and no offset/rotation/scale arithmetic to get wrong — but now the
# mesh origin coincides with its geometry, so Size stays correct and nothing drifts.
safe = "".join(c if c.isalnum() or c in "_-" else "_" for c in obj_name)
result = []
survivors = [n for n in pieces if alive(n)]
survivors.sort(key=lambda n: -tris(alive(n)))
for i, nm in enumerate(survivors):
    o = alive(nm)
    o.rotation_euler = (0.0, 0.0, 0.0)
    o.scale = (1.0, 1.0, 1.0)
    c, d = bbox(o)                       # world centre + dims, BEFORE re-centring
    name = "%s_p%02d" % (safe, i)
    o.name = name
    deselect()
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
    o.location = (0.0, 0.0, 0.0)         # geometry now centred on its own origin
    path = os.path.join(outdir, name + ".fbx")
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, path_mode='COPY',
                             embed_textures=True, object_types={'MESH'},
                             mesh_smooth_type='FACE', bake_space_transform=True)
    mat = o.material_slots[0].material if o.material_slots else None
    result.append({"file": os.path.basename(path), "tris": tris(o),
                   "image": image_of(mat), "material": mat.name if mat else "",
                   "center_m": [round(v, 5) for v in c],
                   "dims_m": [round(v, 5) for v in d]})

print("SPLIT_JSON " + json.dumps({
    "asset": obj_name,
    "anchor_m": [round(v, 4) for v in anchor],
    "dims_m": [round(v, 4) for v in dims],
    "total_tris": sum(p["tris"] for p in result),
    "pieces": result,
}))
