/* Netlify function entry: nilAI delegation-token minter.
 *
 * This is a thin CommonJS wrapper. Netlify loads function entries in "Lambda
 * compatibility mode", which wraps them as CommonJS — so the entry itself must be
 * CJS. The real logic lives in the pre-built ESM bundle ./impl.mjs (the nilAI SDK
 * chain uses top-level await + ESM-only deps that can't be a CJS/Netlify entry).
 * We load it here via a plain dynamic import(), i.e. Node's own ESM loader, which
 * handles it correctly. impl.mjs never receives the document text.
 */
'use strict';

let implPromise = null;

exports.handler = async (event, context) => {
  try {
    if (!implPromise) implPromise = import('./impl.mjs');
    const impl = await implPromise;
    return impl.handler(event, context);
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'token function failed to load: ' + (e && e.message ? e.message : String(e)) }),
    };
  }
};
