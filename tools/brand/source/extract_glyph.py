"""extract_glyph.py - how the logo's «هـ» outline was made (run once, kept for the record).

    python -m pip install fonttools
    curl -L -o Cairo.ttf "https://github.com/google/fonts/raw/main/ofl/cairo/Cairo%5Bslnt,wght%5D.ttf"
    python tools/brand/source/extract_glyph.py Cairo.ttf > tools/brand/source/heh-cairo-extrabold.txt

Cairo is SIL Open Font Licence (free to embed as outlines). Takes the variable font at wght 800,
lays out the initial heh (U+FEEB) with a tatweel (U+0640) on its left, and prints
"<width> <height>" then the SVG path (y flipped, origin at the top left).
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
f = TTFont(sys.argv[1])
f = instancer.instantiateVariableFont(f, {"wght": 800, "slnt": 0})
cmap = f.getBestCmap(); gs = f.getGlyphSet()
heh = cmap.get(0xFEEB); tat = cmap.get(0x0640)
print("glyphs", heh, tat, file=sys.stderr)
# RTL: heh initial at right, tatweel on its left. x positions in font units.
tw = f['hmtx'][tat][0]; hw = f['hmtx'][heh][0]
parts = [(tat, 0), (heh, tw)]
bp = BoundsPen(gs)
for g, dx in parts:
    gs[g].draw(TransformPen(bp, (1,0,0,1,dx,0)))
xmin,ymin,xmax,ymax = bp.bounds
print("bounds", bp.bounds, file=sys.stderr)
pen = SVGPathPen(gs)
for g, dx in parts:
    # flip Y, normalise to origin
    gs[g].draw(TransformPen(pen, (1,0,0,-1,dx-xmin,ymax)))
print(f"{xmax-xmin} {ymax-ymin}")
print(pen.getCommands())
