"""
split_asset.py — cut one authored asset into pieces that each fit OVERDARE's budget.

  blender --background --python split_asset.py -- <file.blend> <outDir> <namePrefix> [maxTris]

Why split instead of decimate: OVERDARE's 30,000-triangle limit is per FILE, and a
MeshPart carries exactly one texture. Squeezing a 1M-triangle scan or a 100-material
building into one file therefore costs twice — the geometry is destroyed by the
decimation needed to fit, and 99 of its 100 textures are thrown away because only one
can survive. Splitting pays neither cost: each piece keeps its own material's texture
at full resolution, and no piece needs heavy reduction.

Pieces are cut by material first (that is what preserves the textures), then any piece
still over budget is reduced on its own — a far gentler ratio than the whole model
would have needed.

Each piece is exported re-centred on its own origin, and its offset from the asset's
centre is reported, so the caller can place the pieces back into one object:

    piecePos = assetPos + Rz(yaw) * (offset * scale)

Prints one line:  SPLIT_JSON {...}
"""
import bpy, sys, os, json
from mathutils import Vector

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
blend = argv[0] if len(argv) > 0 else ""
outdir = argv[1] if len(argv) > 1 else ""
prefix = argv[2] if len(argv) > 2 else ""
max_tris = int(argv[3]) if len(argv) > 3 else 30000
tex_size = int(argv[4]) if len(argv) > 4 else 1024
# "preserve": keep every triangle, split into as many pieces as the budget needs
#             (best fidelity, but N pieces cost N*30k of import budget).
# "fit":      keep the ORIGINAL per-material textures but reduce the whole asset to
#             fit max_tris total — one bundle, one import, no baking. This is what
#             fixes an atlas-baked landmark whose textures came out streaky, without
#             multiplying the object count.
mode = argv[5] if len(argv) > 5 else "preserve"
# Optional overall triangle target for preserve mode. A photogrammetry landmark of a
# million triangles preserved whole needs dozens of import trips, but keeping ALL of
# it is not the point — keeping the TEXTURE is. Moderate collapse (down to a third)
# leaves UVs almost untouched (measured ~3% degenerate faces), while a squeeze-to-30k
# shreds them. So reduce the whole asset to this target FIRST, then split it into
# 30k pieces: a 349k church becomes 116k -> 4 pieces -> 4 imports, texture intact.
target_total = int(argv[6]) if len(argv) > 6 else 0

result = {"blend": blend, "prefix": prefix, "ok": False, "pieces": []}


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def wire_basecolor(obj):
    """Make sure each material's texture actually reaches Base Color.

    Blender's FBX exporter only writes an image that is wired into a recognised
    BSDF input. Several of these assets carry a perfectly good baseColor image that
    is left dangling in the node tree, so the export silently comes out with the
    materials intact and no textures at all — which then reads downstream as "this
    model has no texture" and gets replaced by a flat colour.

    Returns the number of materials repaired.
    """
    fixed = 0
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        nt = mat.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)

        # Photogrammetry captures routinely ship an unlit setup — the image drives an
        # Emission through a Mix/LightPath trick and there is no Principled node at
        # all. The exporter understands none of that, so give it one it does: a
        # Principled fed by the same image, driving the material output.
        if not bsdf:
            imgs0 = [n for n in nt.nodes
                     if n.type == "TEX_IMAGE" and n.image and max(n.image.size) > 0]
            out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
            if not imgs0 or not out:
                continue
            bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
            for lk in list(nt.links):
                if lk.to_node == out and lk.to_socket.name == "Surface":
                    nt.links.remove(lk)
            nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

        base = bsdf.inputs.get("Base Color")
        if base is None or base.is_linked:
            continue
        imgs = [n for n in nt.nodes
                if n.type == "TEX_IMAGE" and n.image and max(n.image.size) > 0]
        if not imgs:
            continue
        # Prefer the colour map; normal/roughness maps would render as noise.
        def score(n):
            s = n.image.name.lower()
            if "basecolor" in s or "diffuse" in s or "albedo" in s:
                return 0
            if "normal" in s or "roughness" in s or "metallic" in s or "emissive" in s:
                return 2
            return 1
        pick = sorted(imgs, key=score)[0]
        if score(pick) == 2:          # only maps we know are wrong — leave it alone
            continue
        nt.links.new(pick.outputs["Color"], base)
        fixed += 1
    return fixed


