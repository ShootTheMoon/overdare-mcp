#!/usr/bin/env bash
# rebake_assets.sh — re-export assets from the .blend and bake every material down
# to ONE diffuse atlas.
#
#   ./rebake_assets.sh HQ_FoodCart HQ_Church WB_Altbau ...
#
# An OVERDARE MeshPart carries a single TextureId, so a model whose materials each
# have their own image can only ever show one of them and the rest of the surface
# renders with the wrong picture. Baking collapses them into one image that maps
# correctly across the whole mesh.
#
# Prints one TSV line per asset and, at the end, the comma-separated file list to
# hand to gui_import.ps1.
set -u

BL="/c/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe"
S="$(cd "$(dirname "$0")" && pwd)"
BLEND="/c/Users/29/Desktop/blender/ColdWarBerlin_AssetPack/00_Source_Blender/cold_war_berlin_asset_library.blend"
OUT="/c/Users/29/Desktop/MeshTest/Rebake"
WOUT='C:\Users\29\Desktop\MeshTest\Rebake'
BS='\'
mkdir -p "$OUT"

ready=()
printf 'asset\tstage\ttris\tparts\tbaked\tMB\n'

for name in "$@"; do
  raw="$WOUT$BS$name.fbx"
  ex=$("$BL" --background --python "$S/export_asset.py" -- "$BLEND" "$raw" "$name" 2>/dev/null \
        | grep -a ASSET_EXPORT_JSON | sed 's/^ASSET_EXPORT_JSON //')
  if [ -z "$ex" ] || [ "$(printf '%s' "$ex" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).ok)}catch(e){console.log("false")}})')" != "true" ]; then
    printf '%s\texport\tFAILED\t-\t-\t-\n' "$name"
    continue
  fi

  # bakeforce: re-bake even when an image already exists, because the point here is
  # to merge several images into one, not to rescue a missing one.
  pr=$("$BL" --background --python "$S/prepare_mesh.py" -- "$raw" "$WOUT" 30000 1024 bakeforce 2>/dev/null \
        | grep -a PREPARE_RESULT_JSON | sed 's/^PREPARE_RESULT_JSON //')
  if [ -z "$pr" ]; then
    printf '%s\tprepare\tFAILED\t-\t-\t-\n' "$name"
    continue
  fi
  printf '%s' "$pr" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const r=JSON.parse(s);
      const name=process.argv[1];
      if(!r.ok){ console.log([name,"prepare","FAILED","-","-","-"].join("\t")); process.exit(0); }
      console.log([name, r.overBudget?"OVER-BUDGET":"ok", r.outputTris, r.parts, r.baked, r.fileSizeMB].join("\t"));
    });' "$name"
  ready+=("$WOUT$BS${name}_overdare.fbx")
done

printf '\nIMPORT_LIST\t%s\n' "$(IFS=,; echo "${ready[*]-}")"
