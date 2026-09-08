#!/usr/bin/env bash
# ============================================================
# build.sh — regenerate data/data.js from the DSL corpora, gated.
#
# Merges the D&D 5.5e SRD base + Wyldwolf Axis Preview + The Exorcism of
# Mikko .ttrpg corpus with the Go synthesist, parses the sibling
# .actor/.arc/.lore files with this repo's own DSL parser (synthesist only
# merges .ttrpg), combines both into data/data.js, and gates the result so
# nothing silently vanishes.
#
#   bash build/build.sh
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO="$HOME/.local/go/bin/go"
SYNTH_DIR="$HOME/Working/Titterpig Utilities/titterpig-synthesist"
MANIFEST="manifests/dnd5.5e-0.5-wyldwolf-axis-mikko.json"
CORPUS_OUT="$HERE/build/corpus"
MIKKO_DIR="$HOME/Working/Titterpig DSL/titterpig-dsl-dnd5e-3rdparty/wyldwolf/5.5/axis-mikko"
AXIS_DIR="$HOME/Working/Titterpig DSL/titterpig-dsl-dnd5e-3rdparty/wyldwolf/5.5/axis-preview"

echo "── 1/5  synthesist merge (.ttrpg → resolved JSON) ────"
if [ ! -d "$SYNTH_DIR" ]; then
  echo "build.sh: synthesist not found at $SYNTH_DIR" >&2
  exit 2
fi
(cd "$SYNTH_DIR" && "$GO" build ./...)
mkdir -p "$CORPUS_OUT"
(cd "$SYNTH_DIR" && "$GO" run ./cmd/synthesist --merge "$MANIFEST" --name axis-mikko-full --no-timestamp --out-dir "$CORPUS_OUT")
RESOLVED="$CORPUS_OUT/dnd5.5e/0.5/axis-mikko-full.resolved.json"
if [ ! -f "$RESOLVED" ]; then
  echo "build.sh: synthesist did not produce $RESOLVED" >&2
  exit 2
fi
echo

echo "── 2/5  parse .actor/.arc/.lore (not synthesist inputs) ──"
SUPP="$HERE/build/supplement.json"
python3 "$HERE/build/extract_supplement.py" "$SUPP" \
  "$MIKKO_DIR/wyldwolf-axis-mikko-0.5-npcs.actor" \
  "$MIKKO_DIR/wyldwolf-axis-mikko-0.5-adventure.arc" \
  "$MIKKO_DIR/wyldwolf-axis-mikko-0.5-adventure.lore" \
  "$AXIS_DIR/wyldwolf-axis-preview-0.5-setting.lore"
echo

echo "── 3/5  build data/data.js ────────────────────────────"
python3 "$HERE/build/build_data.py" "$RESOLVED" "$SUPP" "$HERE/data/data.js"
echo

echo "── 4/5  content gate ──────────────────────────────────"
python3 "$HERE/build/verify_data.py" "$RESOLVED" "$SUPP" "$HERE/data/data.js"
echo

echo "── 5/5  javascript syntax ─────────────────────────────"
if command -v node >/dev/null 2>&1; then
  n=0
  for f in "$HERE"/data/data.js "$HERE"/assets/js/*.js; do
    node --check "$f"
    n=$((n + 1))
  done
  echo "node --check: $n files parse"
else
  echo "node not on PATH — skipped (this check is advisory)"
fi
echo
echo "build.sh: all gates passed."
