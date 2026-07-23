"""
dump_layout.py — read an authored .blend and print every object's placement, so a
scene composed in Blender can be reproduced elsewhere.

  blender --background --python dump_layout.py -- <file.blend>

Blender is Z-up and metres; OVERDARE is Y-up and centimetres, so each object is
reported in both spaces. Prints one JSON object per line after LAYOUT_JSON.
"""
import bpy, sys, json, math
from mathutils import Vector

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
path = argv[0] if argv else ""

bpy.ops.wm.open_mainfile(filepath=path)

def collections_of(o):
    return [c.name for c in o.users_collection]


def ground_shape(o):
    """Footprint direction and front/back asymmetry.

    Placement rotation is baked into the vertices here — every object reports a
    zero transform — so the only way to know which way a car or a bench actually
    faces is to measure the geometry. A 2-D covariance of the footprint gives the
    dominant axis, but an axis is a line: it cannot tell a car from the same car
    turned around. The third moment along that axis can. A car has more of its
    bulk toward one end, so the sign of the skew is a property of the model, and
    two copies whose signs disagree are 180 degrees apart.

    Returns (yaw_deg, skew_along_axis, skew_across_axis).
    """
    try:
        pts = [(o.matrix_world @ v.co) for v in o.data.vertices]
        if len(pts) < 3:
            return 0.0, 0.0, 0.0
        if len(pts) > 3000:
            step = len(pts) // 3000 + 1
            pts = pts[::step]
        n = len(pts)
        mx = sum(p.x for p in pts) / n
        my = sum(p.y for p in pts) / n
        sxx = sum((p.x - mx) ** 2 for p in pts) / n
        syy = sum((p.y - my) ** 2 for p in pts) / n
        sxy = sum((p.x - mx) * (p.y - my) for p in pts) / n
        if abs(sxy) < 1e-9 and abs(sxx - syy) < 1e-9:
            return 0.0, 0.0, 0.0
        ang = 0.5 * math.atan2(2.0 * sxy, sxx - syy)      # principal axis
        ca, sa = math.cos(ang), math.sin(ang)

        def skew(ux, uy):
            t = [(p.x - mx) * ux + (p.y - my) * uy for p in pts]
            m2 = sum(v * v for v in t) / n
            if m2 < 1e-12:
                return 0.0
            m3 = sum(v ** 3 for v in t) / n
            return round(m3 / (m2 ** 1.5), 3)

        return round(math.degrees(ang), 1), skew(ca, sa), skew(-sa, ca)
    except Exception:
        return 0.0, 0.0, 0.0


def surfaces(o):
    """Material names and the images they actually use.

    OVERDARE gives a MeshPart a single TextureId, so a model whose materials each
    carry their own image can only ever show one of them — the rest render with
    the wrong picture. Reporting the count here is what says which assets have to
    be baked down to one atlas instead of imported as-is.
    """
    mats, imgs = [], []
    try:
        for s in o.material_slots:
            m = s.material
            if not m:
                continue
            mats.append(m.name)
            if not m.use_nodes:
                continue
            for nd in m.node_tree.nodes:
                if nd.type == "TEX_IMAGE" and nd.image and max(nd.image.size) > 0:
                    imgs.append(nd.image.name)
    except Exception:
        pass
    return mats, sorted(set(imgs))


rows = []
for o in bpy.context.scene.objects:
    if o.type != "MESH" or not o.data or not o.data.vertices:
        continue
    # Placement is baked into the vertices here, so object.location reads 0 for
    # everything; the world-space bounding box is what actually says where a piece is.
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    ctr = [(lo[i] + hi[i]) / 2.0 for i in range(3)]
    dim = [hi[i] - lo[i] for i in range(3)]
    yaw, skew, skew_t = ground_shape(o)
    mats, imgs = surfaces(o)
    rows.append({
        "name": o.name,
        "coll": collections_of(o),
        # Blender metres, Z-up
        "ctr_m": [round(v, 2) for v in ctr],
        "dim_m": [round(v, 2) for v in dim],
        "base_z": round(lo[2], 2),
        "yaw": yaw,
        "skew": skew,
        "skewT": skew_t,
        "mats": mats,
        "imgs": imgs,
        # OVERDARE centimetres, Y-up  (X, Y, Z) = (bx, bz, by)
        "ovdr_pos": [round(ctr[0] * 100, 1), round(ctr[2] * 100, 1), round(ctr[1] * 100, 1)],
        "ovdr_size": [round(dim[0] * 100, 1), round(dim[2] * 100, 1), round(dim[1] * 100, 1)],
    })

rows.sort(key=lambda r: r["name"])
print("LAYOUT_JSON " + json.dumps({"file": path, "count": len(rows), "objects": rows}))
