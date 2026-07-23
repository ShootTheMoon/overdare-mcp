#!/bin/bash
# hq_pipeline.sh — pull every authored asset straight out of the .blend and make it
# import-ready.
#
#   hq_pipeline.sh <outRoot> <name> [<name> ...]
#
# The pre-exported FBX library ships simplified stand-ins (the T-34 is 1,144 tris
# there against 34,649 in the .blend), so the source file is the better origin for
# anything that exists in it. Each asset is extracted, then reduced to fit
# OVERDARE's 30,000-triangle-per-FILE budget — the cap is on the whole import, not
# per mesh part, so splitting does not buy headroom.

OUT="${1:-/c/Users/29/Desktop/MeshTest/HQAssets}"
shift
BLEND="/c/Users/29/Desktop/blender/ColdWarBerlin_AssetPack/00_Source_Blender/cold_war_berlin_asset_library.blend"
BLENDER="${OVERDARE_BLENDER:-/c/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe}"
HERE="$(dirname "$0")"
RAW="$OUT/raw"; READY="$OUT/ready"
mkdir -p "$RAW" "$READY"
PROG="$OUT/hq_progress.txt"
LOG="$OUT/hq.log"
: > "$LOG"

echo "extracting $# assets  $(date '+%H:%M:%S')" > "$PROG"
i=0
for name in "$@"; do
  i=$((i + 1))
  if [ ! -f "$RAW/$name.fbx" ]; then
    "$BLENDER" --background --python "$HERE/export_asset.py" -- "$BLEND" "$RAW/$name.fbx" "$name" \
      >> "$LOG" 2>&1
  fi
  if [ ! -f "$RAW/$name.fbx" ]; then
    printf '[%2d/%2d] NO-SOURCE %s\n' "$i" "$#" "$name" >> "$PROG"
    continue
  fi
  r=$("$BLENDER" --background --python "$HERE/prepare_mesh.py" -- \
        "$RAW/$name.fbx" "$READY" 29000 1024 bake 2>/dev/null \
        | grep -a 'PREPARE_RESULT_JSON' | sed 's/PREPARE_RESULT_JSON //')
  echo "$r" >> "$LOG"
  tris=$(echo "$r" | grep -o '"outputTris": *[0-9]*' | grep -o '[0-9]*$')
  mb=$(echo "$r" | grep -o '"fileSizeMB": *[0-9.]*' | grep -o '[0-9.]*$')
  if [ -n "$tris" ]; then
    printf '[%2d/%2d] ok %-26s %6s tris  %sMB\n' "$i" "$#" "$name" "$tris" "$mb" >> "$PROG"
  else
    printf '[%2d/%2d] FAILED %s\n' "$i" "$#" "$name" >> "$PROG"
  fi
done
echo "finished $(date '+%H:%M:%S')" >> "$PROG"
