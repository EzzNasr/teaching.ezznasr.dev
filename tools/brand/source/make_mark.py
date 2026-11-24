"""make_mark.py - turns heh-cairo-extrabold.txt into the logo SVGs in assets/brand/.

    python tools/brand/source/make_mark.py tools/brand/source/heh-cairo-extrabold.txt assets/brand
    python tools/brand/build_brand.py        # then redraw every icon and the share card

Navy tile #0e2240 (dark mode #1d4f91), white letter 44/64 wide on a baseline at y=43,
amber arc #f2a93b under it; the maskable icon keeps the art inside the safe zone.
"""
import sys, re
lines = open(sys.argv[1]).read().split("\n")
w, h = map(float, lines[0].split()); d = lines[1]
d = re.sub(r"-?\d+\.\d+", lambda m: ("%.1f" % float(m.group())).rstrip("0").rstrip("."), d)
gw = 44.0; s = gw / w; gh = h * s
x0 = 32 - gw/2; y0 = 43 - gh
glyph = f'<path transform="translate({x0:.2f} {y0:.2f}) scale({s:.5f})" d="{d}"/>'
ARC = '<path d="M10 56 A34 34 0 0 1 54 56" fill="none" stroke="#f2a93b" stroke-width="3.4" stroke-linecap="round"/>'
T = '<title>Handasa · هندسة</title>'
def icon(bg, pad=0, rx=15):
    if pad:
        k = (64 - 2*pad) / 64
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{T}<rect width="64" height="64" fill="{bg}"/><g transform="translate({pad} {pad}) scale({k:.4f})"><g fill="#fff">{glyph}</g>{ARC}</g></svg>\n'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{T}<rect width="64" height="64" rx="{rx}" fill="{bg}"/><g fill="#fff">{glyph}</g>{ARC}</svg>\n'
o = sys.argv[2]
for name, svg in (("handasa-mark.svg", icon("#0e2240")), ("handasa-mark-dark.svg", icon("#1d4f91")), ("handasa-maskable.svg", icon("#0e2240", pad=9))):
    open(f"{o}/{name}", "w", encoding="utf-8", newline="\n").write(svg)
open(f"{o}/handasa-glyph.svg", "w", encoding="utf-8", newline="\n").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 14 48 46" fill="currentColor">{T}{glyph}{ARC}</svg>\n')
