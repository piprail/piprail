// Encode already captured frames. No payments or external publishing.
import { spawnSync } from 'node:child_process';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const formats={wide:[1920,1080,'piprail-demo.mp4'],square:[1080,1080,'piprail-demo-square.mp4'],vertical:[1080,1920,'piprail-demo-vertical.mp4']};
for(const format of process.argv.slice(2).length?process.argv.slice(2):Object.keys(formats)){
 if(!formats[format])throw Error('Unknown format');
 const [w,h,file]=formats[format];
 const r=spawnSync('ffmpeg',['-y','-v','warning','-framerate','30','-i',join(here,`frames-${format}/frame_%05d.png`),'-i',join(here,'music.wav'),'-vf',`scale=${w}:${h}:flags=lanczos`,'-c:v','libx264','-preset','slow','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart','-c:a','aac','-b:a','256k','-shortest',join(here,file)],{stdio:'inherit'});
 if(r.status!==0)process.exit(r.status||1); console.log(file);
}
