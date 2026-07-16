import * as esbuild from 'esbuild';
const stub = new URL('./stub.js', import.meta.url).pathname;
const cryptoShim = new URL('./crypto-shim.js', import.meta.url).pathname;
const shim = new URL('./node-globals-shim.js', import.meta.url).pathname;
try {
  const r = await esbuild.build({
    entryPoints: ['entry.js'], bundle: true, format: 'iife',
    platform: 'browser', outfile: 'bundle.js', logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis', __dirname: '"/"', __filename: '"/index.js"' },
    inject: [shim],
    alias: {
      crypto: cryptoShim, ws: stub, 'worker_threads': stub, stream: stub,
      'node:stream': stub, tty: stub, 'pino-pretty': stub, colorette: stub,
      pino: stub, 'node:crypto': cryptoShim, '@nillion/secretvaults': stub,
    },
  });
  console.log('BUNDLE OK', JSON.stringify(r.warnings?.slice(0,3)||[]));
} catch(e) {
  console.log('BUNDLE FAILED');
  console.log((e.errors||[]).map(x=>x.text+' @ '+(x.location?.file||'')).slice(0,12).join('\n'));
}