def world_bbox(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return lo, hi


try:
    bpy.ops.wm.open_mainfile(filepath=blend)

    # Same instance-picking rule as export_asset.py: a bare prefix match grabs every
    # copy the map places, which would make one "asset" the size of the whole map.
    cands = [o for o in bpy.context.scene.objects
             if o.type == "MESH" and o.data and o.name.startswith(prefix)]
    if not cands:
        raise Exception("no objects named %s*" % prefix)
    groups = {}
    for o in cands:
        inst = o.name.split("__")[0]
        if inst != prefix and not inst.startswith(prefix + "."):
            continue
        groups.setdefault(inst, []).append(o)
    if not groups:
        raise Exception("no instance of %s" % prefix)
    inst_name = sorted(groups, key=lambda k: (-len(groups[k]), k))[0]
    picked = groups[inst_name]

    src_lo, src_hi = world_bbox(picked)
    asset_centre = Vector(((src_lo[0] + src_hi[0]) / 2,
                           (src_lo[1] + src_hi[1]) / 2,
                           (src_lo[2] + src_hi[2]) / 2))
    result["assetDim_m"] = [round(src_hi[i] - src_lo[i], 3) for i in range(3)]
    result["sourceTris"] = sum(tri_count(o) for o in picked)
    result["sourceParts"] = len(picked)

    # Work on copies with transforms baked in — the .blend keeps some assets at raw
    # modelling scale with the object transform doing the shrinking, and exporting
    # that as-is loses the scale entirely.
    bpy.ops.object.select_all(action="DESELECT")
    for o in picked:
        o.select_set(True)
    bpy.context.view_layer.objects.active = picked[0]
    bpy.ops.object.duplicate()
    copies = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    bpy.context.view_layer.objects.active = copies[0]
    try:
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    except Exception:
        pass
    try:
        bpy.ops.object.make_single_user(object=True, obdata=True, material=False, animation=False)
    except Exception:
        pass
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(copies) > 1:
        bpy.ops.object.join()
    whole = bpy.context.view_layer.objects.active
    result["materialsRewired"] = wire_basecolor(whole)

    # A MeshPart shows exactly one texture, and the FBX exporter writes every image
    # a material references — so a normal or roughness map riding along means OVERDARE
    # might pick that instead of the colour and render the surface as noise. Drop every
    # image node that is not the colour map, and make sure the colour one still drives
    # Base Color. (A material whose colour is procedural, behind mix nodes, has no
    # colour image to keep — that one genuinely needs baking, not this path.)
    def is_colour(name):
        s = name.lower()
        if any(x in s for x in ("normal", "_nor_", "rough", "metal", "_arm", "_ao",
                                "occlusion", "displac", "height", "emissive", "_orm")):
            return False
        return any(x in s for x in ("basecolor", "diffuse", "albedo", "color", "_col")) or True
    stripped = 0
    for slot in whole.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        nt = mat.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        colour = None
        for n in list(nt.nodes):
            if n.type != "TEX_IMAGE" or not n.image or max(n.image.size) == 0:
                continue
            if is_colour(n.image.name) and colour is None:
                colour = n
            else:
                nt.nodes.remove(n)
                stripped += 1
        if bsdf and colour is not None:
            base = bsdf.inputs.get("Base Color")
            if base is not None and not base.is_linked:
                nt.links.new(colour.outputs["Color"], base)
    result["nonColourImagesStripped"] = stripped

    # Scan textures come at 4K or 8K. Every piece embeds whatever it references, so
    # an 8192-square map would be carried dozens of times and OVERDARE's importer
    # runs out of memory on them anyway.
    #
    # Scaling alone is not enough: image.scale() only touches the pixels in memory,
    # while path_mode="COPY" embeds the file still sitting on disk — so the export
    # quietly ships the original 8K JPEG and each piece comes out ~17 MB. Write the
    # scaled pixels out and re-point the datablock at them.
    tex_dir = os.path.join(outdir, "_tex")
    os.makedirs(tex_dir, exist_ok=True)
    shrunk = []
    handled = set()
    for slot in whole.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        for nd in mat.node_tree.nodes:
            if nd.type != "TEX_IMAGE" or not nd.image or max(nd.image.size) == 0:
                continue
            img = nd.image
            if img.name in handled:
                continue
            handled.add(img.name)
            try:
                if max(img.size) > tex_size:
                    img.scale(tex_size, tex_size)
                    shrunk.append(img.name)
                safe = "".join(c for c in img.name if c.isalnum() or c in "._-") or "tex"
                if not safe.lower().endswith(".png"):
                    safe += ".png"
                p = os.path.join(tex_dir, safe)
                img.filepath_raw = p
                img.file_format = "PNG"
                img.save()
                if img.packed_file:
                    try:
                        img.unpack(method="REMOVE")
                    except Exception:
                        pass
                img.filepath = p
            except Exception:
                pass
    result["texturesDownscaled"] = shrunk

    # Optional overall reduction before splitting. Collapse the whole asset to the
    # target once, gently, so its UVs survive; the split afterwards then needs far
    # fewer pieces. Only kicks in when a target is set and the asset is above it.
    if target_total and tri_count(whole) > target_total:
        before_t = tri_count(whole)
        bpy.ops.object.select_all(action="DESELECT")
        whole.select_set(True)
        bpy.context.view_layer.objects.active = whole
        # weld first so a split-vertex scan reduces as a surface, not loose triangles
        try:
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.mesh.remove_doubles(threshold=0.0005)
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            try:
                bpy.ops.object.mode_set(mode="OBJECT")
            except Exception:
                pass
        cur = tri_count(whole)
        if cur > target_total:
            m = whole.modifiers.new("target", type="DECIMATE")
            m.decimate_type = "COLLAPSE"
            m.ratio = max(0.02, float(target_total) / cur)
            bpy.ops.object.modifier_apply(modifier=m.name)
        result["reducedWhole"] = [before_t, tri_count(whole)]

    # Cut by material: this is what lets every piece keep its own texture.
    bpy.ops.object.select_all(action="DESELECT")
    whole.select_set(True)
    bpy.context.view_layer.objects.active = whole
    if len(whole.material_slots) > 1:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.separate(type="MATERIAL")
        bpy.ops.object.mode_set(mode="OBJECT")
    parts = [o for o in bpy.context.scene.objects
             if o.type == "MESH" and o.data and len(o.data.polygons) and o.select_get()]
    if not parts:
        parts = [whole]

    # A single material can still blow the budget on a scan. Cut those in half along
    # their longest axis until each half fits, rather than decimating them away.
    # A million-triangle scan needs ~34 pieces at minimum, and geometry is never spread
    # evenly, so some branches have to cut deeper than others. 10 levels bounds the
    # recursion at 1024 leaves while leaving plenty of room for a lopsided model.
    def bisect_until_fits(obj, depth=0):
        if tri_count(obj) <= max_tris or depth >= 10:
            return [obj]
        lo, hi = world_bbox([obj])
        axis = max(range(3), key=lambda i: hi[i] - lo[i])
        mid = (lo[axis] + hi[axis]) / 2
        normal = [0.0, 0.0, 0.0]
        normal[axis] = 1.0
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.duplicate()
        other = bpy.context.view_layer.objects.active

        plane_co = [0.0, 0.0, 0.0]
        plane_co[axis] = mid
        for o, clear_inner in ((obj, True), (other, False)):
            bpy.ops.object.select_all(action="DESELECT")
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.mesh.bisect(plane_co=plane_co, plane_no=normal,
                                clear_inner=clear_inner, clear_outer=not clear_inner)
            bpy.ops.object.mode_set(mode="OBJECT")

        out = []
        for o in (obj, other):
            if len(o.data.polygons):
                out.extend(bisect_until_fits(o, depth + 1))
            else:
                bpy.data.objects.remove(o, do_unlink=True)
        return out

    def collapse_to(obj, target):
        """Reduce one object toward a triangle target, gently.

        Weld first so a split-vertex mesh is a surface and not loose triangles,
        dissolve coplanar faces (free on flat walls), then collapse the remainder.
        """
        if tri_count(obj) <= target:
            return
        try:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.mesh.remove_doubles(threshold=0.0005)
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            try:
                bpy.ops.object.mode_set(mode="OBJECT")
            except Exception:
                pass
        for _ in range(8):
            cur = tri_count(obj)
            if cur <= target:
                break
            m = obj.modifiers.new("dec", type="DECIMATE")
            m.decimate_type = "COLLAPSE"
            m.ratio = max(0.02, (float(target) / cur) * 0.97)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=m.name)

    if mode == "fit":
        # Keep each material as its own piece so its texture maps correctly, but share
        # one budget across them all: give each piece a slice of max_tris proportional
        # to its size, so the sum lands under the per-file limit.
        total = sum(tri_count(p) for p in parts)
        result["fitFrom"] = total
        final = [p for p in parts if len(p.data.polygons)]
        if total > max_tris:
            budget = max_tris * 0.97
            for p in final:
                share = max(200, int(budget * tri_count(p) / total))
                collapse_to(p, share)
    else:
        final = []
        for p in list(parts):
            final.extend(bisect_until_fits(p))

    os.makedirs(outdir, exist_ok=True)
    pieces = []
    for i, o in enumerate(final):
        if not len(o.data.polygons):
            continue
        lo, hi = world_bbox([o])
        centre = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2))
        offset = centre - asset_centre          # where this piece sits inside the asset

        o.location = o.location - centre        # re-centre so it imports like a normal asset
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

        name = "%s_p%02d" % (prefix, i)
        o.name = name
        o.data.name = name
        out_fbx = os.path.join(outdir, name + ".fbx")
        bpy.ops.export_scene.fbx(filepath=out_fbx, use_selection=True, path_mode="COPY",
                                 embed_textures=True, add_leaf_bones=False, bake_anim=False,
                                 object_types={"MESH"})
        pieces.append({
            "name": name,
            "file": out_fbx,
            "offset_m": [round(v, 4) for v in offset],   # Blender axes, metres
            "dim_m": [round(hi[k] - lo[k], 4) for k in range(3)],
            "tris": tri_count(o),
            "materials": [s.material.name for s in o.material_slots if s.material],
        })

    result.update({
        "ok": True,
        "instance": inst_name,
        "pieces": pieces,
        "pieceCount": len(pieces),
        "maxPieceTris": max((p["tris"] for p in pieces), default=0),
        "overBudget": [p["name"] for p in pieces if p["tris"] > max_tris],
        # Bulk Import takes 200 meshes per file, so a split past that has to be
        # imported as more than one bundle — say so rather than let it fail there.
        "needsMultipleBundles": len(pieces) > 200,
    })
except Exception as e:
    result["error"] = str(e)

print("SPLIT_JSON " + json.dumps(result))
