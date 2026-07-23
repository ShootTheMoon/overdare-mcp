"""
bundle_meshes.py — pack several prepared FBX files into ONE bundle for Bulk Import.

  blender --background --python bundle_meshes.py -- <out.fbx> <in1.fbx> <in2.fbx> ...

Bulk Import registers one asset per mesh OBJECT in the file, up to 200, from a single
trip through the UI. That is the whole point: importing 200 meshes one at a time costs
200 dialogs, and each dialog is a chance for Studio to be busy, for another app to
steal focus, or for a modal to wedge the editor.

Studio derives asset names from what is inside the file, so this script pins both:
  mesh asset    <bundle file name>_<mesh object name>
  texture asset 00_<image datablock name>
Both are reported below so the caller can pair mesh to texture by name afterwards —
the registry gives no other link between them.

Prints one line:  BUNDLE_JSON {...}
"""
import bpy, sys, os, json

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
out_fbx = argv[0] if argv else ""
sources = argv[1:]

result = {"out": out_fbx, "ok": False, "assets": []}

try:
    if not sources:
        raise Exception("no source files given")
    if len(sources) > 200:
        raise Exception("Bulk Import accepts at most 200 meshes per file (got %d)" % len(sources))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    assets = []

    for path in sources:
        if not os.path.exists(path):
            raise Exception("missing source: %s" % path)
        before = set(o.name for o in bpy.context.scene.objects)
        bpy.ops.import_scene.fbx(filepath=path)
        added = [o for o in bpy.context.scene.objects
                 if o.name not in before and o.type == "MESH"]
        if not added:
            raise Exception("no mesh found in %s" % path)

        # One asset per source file: a source that arrives as several objects would
        # otherwise register as several unrelated assets with invented names.
        if len(added) > 1:
            bpy.ops.object.select_all(action="DESELECT")
            for o in added:
                o.select_set(True)
            bpy.context.view_layer.objects.active = added[0]
            bpy.ops.object.join()
            added = [bpy.context.view_layer.objects.active]

        obj = added[0]
        base = os.path.splitext(os.path.basename(path))[0]
        obj.name = base
        obj.data.name = base

        # Images are recorded further down, AFTER duplicates are collapsed — reading
        # them here would name the per-file copies (.001, .002, ...) that are about
        # to be merged away, and the pairing afterwards would look for textures that
        # were never registered.
        assets.append({
            "source": path,
            "meshObject": base,          # -> asset "<bundle>_<meshObject>"
            "tris": sum(len(p.vertices) - 2 for p in obj.data.polygons),
        })

    # Pieces of one split asset all reference the same texture, but importing them
    # from separate files gives Blender a fresh datablock each time (.001, .002, ...).
    # Left alone that uploads the identical image dozens of times and registers dozens
    # of texture assets. Collapse them back onto one datablock before exporting.
    merged = 0
    canonical = {}
    for img in list(bpy.data.images):
        if max(img.size) == 0:
            continue
        stem = img.name.rsplit(".", 1)
        base = stem[0] if len(stem) == 2 and stem[1].isdigit() else img.name
        key = (base, tuple(img.size))
        if key in canonical:
            continue
        canonical[key] = img
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        for nd in mat.node_tree.nodes:
            if nd.type != "TEX_IMAGE" or not nd.image or max(nd.image.size) == 0:
                continue
            stem = nd.image.name.rsplit(".", 1)
            base = stem[0] if len(stem) == 2 and stem[1].isdigit() else nd.image.name
            keep = canonical.get((base, tuple(nd.image.size)))
            if keep and keep != nd.image:
                nd.image = keep
                merged += 1
    result["imagesMerged"] = merged

    # Now that every mesh points at the surviving datablocks, record what each asset
    # will actually be paired against.
    for a in assets:
        obj = bpy.data.objects.get(a["meshObject"])
        imgs = []
        if obj:
            for slot in obj.material_slots:
                mat = slot.material
                if not mat or not mat.use_nodes:
                    continue
                for nd in mat.node_tree.nodes:
                    if nd.type == "TEX_IMAGE" and nd.image and max(nd.image.size) > 0:
                        if nd.image.name not in imgs:
                            imgs.append(nd.image.name)
        a["images"] = imgs

    bpy.ops.object.select_all(action="SELECT")
    os.makedirs(os.path.dirname(out_fbx) or ".", exist_ok=True)
    bpy.ops.export_scene.fbx(filepath=out_fbx, use_selection=True, path_mode="COPY",
                             embed_textures=True, add_leaf_bones=False, bake_anim=False,
                             object_types={"MESH"})

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    dupes = [a["meshObject"] for a in assets]
    result.update({
        "ok": True,
        "bundleName": os.path.splitext(os.path.basename(out_fbx))[0],
        "meshObjects": len(meshes),
        "assets": assets,
        "totalTris": sum(a["tris"] for a in assets),
        "fileSizeMB": round(os.path.getsize(out_fbx) / 1048576.0, 2),
        # Two sources with the same basename would collide into one asset name and
        # the pairing afterwards would silently attach the wrong texture.
        "duplicateNames": sorted({n for n in dupes if dupes.count(n) > 1}),
    })
except Exception as e:
    result["error"] = str(e)

print("BUNDLE_JSON " + json.dumps(result))
