import fs from 'node:fs/promises';
import sharp from 'sharp';

// Review candidates at their actual pixel sizes on both backgrounds.
const names=['arc-arrow','shepherd-staff','leading-dog'];
const sizes=[16,32,64,256], width=1320, height=1080;
const layers=[];
for(const [row,name] of names.entries()){
 const svg=await fs.readFile(`logo-options/drover-${name}.svg`);
 let x=24;
 for(const size of sizes){
  for(const background of ['#FFFFFF','#132B2B']){
   const tile=await sharp({create:{width:280,height:310,channels:4,background}})
    .composite([{input:await sharp(svg).resize(size,size).png().toBuffer(),left:Math.floor((280-size)/2),top:42}]).png().toBuffer();
   layers.push({input:tile,left:x,top:36+row*350});x+=size===256?282:125;
   if(size!==256){layers[layers.length-1].input=await sharp({create:{width:120,height:310,channels:4,background}}).composite([{input:await sharp(svg).resize(size,size).png().toBuffer(),left:Math.floor((120-size)/2),top:42}]).png().toBuffer();}
  }
 }
 const label=Buffer.from(`<svg width="1320" height="34"><text x="24" y="24" font-family="sans-serif" font-size="20" fill="#132B2B">${name}: 16 / 32 / 64 / 256 px; white and dark backgrounds</text></svg>`);
 layers.push({input:label,left:0,top:row*350});
}
await sharp({create:{width,height,channels:4,background:'#E9E4DB'}}).composite(layers).png().toFile('logo-options/compare.png');
