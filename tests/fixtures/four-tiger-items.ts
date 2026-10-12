import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
export async function writeTestPng(file:string,mode:'valid'|'opaque'|'empty',color=64):Promise<void>{
  const png=new PNG({width:32,height:32});
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){const n=(y*32+x)*4;png.data[n]=color;png.data[n+1]=130;png.data[n+2]=200;png.data[n+3]=mode==='empty'?0:mode==='opaque'?255:x>4&&x<28&&y>4&&y<28?255:0;}
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,PNG.sync.write(png));
}
