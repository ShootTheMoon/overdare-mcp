"""
prepare_mesh.py — headless Blender pipeline that makes any 3D file OVERDARE-import-ready.

Run:  blender --background --python prepare_mesh.py -- <input> <outDir> <maxTris> <texSize> <mode>
  input    : .fbx / .obj / .glb / .gltf / .blend
  outDir   : where to write <name>_overdare.fbx
  maxTris  : triangle budget per mesh (OVERDARE limit = 30000)
  texSize  : max texture dimension (OVERDARE recommends 512; 1024 is a safe detail/size balance; 4K OOMs on import)
  mode     : "decimate" (single mesh, reduced to fit) | "keep" (no reduction, just texture fit)

Prints one line:  PREPARE_RESULT_JSON {...}
"""
import bpy, sys, os, json

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
inp = argv[0] if len(argv) > 0 else ""
outdir = argv[1] if len(argv) > 1 else os.path.dirname(inp)
max_tris = int(argv[2]) if len(argv) > 2 else 30000
tex_size = int(argv[3]) if len(argv) > 3 else 1024
mode = argv[4] if len(argv) > 4 else "decimate"

result = {"input": inp, "ok": False}


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


try:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    ext = os.path.splitext(inp)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=inp)
    elif ext == ".obj":
        try:
            bpy.ops.wm.obj_import(filepath=inp)
        except Exception:
            bpy.ops.import_scene.obj(filepath=inp)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=inp)
    elif ext == ".blend":
        with bpy.data.libraries.load(inp) as (df, dt):
            dt.objects = list(df.objects)
        for o in dt.objects:
            if o:
                bpy.context.collection.objects.link(o)
    else:
        raise Exception("unsupported format: " + ext)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise Exception("no mesh found in file")

    def fit_budget(o):
        """Reduce one object into the triangle budget without destroying it.

        Collapse alone is brutal at extreme ratios: a 1M-triangle monument squeezed
        to 30k (a ratio of 0.03) comes out as disconnected confetti, because collapse
        happily eats the small shells a detailed model is made of. Dissolve coplanar
        faces first — a tessellated cylinder or a flat wall panel loses most of its
        triangles at no visual cost — and only then collapse whatever is left over.

        The ratio is approximate and a mesh with many separate shells converges
        slowly, so iterate until it actually fits: stopping early ships a file
        OVERDARE rejects outright.
        """
        target = float(max_tris)
        bpy.context.view_layer.objects.active = o

        # Weld first. Exported meshes routinely arrive with their vertices split, so
        # the model is really a pile of loose triangles rather than a surface.
        # Decimation on that cannot merge anything across the seams: it just deletes
        # triangles, which is how a monument ends up as floating confetti, and why
        # the triangle count then refuses to fall any further.
        if tri_count(o) > max_tris:
            try:
                bpy.ops.object.select_all(action="DESELECT")
                o.select_set(True)
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.mesh.remove_doubles(threshold=0.0005)
                bpy.ops.mesh.normals_make_consistent(inside=False)
                bpy.ops.object.mode_set(mode="OBJECT")
            except Exception:
                try:
                    bpy.ops.object.mode_set(mode="OBJECT")
                except Exception:
                    pass

        # planar pre-pass, widening the angle while it buys real reduction
        for angle in (1.0, 5.0, 15.0):
            if tri_count(o) <= max_tris:
                return
            before = tri_count(o)
            m = o.modifiers.new("planar", type="DECIMATE")
            m.decimate_type = "DISSOLVE"
            m.angle_limit = angle * 3.14159265 / 180.0
            bpy.ops.object.modifier_apply(modifier=m.name)
            if tri_count(o) > before * 0.95:
                break                       # nothing coplanar left to merge

        for _ in range(8):
            cur = tri_count(o)
            if cur <= max_tris:
                break
            bpy.context.view_layer.objects.active = o
            m = o.modifiers.new("dec", type="DECIMATE")
            m.decimate_type = "COLLAPSE"
            m.ratio = max(0.01, (target / float(cur)) * 0.97)
            bpy.ops.object.modifier_apply(modifier=m.name)

        # Collapse cannot take a mesh below its number of separate shells, so a model
        # built from thousands of loose pieces stops falling well above the budget no
        # matter how small the ratio. Weld at a coarser distance to join the pieces
        # into surfaces — on a 30 m building a centimetre is invisible — then reduce
        # again. Widening rather than jumping straight to a big threshold keeps the
        # smallest detail that still fits.
        for weld in (0.01, 0.05, 0.15):
            if tri_count(o) <= max_tris:
                break
            try:
                bpy.ops.object.select_all(action="DESELECT")
                o.select_set(True)
                bpy.context.view_layer.objects.active = o
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.mesh.remove_doubles(threshold=weld)
                bpy.ops.object.mode_set(mode="OBJECT")
            except Exception:
                try:
                    bpy.ops.object.mode_set(mode="OBJECT")
                except Exception:
                    pass
            cur = tri_count(o)
            if cur > max_tris:
                m = o.modifiers.new("dec2", type="DECIMATE")
                m.decimate_type = "COLLAPSE"
                m.ratio = max(0.01, (target / float(cur)) * 0.97)
                bpy.ops.object.modifier_apply(modifier=m.name)

    in_tris = sum(tri_count(o) for o in meshes)

    if mode.startswith("split"):
        # OVERDARE's 30k limit is PER MeshPart, and it already splits an import by
        # material. Joining everything first therefore forces heavy decimation on
        # models that would have arrived intact as several parts — so split instead
        # and only reduce the parts that are individually over budget.
        for o in list(meshes):
            if len(o.material_slots) > 1:
                bpy.ops.object.select_all(action="DESELECT")
                o.select_set(True)
                bpy.context.view_layer.objects.active = o
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.mesh.separate(type="MATERIAL")
                bpy.ops.object.mode_set(mode="OBJECT")
        parts = [o for o in bpy.context.scene.objects if o.type == "MESH"]
        for o in parts:
            fit_budget(o)
    else:
        bpy.ops.object.select_all(action="DESELECT")
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        if len(meshes) > 1:
            bpy.ops.object.join()
        parts = [bpy.context.view_layer.objects.active]
        parts[0].name = "PreparedMesh"
        if mode in ("decimate", "bake", "bakeforce"):
            fit_budget(parts[0])

    obj = parts[0]
    out_tris = sum(tri_count(o) for o in parts)

    # Assets whose material is procedural or vertex-colour export with no image at
    # all, and OVERDARE then renders raw vertex colours (a mottled camo look).
    # Baking the surface to one diffuse image is what actually fixes those.
    # A texture node whose file is missing still leaves an image datablock behind —
    # it just has no pixels, so nothing gets embedded and the asset arrives untextured.
    # Only an image with real data counts as "already textured".
    def _has_real_tex():
        for s in obj.material_slots:
            m = s.material
            if not m or not m.use_nodes:
                continue
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image and max(n.image.size) > 0:
                    return True
        return False

    # "bake" only rescues assets that have nothing usable; "bakeforce" re-bakes even
    # when an image exists, for the ones OVERDARE refuses to import a texture for.
    baked = False
    if mode == "bakeforce" or (mode == "bake" and not _has_real_tex()):
        try:
            if not obj.data.uv_layers:
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
                bpy.ops.object.mode_set(mode="OBJECT")
            if not obj.material_slots:
                obj.data.materials.append(bpy.data.materials.new("Baked"))

            # Name the atlas after the asset, not a generic "BakedDiffuse". Bulk
            # Import uploads each texture under its image datablock name, so if every
            # asset ships an image called the same thing they collide into
            # BakedDiffuse / _ncl1_1 / _ncl1_2 and there is no way left to tell which
            # texture belongs to which mesh.
            img = bpy.data.images.new(
                os.path.splitext(os.path.basename(inp))[0] + "_T", tex_size, tex_size)
            for slot in obj.material_slots:
                mat = slot.material
                if not mat:
                    continue
                mat.use_nodes = True
                node = mat.node_tree.nodes.new("ShaderNodeTexImage")
                node.image = img
                node.select = True
                mat.node_tree.nodes.active = node

            sc = bpy.context.scene
            sc.render.engine = "CYCLES"
            sc.cycles.samples = 8
            sc.render.bake.use_pass_direct = False
            sc.render.bake.use_pass_indirect = False
            bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=4, use_clear=True)

            # Replace every material with ONE that carries only the baked image.
            # Rewiring Base Color is not enough: the original normal and emissive
            # maps stay in the node trees and get embedded alongside, and since a
            # MeshPart takes a single TextureId, OVERDARE is free to pick one of
            # those instead of the bake — which is the whole failure being fixed.
            atlas = bpy.data.materials.new("BakedAtlas")
            atlas.use_nodes = True
            nt = atlas.node_tree
            bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
            texn = nt.nodes.new("ShaderNodeTexImage")
            texn.image = img
            if bsdf:
                nt.links.new(texn.outputs["Color"], bsdf.inputs["Base Color"])
            obj.data.materials.clear()
            obj.data.materials.append(atlas)
            for poly in obj.data.polygons:
                poly.material_index = 0
            baked = True
        except Exception as e:
            result["bakeError"] = str(e)

    # textures: downscale to budget + pack so the FBX is self-contained
    tex_info = []
    imgs = set()
    for part in parts:
        for slot in part.material_slots:
            mat = slot.material
            if mat and mat.use_nodes:
                for n in mat.node_tree.nodes:
                    if n.type == "TEX_IMAGE" and n.image:
                        imgs.add(n.image)
    tex_dir = os.path.join(outdir, "_tex_tmp")
    os.makedirs(tex_dir, exist_ok=True)
    for i, img in enumerate(imgs):
        try:
            if max(img.size) > tex_size:
                img.scale(tex_size, tex_size)
            # Write the (scaled) pixels to disk and re-point, so export embeds the
            # small version — NOT any stale 4K packed data from the source file.
            safe = "".join(c for c in img.name if c.isalnum() or c in "._-") or ("tex%d" % i)
            if not safe.lower().endswith(".png"):
                safe += ".png"
            p = os.path.join(tex_dir, "%02d_%s" % (i, safe))
            img.filepath_raw = p
            img.file_format = "PNG"
            img.save()
            if img.packed_file:
                try:
                    img.unpack(method="REMOVE")
                except Exception:
                    pass
            img.filepath = p
            tex_info.append([img.name, list(img.size)])
        except Exception as e:
            tex_info.append([img.name, "err:" + str(e)])

    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    except Exception:
        pass

    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(inp))[0]
    out_fbx = os.path.join(outdir, base + "_overdare.fbx")
    bpy.ops.export_scene.fbx(
        filepath=out_fbx,
        use_selection=True,
        path_mode="COPY",
        embed_textures=True,
        add_leaf_bones=False,
        bake_anim=False,
        object_types={"MESH"},
    )

    result.update({
        "ok": True,
        "output": out_fbx,
        "inputTris": in_tris,
        "outputTris": out_tris,
        "maxTris": max_tris,
        "decimated": out_tris < in_tris,
        "overBudget": out_tris > max_tris,
        "baked": baked,
        "textures": tex_info,
        "parts": len(parts),
        "partTris": sorted((tri_count(o) for o in parts), reverse=True)[:8],
        "materials": len(obj.material_slots),
        "fileSizeMB": round(os.path.getsize(out_fbx) / 1048576.0, 2),
    })
except Exception as e:
    result["error"] = str(e)

print("PREPARE_RESULT_JSON " + json.dumps(result))
