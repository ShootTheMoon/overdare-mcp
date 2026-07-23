"""
export_map.py — measure or export an authored map's collections as one FBX, with
world placement baked in, so the whole layout can be imported in one go instead of
re-positioning every object by hand.

  blender --background --python export_map.py -- <file.blend> <outFbx> <mode> [collections...]
    mode : "measure" (report only) | "export"

Prints one line:  MAP_EXPORT_JSON {...}
"""
import bpy, sys, os, json

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
blend = argv[0] if len(argv) > 0 else ""
out_fbx = argv[1] if len(argv) > 1 else ""
mode = argv[2] if len(argv) > 2 else "measure"
wanted = argv[3:] if len(argv) > 3 else [
    "MAP_Wall", "MAP_Roads", "MAP_Ground", "MAP_Buildings", "MAP_Monuments",
    "MAP_Landmarks", "MAP_Vehicles", "MAP_Props",
    "ReichstagAsset", "HQ_Replacements", "Scene Collection",
]

result = {"blend": blend, "mode": mode, "ok": False}


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


try:
    bpy.ops.wm.open_mainfile(filepath=blend)

    picked = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or not o.data:
            continue
        if any(c.name in wanted for c in o.users_collection):
            picked.append(o)

    per_coll = {}
    total = 0
    over = 0
    for o in picked:
        t = tri_count(o)
        total += t
        if t > 30000:
            over += 1
        c = next((c.name for c in o.users_collection if c.name in wanted), "?")
        d = per_coll.setdefault(c, {"objects": 0, "tris": 0})
        d["objects"] += 1
        d["tris"] += t

    result.update({
        "objects": len(picked),
        "totalTris": total,
        "objectsOver30k": over,
        "byCollection": per_coll,
    })

    if mode == "chunk" and picked:
        # Bulk Import refuses a file with more than 200 meshes
        # ("Maximum allowed mesh count: 200"), so emit numbered chunks under that.
        per = 200
        picked.sort(key=lambda o: o.name)
        base, ext = os.path.splitext(out_fbx)
        chunks = []
        for i in range(0, len(picked), per):
            group = picked[i:i + per]
            bpy.ops.object.select_all(action="DESELECT")
            for o in group:
                o.select_set(True)
            bpy.context.view_layer.objects.active = group[0]
            path = "%s_%02d%s" % (base, i // per + 1, ext or ".fbx")
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            bpy.ops.export_scene.fbx(
                filepath=path,
                use_selection=True,
                path_mode="STRIP",
                embed_textures=False,
                add_leaf_bones=False,
                bake_anim=False,
                object_types={"MESH"},
            )
            chunks.append({
                "file": path,
                "meshes": len(group),
                "tris": sum(tri_count(o) for o in group),
                "sizeMB": round(os.path.getsize(path) / 1048576.0, 2),
            })
        result["chunks"] = chunks
        result["chunkCount"] = len(chunks)

    if mode in ("export", "exportgeo") and picked:
        # Bulk Import does not link textures anyway, so embedding them just inflates
        # the file past the 250 MB cap for nothing.
        embed = mode == "export"
        bpy.ops.object.select_all(action="DESELECT")
        for o in picked:
            o.select_set(True)
        bpy.context.view_layer.objects.active = picked[0]
        os.makedirs(os.path.dirname(out_fbx) or ".", exist_ok=True)
        bpy.ops.export_scene.fbx(
            filepath=out_fbx,
            use_selection=True,
            path_mode="COPY" if embed else "STRIP",
            embed_textures=embed,
            add_leaf_bones=False,
            bake_anim=False,
            object_types={"MESH"},
        )
        result["output"] = out_fbx
        result["fileSizeMB"] = round(os.path.getsize(out_fbx) / 1048576.0, 2)

    result["ok"] = True
except Exception as e:
    result["error"] = str(e)

print("MAP_EXPORT_JSON " + json.dumps(result))
