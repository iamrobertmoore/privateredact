import * as esbuild from 'esbuild';
const stub = new URL('./nodestub.js', import.meta.url).pathname;
const banner = "import { createRequire as __cr } from 'module'; import { fileURLToPath as __fu } from 'url'; import { dirname as __dn } from 'path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);";
await esbuild.build({ entryPoints:['token-fn-entry.mjs'], bundle:true, platform:'node', format:'esm', target:'node18',
  minify:true, outfile:'token.mjs', logLevel:'error', alias:{ '@nillion/secretvaults': stub }, banner:{ js: banner } });
console.log('TOKEN FN BUILT');
