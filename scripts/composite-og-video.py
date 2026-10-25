# Composites screencast frames into the og.jpg phone frame (1200x630) as a PNG sequence, plus poster frames.
# Encode: ffmpeg -framerate 30 -i comp/%04d.png -c:v libx264 -profile:v main -level 3.1 -pix_fmt yuv420p -preset veryslow -crf 23 -an -movflags +faststart og.mp4
import json, os, sys, bisect
from PIL import Image, ImageDraw
SRC='final'; OUT='comp'; FPS=30
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT): os.remove(os.path.join(OUT,f))
t=json.load(open(f'{SRC}/times.json')); t0=t[0]; rel=[x-t0 for x in t]
bg=Image.open('/Users/brandontheriot/projects/given/og.jpg').convert('RGB')
X,Y,W,H,R=780,64,380,502,31
DPR=1; CW=390; CH=CW*H/W  # crop window in CSS px
mask=Image.new('L',(W*4,H*4),0); ImageDraw.Draw(mask).rounded_rectangle([0,0,W*4-1,H*4-1],R*4,fill=255); mask=mask.resize((W,H),Image.LANCZOS)
# piecewise map: (src_start, src_end, speed)
segs=[(0.35,8.4,1.1),(8.4,9.2,2.5),(9.2,12.0,1.1)]
def src_at(u):
    for a,b,sp in segs:
        d=(b-a)/sp
        if u<=d: return a+u*sp
        u-=d
    return segs[-1][1]
total=sum((b-a)/sp for a,b,sp in segs)
XF=0.35
def ease(x): x=max(0,min(1,x)); return x*x*(3-2*x)
def pan(s): return 150*ease((s-10.3)/1.0)
cache={}
def src_frame(s):
    i=bisect.bisect_left(rel,s); i=min(max(i,0),len(rel)-1)
    if i>0 and abs(rel[i-1]-s)<abs(rel[i]-s): i-=1
    if i not in cache:
        cache.clear(); cache[i]=Image.open(f'{SRC}/{i:05d}.png').convert('RGB')
    return cache[i]
def phone(s):
    im=src_frame(s); y=pan(s)
    return im.crop((0,round(y*DPR),CW*DPR,round((y+CH)*DPR))).resize((W,H),Image.LANCZOS)
first=phone(src_at(0))
n=0 if len(sys.argv)>1 else int(round(total*FPS))
for k in range(n):
    u=k/FPS; s=src_at(u); p=phone(s)
    if u>total-XF: p=Image.blend(p,first,ease((u-(total-XF))/XF))
    fr=bg.copy(); fr.paste(p,(X,Y),mask); fr.save(f'{OUT}/{k:04d}.png')
# poster at src 11.7
p=phone(11.7); fr=bg.copy(); fr.paste(p,(X,Y),mask); fr.save('poster.png')
print('frames',n,'dur',total)
if len(sys.argv)>1:
    for s in map(float, sys.argv[1:]):
        p=phone(s); fr=bg.copy(); fr.paste(p,(X,Y),mask); fr.save(f'poster_{s}.png')
