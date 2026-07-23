"""
pack_converted.py — combine several already-OVERDARE-ready FBX files into ONE Bulk
Import bundle WITHOUT joining their objects.

  blender --background --python pack_converted.py -- <out.fbx> <in1.fbx> <in2.fbx> ...

The converted assets are already correct: each source file holds objects that are one
material / one texture each (a trash bin is 4 colour objects, a mailbox is 9). Joining
them — as the map-authoring bundler does — would fuse those into one multi-material
object and OVERDARE would then show only one texture. So here every object is kept
separate; Bulk Import registers each as its own asset named "<bundle>_<objectName>".

Bulk Import caps a file at 30,000 triangles AND 200 mesh objects, so the caller must
keep each bundle under both. This script only checks and reports; it does not split.

Reports, per source asset, which object names it contributed, so the caller can map
the registered "<bundle>_<objectName>" assets back to their asset and place them.

Prints one line:  PACK_JSON {...}
"""
import bpy, sys, os, json

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
out_fbx = argv[0] if argv else ""
sources = argv[1:]

result = {"out": out_fbx, "ok": False, "sources": []}

try:
    if not sources:
        raise Exception("no source files")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    all_names = set()
    for path in sources:
        if not os.path.exists(path):
            raise Exception("missing source: %s" % path)
        asset = os.path.splitext(os.path.basename(path))[0]     # e.g. HQ_TrashBin_overdare
        before = set(o.name for o in bpy.context.scene.objects)
        bpy.ops.import_scene.fbx(filepath=path)
        added = [o for o in bpy.context.scene.objects if o.name not in before and o.type == "MESH"]

        objs = []
        for i, o in enumerate(added):
            # Guarantee a name unique across the whole bundle, else Bulk Import would
            # collide two assets and one would overwrite the other.
            name = o.name
            if name in all_names:
                name = "%s_%02d" % (asset, i)
            n = name
            k = 0
            while n in all_names:
                k += 1
                n = "%s_%d" % (name, k)
            o.name = n
            o.data.name = n
            all_names.add(n)
            imgs = []
            for s in o.material_slots:
                m = s.material
                if m and m.use_nodes:
                    for nd in m.node_tree.nodes:
                        if nd.type == "TEX_IMAGE" and nd.image and max(nd.image.size) > 0 and nd.image.name not in imgs:
                            imgs.append(nd.image.name)
            objs.append({"object": o.name, "tris": sum(len(p.vertices) - 2 for p in o.data.polygons),
                         "mats": len(o.material_slots), "images": imgs})
        result["sources"].append({"asset": asset, "file": os.path.basename(path), "objects": objs})

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    total = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)

    bpy.ops.object.select_all(action="SELECT")
    os.makedirs(os.path.dirname(out_fbx) or ".", exist_ok=True)
    bpy.ops.export_scene.fbx(filepath=out_fbx, use_selection=True, path_mode="COPY",
                             embed_textures=True, add_leaf_bones=False, bake_anim=False,
                             object_types={"MESH"})

    result.update({
        "ok": True,
        "bundleName": os.path.splitext(os.path.basename(out_fbx))[0],
        "meshObjects": len(meshes),
        "totalTris": total,
        "fileSizeMB": round(os.path.getsize(out_fbx) / 1048576.0, 2),
        "overTris": total > 30000,
        "overObjects": len(meshes) > 200,
    })
except Exception as e:
    result["error"] = str(e)

print("PACK_JSON " + json.dumps(result))
