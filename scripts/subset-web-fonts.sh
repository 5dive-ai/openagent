#!/usr/bin/env bash
# Builds assets/fonts/web/*.woff: Latin subsets of the five faces the card SVG uses,
# which lib/card.js embeds as @font-face so a card shown in a browser <img> (where an
# SVG can load no outside font) renders in the same fonts as the saved PNG.
# Without them a phone falls back to its default serif, and "COMMON" ran into its pill
# on 5dive.ai/openagent (lodar 2026-10-14). ~71 KB in total, ~95 KB once base64'd.
#
# Needs fonttools (pip install fonttools). Re-run after changing a bundled font or the
# range below, and commit the output.
set -euo pipefail
cd "$(dirname "$0")/../assets/fonts"
mkdir -p web
# Basic Latin, Latin-1, the Latin-Extended letters common in names, general
# punctuation (dashes, quotes, bullet, ellipsis), euro, trademark, arrows, minus, and the
# ✓ of a verified org. Greek and Cyrillic are left out on purpose (they doubled the
# size); a browser draws those from the font stack's system fallbacks.
UNICODES="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+0160-0161,U+0178,U+017D-017E,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2713"
for f in Inter-Regular.otf Inter-Italic.otf InterDisplay-ExtraBold.otf DejaVuSansMono.ttf DejaVuSansMono-Bold.ttf; do
  pyftsubset "$f" --unicodes="$UNICODES" --layout-features='kern,liga' --no-hinting \
    --desubroutinize --flavor=woff --output-file="web/${f%.*}.woff"
done
ls -l web
