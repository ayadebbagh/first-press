// Uses Next's pinned compiler for a standalone browser QA artifact of the same React UI.
// This is separate from `next build` and does not replace its self-hosted server output.
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import nextWebpack from 'next/dist/compiled/webpack/webpack.js';
const webpack=nextWebpack.webpack;
await mkdir('.sites-runtime/preview',{recursive:true});
await new Promise((resolveBuild,reject)=>{
 const compiler=webpack({mode:'production',entry:resolve('src/preview.tsx'),output:{path:resolve('.sites-runtime/preview'),filename:'preview.js'},devtool:false,resolve:{extensions:['.tsx','.ts','.js']},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:resolve('scripts/preview-loader.cjs')}]},optimization:{minimize:false,splitChunks:false,runtimeChunk:false},performance:{hints:false}});
 compiler.run((error,stats)=>compiler.close(closeError=>{if(error||closeError||stats.hasErrors())reject(error||closeError||Error(stats.toString({all:false,errors:true})));else resolveBuild();}));
});
let script=await readFile('.sites-runtime/preview/preview.js','utf8');
for(const asset of await readdir('public/assets')){const extension=asset.split('.').pop(),mime=extension==='jpg'?'jpeg':extension,bytes=await readFile('public/assets/'+asset);script=script.replaceAll(JSON.stringify('assets/'+asset),JSON.stringify(`data:image/${mime};base64,${bytes.toString('base64')}`));}
const css=await readFile('src/style.css','utf8');
let html=await readFile('scripts/preview-template.html','utf8');
html=html.replace('<link rel="stylesheet" href="/style.css">',()=>`<style>${css}</style>`).replace('<script type="module" src="/app.js"></script>',()=>`<script>${script.replaceAll('</script','<\\/script')}</script>`).replace('<link rel="icon" type="image/svg+xml" href="/favicon.svg">','');
await writeFile('FIRST-PRESS-preview.html',html);
console.log('Built React QA preview. Production output remains .next/standalone.');
