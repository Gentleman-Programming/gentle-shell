import math, sys
from PIL import Image, ImageDraw
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
sys.path.insert(0,'/tmp/tower-spike')
W,H,PX=32,52,20          # 52 px tall, 20 font units per pixel -> unitsPerEm 1040
SH=(200,100,150)
def frame(k,kind):
    im=Image.new('RGBA',(W,H),(0,0,0,0)); d=ImageDraw.Draw(im)
    a=k/8*2*math.pi if kind=='walk' else 0
    sw=int(round(math.sin(a)*4)) if kind=='walk' else 0
    bob=-int(round(abs(math.sin(a))*1.5)) if kind=='walk' else 0
    o=(12,7,20); shade=(130,65,98)
    for lx,dx in ((13,sw),(19,-sw)):
        d.rectangle([lx-2+dx,36+bob,lx+1+dx,48+bob],fill=(42,36,72),outline=o)
        d.rectangle([lx-3+dx,48+bob,lx+3+dx,50+bob],fill=o)
    d.rounded_rectangle([9,20+bob,23,37+bob],radius=4,fill=SH,outline=o)
    d.rectangle([20,21+bob,22,36+bob],fill=shade)
    if kind=='type':
        up=k%2; d.rectangle([23,24+bob-up*2,29,27+bob-up*2],fill=shade,outline=o)
    else:
        d.rectangle([6-sw//2,22+bob,9-sw//2,33+bob],fill=shade,outline=o)
        d.rectangle([23+sw//2,22+bob,26+sw//2,33+bob],fill=shade,outline=o)
    d.ellipse([10,6+bob,22,20+bob],fill=(232,180,150),outline=o)
    d.chord([9,4+bob,23,14+bob],180,360,fill=(42,27,39))
    d.point((19,12+bob),fill=o)
    d.line([12,16+bob,20,16+bob],fill=o); d.point((11,15+bob),fill=o); d.point((21,15+bob),fill=o)
    if kind=='type' and k==3: d.line([18,12+bob,20,12+bob],fill=o)
    return im
LAYERS={'outline':[(12,7,20)],'hair':[(42,27,39)],'skin':[(232,180,150)],'shirt':[SH],'shade':[(130,65,98)],'pants':[(42,36,72)]}
order=list(LAYERS)
def layer_of(c):
    best=min(((sum((a-b)**2 for a,b in zip(c,p)),name) for name,ps in LAYERS.items() for p in ps)); return best[1]
frames=[frame(k,'walk') for k in range(8)]+[frame(k,'type') for k in range(4)]
glyphs={'.notdef':TTGlyphPen(None).glyph()}; cmap={}; names=['.notdef']
for li,ln in enumerate(order):
    for fi,im in enumerate(frames):
        pen=TTGlyphPen(None); px=im.load(); n=f'{ln}{fi:02d}'
        for y in range(H):
            x=0
            while x<W:
                p=px[x,y]
                if p[3]>0 and layer_of(p[:3])==ln:
                    x0=x
                    while x<W and px[x,y][3]>0 and layer_of(px[x,y][:3])==ln: x+=1
                    X0,X1,Y1,Y0=x0*PX,x*PX,(H-y)*PX,(H-y-1)*PX
                    pen.moveTo((X0,Y0));pen.lineTo((X0,Y1));pen.lineTo((X1,Y1));pen.lineTo((X1,Y0));pen.closePath()
                else: x+=1
        glyphs[n]=pen.glyph(); names.append(n); cmap[0x21+li*12+fi]=n
fb=FontBuilder(H*PX,isTTF=True); fb.setupGlyphOrder(names); fb.setupCharacterMap(cmap); fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics({n:(W*PX,0) for n in names}); fb.setupHorizontalHeader(ascent=H*PX,descent=0)
fb.setupNameTable({'familyName':'TowerPix','styleName':'Regular','fullName':'TowerPix Regular','psName':'TowerPix-Regular','uniqueFontIdentifier':'TowerPix-Regular-1.0','version':'Version 1.000'})
fb.setupOS2(sTypoAscender=H*PX,sTypoDescender=0,usWinAscent=H*PX,usWinDescent=0); fb.setupPost(); fb.save(sys.argv[1]); print('glyphs',len(names)-1)
