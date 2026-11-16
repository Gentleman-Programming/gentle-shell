import sys
sys.argv_saved=sys.argv
from fontTools.ttLib import TTFont
src=TTFont('/tmp/tower-spike/TowerPix.ttf')   # our glyphs (units: 20 per px, 52 px tall)
t=TTFont(sys.argv[1])                          # PxPlus template
upm=t['head'].unitsPerEm; s=upm/1040.0
cm=t.getBestCmap(); scm=src.getBestCmap()
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
gs=src.getGlyphSet()
for cp,sname in scm.items():
    tname=cm.get(cp)
    if not tname: continue
    pen=TTGlyphPen(None); gs[sname].draw(TransformPen(pen,(s,0,0,s,0,0)))
    t['glyf'][tname]=pen.glyph(); t['hmtx'][tname]=(int(640*s),0)
name=t['name']
for rec in name.names:
    if rec.nameID in (1,16): rec.string='TowerPix'
    elif rec.nameID==4: rec.string='TowerPix Regular'
    elif rec.nameID==6: rec.string='TowerPix-Regular'
    elif rec.nameID==3: rec.string='TowerPix-Regular-1.0'
t['hhea'].ascent=int(max(t['hhea'].ascent,1040*s))
t.save(sys.argv[2]); print('upm',upm,'scale',s)
