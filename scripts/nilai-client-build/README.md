# Browser nilAI client bundle

`lib/nilai-client.min.js` is a browser build of Nillion's `@nillion/nilai-ts` SDK.
It lets the browser mint-request a delegation token and call the nilAI enclave
**directly** (`getDelegationRequest()` + `chat.completions.create()`), so the
document text goes straight from the user's browser to the sealed enclave and
never passes through our own server.

It also re-exports `@noble/curves` secp256k1 and `@noble/hashes` sha256 so the
page can verify the enclave's response signature client-side (WebCrypto has no
secp256k1).

## Why a custom bundle

The SDK pulls in Node-only transitive deps (via `@nillion/secretvaults`:
libsodium, `pino`, `ws`, `worker_threads`) that are only used by the nilDB path,
not by nilAI chat. The build stubs those out so the bundle stays browser-safe and
small (~700 KB gzipped over the wire).

This directory also builds the **server-side token function** `netlify/functions/token.mjs`.
Netlify's own esbuild bundler can't handle the SDK here (its dep chain uses
top-level await, which won't compile to the CJS Netlify emits, plus an ESM-only
`@nillion/nuc` and a broken libsodium ESM entry). So we pre-build a self-contained
ESM function ourselves — secretvaults stubbed, `createRequire`/`__dirname` banner —
and Netlify ships it verbatim via the `nft` tracer (see `netlify.toml`).

## Reproduce

```bash
npm init -y
npm install @nillion/nilai-ts@0.3.1 @noble/hashes esbuild
# copy entry.js, stub.js, crypto-shim.js, build.mjs, nodestub.js,
# token-fn-entry.mjs, build-token-fn.mjs here

# 1) browser client bundle -> lib/nilai-client.min.js
node build.mjs
npx esbuild bundle.js --minify --outfile=../../lib/nilai-client.min.js

# 2) server token function bundle -> netlify/functions/token/impl.mjs
#    (loaded by the CJS entry netlify/functions/token/token.js at request time)
node build-token-fn.mjs
cp token.mjs ../../netlify/functions/token/impl.mjs
```

Pinned to `@nillion/nilai-ts@0.3.1`. If bumping the SDK, re-run both builds and
re-smoke-test: `getDelegationRequest()` in a browser-like context, and the token
function handler (OPTIONS -> 204, invalid POST -> 400) before shipping.
