#!/bin/bash
# Split every authored asset into <=30k-tri pieces that carry world coordinates.
# One Blender process per asset: a crash on one heavy scan cannot take the batch down.
BL="C:/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe"
BLEND="C:/Users/29/Desktop/blender/ColdWarBerlin_AssetPack/00_Source_Blender/cold_war_berlin_asset_library.blend"
SCRIPT="C:/Users/29/Desktop/overdare-mcp/scripts/split_absolute.py"
OUT="C:/Users/29/Desktop/MeshTest/Abs"
LOG="$OUT/_batch.log"
mkdir -p "$OUT"
: > "$LOG"

ASSETS=$(node -e '
const fs=require("fs");
const man=JSON.parse(fs.readFileSync("C:/Users/29/Desktop/MeshTest/Converted/_manifest.json","utf8"));
console.log(Object.keys(man).join(" "));
')

# The three photogrammetry scans are over a million triangles each; they were left out
# of the original port too. Splitting them takes far longer than everything else put
# together, so they are handled on their own rather than blocking the batch.
SKIP_ASSETS="HQ_VictoryColumn HQ_Palast HQ_SovietMemorial"

for a in $ASSETS; do
  case " $SKIP_ASSETS " in
    *" $a "*) echo "SKIP $a (photogrammetry scan — run separately)" | tee -a "$LOG"; continue ;;
  esac
  if [ -f "$OUT/${a}_split.json" ]; then
    echo "SKIP $a (already done)" | tee -a "$LOG"
    continue
  fi
  echo "=== $a ===" | tee -a "$LOG"
  timeout 900 "$BL" --background --python "$SCRIPT" -- "$BLEND" "$a" "$OUT" 30000 2>&1 \
    | grep -E "^SPLIT_JSON|Traceback|^Error|KeyError" | head -5 > "$OUT/_tmp_$a.txt"
  if grep -q "^SPLIT_JSON" "$OUT/_tmp_$a.txt"; then
    node -e '
      const fs=require("fs");
      // node -e puts the first extra argument at argv[1], not argv[2].
      const [,tmp,out,asset]=process.argv;
      const l=fs.readFileSync(tmp,"utf8").split("\n").find(x=>x.startsWith("SPLIT_JSON"));
      const j=JSON.parse(l.slice(11));
      fs.writeFileSync(out+"/"+asset+"_split.json",JSON.stringify(j));
      console.log("OK "+asset+" tris="+j.total_tris+" pieces="+j.pieces.length+
                  " over="+j.pieces.filter(p=>p.tris>30000).length);
    ' "$OUT/_tmp_$a.txt" "$OUT" "$a" | tee -a "$LOG"
  else
    echo "FAIL $a" | tee -a "$LOG"
    head -3 "$OUT/_tmp_$a.txt" | tee -a "$LOG"
  fi
  rm -f "$OUT/_tmp_$a.txt"
done
echo "BATCH DONE" | tee -a "$LOG"
