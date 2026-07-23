#!/bin/bash
# bake_all.sh — re-prepare the listed assets with texture baking on.
#
#   bake_all.sh <outRoot> <name> [<name> ...]
#
# Assets whose source material is procedural or vertex-colour arrive in OVERDARE
# with no texture and render as mottled colour. `prepare_mesh.py ... bake` renders
# the surface down to one diffuse image, which is the only thing that fixes them.
# Output overwrites the normal conversion so the import step is unchanged.

OUT="${1:-/c/Users/29/Desktop/MeshTest/ColdWarBerlin_OVERDARE}"
shift
SRC="/c/Users/29/Desktop/blender/ColdWarBerlin_AssetPack/01_Exports_FBX"
BLENDER="${OVERDARE_BLENDER:-/c/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe}"
PREPARE="$(dirname "$0")/prepare_mesh.py"
LOG="$OUT/bake.log"
PROG="$OUT/bake_progress.txt"

echo "baking $# assets  $(date '+%H:%M:%S')" > "$PROG"
i=0
for name in "$@"; do
  i=$((i + 1))
  src="$(find "$SRC" -type f -iname "${name}.fbx" | head -1)"
  if [ -z "$src" ]; then
    printf '[%2d/%2d] MISSING %s\n' "$i" "$#" "$name" >> "$PROG"
    continue
  fi
  odir="$OUT/$(basename "$(dirname "$src")")"
  mkdir -p "$odir"
  r=$("$BLENDER" --background --python "$PREPARE" -- "$src" "$odir" 30000 1024 "${BAKEMODE:-bake}" 2>/dev/null \
        | grep -a 'PREPARE_RESULT_JSON' | sed 's/PREPARE_RESULT_JSON //')
  echo "$r" >> "$LOG"
  case "$r" in
    *'"baked": true'*) printf '[%2d/%2d] baked   %s\n' "$i" "$#" "$name" >> "$PROG" ;;
    *'"ok": true'*)    printf '[%2d/%2d] skipped %s (already textured)\n' "$i" "$#" "$name" >> "$PROG" ;;
    *)                 printf '[%2d/%2d] FAILED  %s\n' "$i" "$#" "$name" >> "$PROG" ;;
  esac
done
echo "finished $(date '+%H:%M:%S')" >> "$PROG"
