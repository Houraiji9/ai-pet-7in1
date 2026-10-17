import sys, subprocess, numpy as np
from PIL import Image
inp,out=sys.argv[1],sys.argv[2]; n=int(sys.argv[3]) if len(sys.argv)>3 else 8
raw=subprocess.run(['ffmpeg','-v','error','-c:v','libvpx-vp9','-i',inp,'-f','rawvideo','-pix_fmt','rgba','-'],capture_output=True).stdout
a=np.frombuffer(raw,np.uint8).reshape(-1,360,640,4)
idx=np.linspace(0,len(a)-1,n).astype(int)
yy,xx=np.mgrid[0:360,0:640]; chk=np.where(((yy//10)+(xx//10))%2,90,130)[...,None].astype(float)
t=[]
for i in idx:
    f=a[i].astype(float); al=f[...,3:4]/255; c=f[...,:3]*al+chk*(1-al); c[329,:]=[255,0,0]; t.append(c[10:350,170:470].astype(np.uint8))
Image.fromarray(np.concatenate(t,1)).save(out); print(list(idx))
