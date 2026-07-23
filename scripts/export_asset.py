"""
export_asset.py — pull one authored asset out of a .blend as its own FBX.

  blender --background --python export_asset.py -- <file.blend> <outFbx> <namePrefix>

The pre-exported FBX libraries often ship a simplified version of an asset while the
.blend keeps a high-quality one (e.g. the HQ_Replacements collection), so exporting
straight from the source gives the better mesh. The selection is re-centred on the
origin and dropped to Z=0 so it imports as a normal asset rather than at its world
position.

Prints one line:  ASSET_EXPORT_JSON {...}
"""
import bpy, sys, os, json
from mathutils import Vector

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
blend = argv[0] if len(argv) > 0 else ""
out_fbx = argv[1] if len(argv) > 1 else ""
prefix = argv[2] if len(argv) > 2 else ""

result = {"blend": blend, "prefix": prefix, "ok": False}


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


try:
    bpy.ops.wm.open_mainfile(filepath=blend)

    # A prefix match grabs every copy the map places — 21 street lamps scattered
    # across 170 m become one "asset" the size of the map. Group by instance
    # (Name.001__part) and export only the most complete single instance.
    candidates = [o for o in bpy.context.scene.objects
                  if o.type == "MESH" and o.data and o.name.startswith(prefix)]
    if not candidates:
        raise Exception("no objects named %s*" % prefix)

    groups = {}
    for o in candidates:
        inst = o.name.split("__")[0]
        if inst != prefix and not inst.startswith(prefix + "."):
            continue                       # a different asset sharing the prefix
        groups.setdefault(inst, []).append(o)
    if not groups:
        raise Exception("no instance of %s" % prefix)

    # most parts wins; ties go to the lowest-numbered instance
    inst_name = sorted(groups, key=lambda k: (-len(groups[k]), k))[0]
    picked = groups[inst_name]
    result["instance"] = inst_name
    result["instancesAvailable"] = len(groups)

    # Some assets hold several copies inside ONE instance name — the parts are just
    # scattered across the map — so names alone cannot separate them. Keep the
    # cluster around the biggest part and drop anything sitting far away.
    def centre_size(o):
        pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        return ([(lo[i] + hi[i]) / 2 for i in range(3)],
                max(hi[i] - lo[i] for i in range(3)))

    if len(picked) > 1:
        info = {o.name: centre_size(o) for o in picked}
        seed = max(picked, key=lambda o: info[o.name][1])
        sc, ss = info[seed.name]
        reach = max(ss * 3.0, 4.0)          # a few times the biggest part, min 4 m
        near = [o for o in picked
                if sum((info[o.name][0][i] - sc[i]) ** 2 for i in range(3)) ** 0.5 <= reach]
        if len(near) < len(picked):
            result["clusterDropped"] = len(picked) - len(near)
            picked = near

    pts = [o.matrix_world @ Vector(c) for o in picked for c in o.bound_box]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    scene_dim = [hi[i] - lo[i] for i in range(3)]

    # Work on copies, and BAKE THE TRANSFORMS IN. Some objects here hold their
    # geometry at raw modelling scale with the object transform doing the shrinking
    # — the ferris wheel is 181 m of vertices scaled down to 28 m. Exporting that
    # as-is writes the raw vertices and the scale is lost on the way out, so the
    # asset arrives six times too big. Applying the transform first makes the file
    # say exactly what the scene shows.
    bpy.ops.object.select_all(action="DESELECT")
    for o in picked:
        o.select_set(True)
    bpy.context.view_layer.objects.active = picked[0]
    bpy.ops.object.duplicate()
    copies = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    if not copies:
        raise Exception("duplicate produced nothing")

    bpy.context.view_layer.objects.active = copies[0]
    try:
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    except Exception:
        pass
    # Copies still share their mesh data with the originals, and a transform cannot
    # be applied to geometry more than one object uses — the whole export fails with
    # "Cannot apply to a multi user object". Give each copy its own data first.
    try:
        bpy.ops.object.make_single_user(object=True, obdata=True,
                                        material=False, animation=False)
    except Exception:
        pass
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(copies) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active

    # Re-centre on the origin and drop to Z=0 by moving the geometry itself, so the
    # asset imports as a normal object rather than at its position on the map.
    pts2 = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo2 = [min(p[i] for p in pts2) for i in range(3)]
    hi2 = [max(p[i] for p in pts2) for i in range(3)]
    obj.location = obj.location - Vector(
        ((lo2[0] + hi2[0]) / 2, (lo2[1] + hi2[1]) / 2, lo2[2]))
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    os.makedirs(os.path.dirname(out_fbx) or ".", exist_ok=True)

    # Give every texture a real file before exporting. Images that live only inside
    # the .blend — packed, or pointing at a path that no longer exists — have
    # nothing for path_mode="COPY" to copy, so the FBX comes out with its materials
    # intact but no images at all. Downstream that looks like an asset whose model
    # simply has no texture, and baking it then produces a flat colour.
    tex_dir = os.path.join(os.path.dirname(out_fbx) or ".", "_src_tex")
    os.makedirs(tex_dir, exist_ok=True)
    materialised = []
    seen_imgs = set()
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        for nd in mat.node_tree.nodes:
            if nd.type != "TEX_IMAGE" or not nd.image or max(nd.image.size) == 0:
                continue
            img = nd.image
            if img.name in seen_imgs:
                continue
            seen_imgs.add(img.name)
            on_disk = bool(img.filepath) and os.path.exists(bpy.path.abspath(img.filepath))
            if on_disk and not img.packed_file:
                continue
            try:
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
                materialised.append(img.name)
            except Exception as e:
                materialised.append("%s:ERR:%s" % (img.name, e))
    result["texturesMaterialised"] = materialised

    bpy.ops.export_scene.fbx(
        filepath=out_fbx,
        use_selection=True,
        path_mode="COPY",
        embed_textures=True,
        add_leaf_bones=False,
        bake_anim=False,
        object_types={"MESH"},
    )

    # Report what was actually written, not what the scene looked like — those two
    # disagreeing is precisely the bug this guards against.
    written = [hi2[i] - lo2[i] for i in range(3)]
    result.update({
        "ok": True,
        "objects": len(picked),
        "tris": tri_count(obj),
        "dim_m": [round(v, 2) for v in written],
        "sceneDim_m": [round(v, 2) for v in scene_dim],
        "scaleMismatch": any(abs(written[i] - scene_dim[i]) > 0.05 * max(1.0, scene_dim[i])
                             for i in range(3)),
        "output": out_fbx,
        "fileSizeMB": round(os.path.getsize(out_fbx) / 1048576.0, 2),
    })
except Exception as e:
    result["error"] = str(e)

print("ASSET_EXPORT_JSON " + json.dumps(result))
