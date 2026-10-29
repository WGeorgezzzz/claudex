import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// A local tooling bundle can supply Sharp without altering live application dependencies.
const sharp=createRequire(import.meta.url)(process.env.NEXAGENT_SHARP_MODULE||process.env.NEXCODE_SHARP_MODULE||process.env.GACI_SHARP_MODULE||process.env.CLAUDEX_SHARP_MODULE||'sharp');

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Canonical Drover mark: a rounded field with a leading arrow inside a guiding arc.
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><title>Drover</title><rect width="512" height="512" rx="112" fill="#132B2B"/><path d="M96 310c0-108 71-190 160-190s160 82 160 190" fill="none" stroke="#F7F1E6" stroke-width="54" stroke-linecap="round"/><path d="M111 300c-6 67 50 116 145 116s151-49 145-116" fill="none" stroke="#E3D7C3" stroke-width="28" stroke-linecap="round"/><path d="M256 168v190" fill="none" stroke="#F4A7B9" stroke-width="28" stroke-linecap="round"/><path d="m256 152 42 48h-28v88h-28v-88h-28z" fill="#F4A7B9"/><circle cx="151" cy="300" r="14" fill="#F4A7B9"/><circle cx="361" cy="300" r="14" fill="#F4A7B9"/></svg>
`;
await fs.writeFile(path.join(root,'public/logo.svg'),svg);
await fs.writeFile(path.join(root,'public/nexagent-mark.svg'),svg);
await fs.writeFile(path.join(root,'public/drover-mark.svg'),svg);
await fs.writeFile(path.join(root,'public/nexcode-mark.svg'),svg);
// Retain the old asset URLs for cached clients during the brand transition.
await fs.writeFile(path.join(root,'public/gaci-mark.svg'),svg);
await fs.writeFile(path.join(root,'public/claudex-mark.svg'),svg);
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
console.log('Generated canonical Drover SVG, PNG, Windows ICO and macOS ICNS assets.');
