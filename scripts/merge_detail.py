"""
merge_detail.py — merge an asset's thin ornamental geometry into ONE connected mesh.

  blender --background --python merge_detail.py -- <file.blend> <objectName> <outDir> [maxTris] [keywords]

Why: splitting by material scatters an asset's decoration — a quadriga, a frieze band,
a run of glyphs — into many small pieces. Each is thin, each ends up its own MeshPart,
and any that loses its supporting sliver to decimation reads as a slab floating in the
air. Structure (columns, walls, roof) splits fine because it is bulky and self-supporting.

So the ornament is handled the opposite way: take every face whose material matches the
ornament keywords, keep them as ONE object, decimate to the import budget, bake the
several ornament textures into a single atlas (a MeshPart carries one texture), and
export it re-centred on its own origin with its world centre reported for placement.

Prints: DETAIL_JSON {"center_m":[...], "dims_m":[...], "tris":N, "file":"..."}
"""
import bpy, sys, os, json

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
blend, obj_name, outdir = argv[0], argv[1], argv[2]
max_tris = int(argv[3]) if len(argv) > 3 else 28000
keywords = argv[4].split(",") if len(argv) > 4 else ["BronzeStatues", "Fregio", "SideGliph"]

bpy.ops.wm.open_mainfile(filepath=blend)
os.makedirs(outdir, exist_ok=True)


def tris(o):
    return sum((len(p.vertices) - 2) for p in o.data.polygons)


def mesh_descendants(root):
    found, stack = [], [root]
    while stack:
        n = stack.pop()
        if n.type == 'MESH' and n.data:
            found.append(n)
        stack.extend(n.children)
    return found


src = bpy.data.objects[obj_name]
sources = mesh_descendants(src)
if not sources:
    print("DETAIL_JSON " + json.dumps({"error": "no mesh"}))
    sys.exit(0)

bpy.ops.object.select_all(action='DESELECT')
for s in sources:
    s.hide_set(False)
    s.select_set(True)
bpy.context.view_layer.objects.active = sources[0]
bpy.ops.object.duplicate()
dups = [o for o in bpy.context.selected_objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in dups:
    o.select_set(True)
bpy.context.view_layer.objects.active = dups[0]
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
for o in dups:
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.select_all(action='DESELECT')
for o in dups:
    o.select_set(True)
bpy.context.view_layer.objects.active = dups[0]
if len(dups) > 1:
    bpy.ops.object.join()
work = bpy.context.active_object
work.name = "DETAIL_" + obj_name

# keep only ornament faces
for p in work.data.polygons:
    m = work.material_slots[p.material_index].material if work.material_slots else None
    p.select = bool(m and any(k in m.name for k in keywords))
kept = sum(1 for p in work.data.polygons if p.select)
if kept == 0:
    print("DETAIL_JSON " + json.dumps({"error": "no ornament faces"}))
    sys.exit(0)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='INVERT')
bpy.ops.mesh.delete(type='FACE')
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.material_slot_remove_unused()

if tris(work) > max_tris:
    d = work.modifiers.new('d', 'DECIMATE')
    d.decimate_type = 'COLLAPSE'
    d.ratio = float(max_tris) / tris(work)
    bpy.ops.object.modifier_apply(modifier='d')

# one texture per MeshPart: bake the ornament's materials into a single atlas,
# sampling through the ORIGINAL uvs while writing into a fresh unwrap.
me = work.data
me.uv_layers[0].name = 'UVsrc'
atl = me.uv_layers.new(name='UVatlas')
me.uv_layers.active = atl
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.003)
bpy.ops.object.mode_set(mode='OBJECT')
me.uv_layers.active = me.uv_layers['UVatlas']
me.uv_layers['UVsrc'].active_render = True

atlas = bpy.data.images.new(obj_name + "_detail_atlas", 2048, 2048)
for s in work.material_slots:
    m = s.material
    if not m or not m.use_nodes:
        continue
    nt = m.node_tree
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = atlas
    for n in nt.nodes:
        n.select = False
    tn.select = True
    nt.nodes.active = tn

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 1
sc.render.bake.use_pass_direct = False
sc.render.bake.use_pass_indirect = False
sc.render.bake.margin = 6
bpy.ops.object.select_all(action='DESELECT')
work.select_set(True)
bpy.context.view_layer.objects.active = work
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_clear=True)

mat = bpy.data.materials.new(obj_name + "_detail_mat")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = atlas
mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = 0.9
me.materials.clear()
me.materials.append(mat)
for p in me.polygons:
    p.material_index = 0
while len(me.uv_layers) > 1:
    for l in me.uv_layers:
        if l.name != 'UVatlas':
            me.uv_layers.remove(l)
            break
me.uv_layers[0].active_render = True

vs = me.vertices
mn = [min(v.co[i] for v in vs) for i in range(3)]
mx = [max(v.co[i] for v in vs) for i in range(3)]
centre = [(mn[i] + mx[i]) / 2 for i in range(3)]
dims = [mx[i] - mn[i] for i in range(3)]

bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
work.location = (0.0, 0.0, 0.0)
safe = "".join(c if c.isalnum() or c in "_-" else "_" for c in obj_name)
path = os.path.join(outdir, safe + "_DETAIL.fbx")
bpy.ops.export_scene.fbx(filepath=path, use_selection=True, path_mode='COPY',
                         embed_textures=True, object_types={'MESH'},
                         mesh_smooth_type='FACE', bake_space_transform=True)

print("DETAIL_JSON " + json.dumps({
    "asset": obj_name,
    "file": os.path.basename(path),
    "tris": tris(work),
    "center_m": [round(v, 5) for v in centre],
    "dims_m": [round(v, 5) for v in dims],
}))
