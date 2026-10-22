import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// A local tooling bundle can supply Sharp without altering live application dependencies.
const sharp=createRequire(import.meta.url)(process.env.CLAUDEX_SHARP_MODULE||'sharp');

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const codex=await fs.readFile(path.join(root,'public/icons/codex.svg'),'utf8');
const claude=await fs.readFile(path.join(root,'public/icons/claude-ai-icon.svg'),'utf8');
const knot=codex.match(/<path\s+d="([^"]+)"/)[1];
const star=claude.match(/fill-rule="nonzero"\s+d="([^"]+)"/)[1];
// The existing provider vectors form one mark: a Codex knot surrounding Claude's warm star.
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><title>Claudex — Claude × Codex</title><rect width="512" height="512" rx="112" fill="#F3F0E9"/><path d="${knot}" transform="translate(256 256) scale(.82) translate(-360.626 -360.626)" fill="#242422"/><circle cx="256" cy="256" r="66" fill="#F3F0E9"/><path d="${star}" transform="translate(194.56 194.56) scale(.24)" fill="#D77555"/></svg>\n`;
await fs.writeFile(path.join(root,'public/logo.svg'),svg);
await fs.writeFile(path.join(root,'public/favicon.svg'),svg);
await fs.writeFile(path.join(root,'public/icons/icon-template.svg'),svg);
const render=size=>sharp(Buffer.from(svg)).resize(size,size).png().toBuffer();
for(const size of [32,64,128,256,512])await fs.writeFile(path.join(root,`public/logo-${size}.png`),await render(size));
await fs.writeFile(path.join(root,'public/favicon.png'),await render(64));
for(const size of [72,96,128,144,152,192,384,512]){
 await fs.writeFile(path.join(root,`public/icons/icon-${size}x${size}.png`),await render(size));
 await fs.writeFile(path.join(root,`public/icons/icon-${size}x${size}.svg`),svg.replace('width="512" height="512"',`width="${size}" height="${size}"`));
}
await fs.writeFile(path.join(root,'electron/assets/logo-macos.png'),await render(1024));
const icoSizes=[16,24,32,48,64,128,256],icoImages=await Promise.all(icoSizes.map(render));
const header=Buffer.alloc(6+16*icoSizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(icoSizes.length,4);let offset=header.length;
icoImages.forEach((png,index)=>{const at=6+16*index,size=icoSizes[index];header[at]=size===256?0:size;header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(png.length,at+8);header.writeUInt32LE(offset,at+12);offset+=png.length;});
await fs.writeFile(path.join(root,'electron/assets/logo-windows.ico'),Buffer.concat([header,...icoImages]));
const entries=[['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]];
const chunks=[];for(const [kind,size] of entries){const png=await render(size),h=Buffer.alloc(8);h.write(kind,0,4,'ascii');h.writeUInt32BE(png.length+8,4);chunks.push(h,png);}
const icnsHeader=Buffer.alloc(8);icnsHeader.write('icns');icnsHeader.writeUInt32BE(8+chunks.reduce((sum,part)=>sum+part.length,0),4);
await fs.writeFile(path.join(root,'electron/assets/logo-macos.icns'),Buffer.concat([icnsHeader,...chunks]));
console.log('Generated canonical Claudex SVG, PNG, Windows ICO and macOS ICNS assets.');
