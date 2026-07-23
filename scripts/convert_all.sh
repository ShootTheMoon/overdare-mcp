#!/bin/bash
# Convert an entire asset library to OVERDARE-importable FBX.
#
#   convert_all.sh <sourceRoot> <outRoot> [maxTris] [texSize]
#
# Walks <sourceRoot> for .fbx/.obj/.glb/.gltf, runs each through prepare_mesh.py
# (triangle budget + texture downscale + self-contained re-export), and mirrors the
# source folder layout into <outRoot>. Appends one JSON line per asset to
# <outRoot>/convert.log and a human-readable line to <outRoot>/progress.txt.
#
# Re-running skips assets whose output already exists, so an interrupted run just
# picks up where it stopped.

SRC="${1:-/c/Users/29/Desktop/blender/ColdWarBerlin_AssetPack/01_Exports_FBX}"
OUT="${2:-/c/Users/29/Desktop/MeshTest/ColdWarBerlin_OVERDARE}"
MAXTRIS="${3:-30000}"
TEXSIZE="${4:-1024}"

BLENDER="${OVERDARE_BLENDER:-/c/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe}"
PREPARE="$(dirname "$0")/prepare_mesh.py"

[ -x "$BLENDER" ] || { echo "blender not found: $BLENDER"; exit 1; }
[ -f "$PREPARE" ] || { echo "prepare_mesh.py not found: $PREPARE"; exit 1; }

mkdir -p "$OUT"
LOG="$OUT/convert.log"
PROG="$OUT/progress.txt"

mapfile -t FILES < <(find "$SRC" -type f \( -iname '*.fbx' -o -iname '*.obj' -o -iname '*.glb' -o -iname '*.gltf' \) | sort)
TOTAL="${#FILES[@]}"
echo "started $(date '+%H:%M:%S')  total=$TOTAL  maxTris=$MAXTRIS  tex=$TEXSIZE" > "$PROG"

i=0; done_n=0; skip_n=0; fail_n=0
for f in "${FILES[@]}"; do
  i=$((i + 1))
  cat_dir="$(basename "$(dirname "$f")")"
  name="$(basename "${f%.*}")"
  odir="$OUT/$cat_dir"
  mkdir -p "$odir"

  if [ -f "$odir/${name}_overdare.fbx" ]; then
    skip_n=$((skip_n + 1))
    continue
  fi

  r=$("$BLENDER" --background --python "$PREPARE" -- "$f" "$odir" "$MAXTRIS" "$TEXSIZE" decimate 2>/dev/null \
        | grep -a 'PREPARE_RESULT_JSON' | sed 's/PREPARE_RESULT_JSON //')

  if [ -z "$r" ]; then
    fail_n=$((fail_n + 1))
    echo "{\"input\":\"$f\",\"ok\":false,\"error\":\"blender produced no result\"}" >> "$LOG"
    line="FAIL  $cat_dir/$name  (no result)"
  else
    echo "$r" >> "$LOG"
    case "$r" in
      *'"ok": true'*|*'"ok":true'*) done_n=$((done_n + 1)); line="ok    $cat_dir/$name" ;;
      *) fail_n=$((fail_n + 1)); line="FAIL  $cat_dir/$name" ;;
    esac
  fi
  printf '[%3d/%3d] %s\n' "$i" "$TOTAL" "$line" >> "$PROG"
done

echo "finished $(date '+%H:%M:%S')  converted=$done_n skipped=$skip_n failed=$fail_n" >> "$PROG"
