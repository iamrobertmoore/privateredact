/* nilAI verification service (local / serverless).
 *
 * Holds the nilAI key, calls nilAI for the redaction detection, and verifies:
 *   1. the per-response signature (secp256k1 ECDSA, signed inside the enclave), and
 *   2. the AMD SEV-SNP enclave attestation
 * reusing the exact, tested verifier from the n8n-nodes-nilai package.
 *
 * It returns the model's answer plus the verification result, so the browser can
 * PROVE the processing happened in a genuine TEE instead of taking our word for it.
 * Running this server-side also (a) keeps the API key off the client and
 * (b) avoids the browser CORS limits on nilAI / AMD KDS.
 *
 * Run:  node server/verify.js       (reads server/verify-config.js)
 */
'use strict';

const http = require('http');
const { createPublicKey, verify: cryptoVerify } = require('crypto');
const { verifyEnclaveAttestation } = require('./nilai-verifier/attestation.js');

let cfg;
try { cfg = require('./verify-config.js'); }
catch (e) {
  console.error('Missing server/verify-config.js — copy verify-config.example.js to verify-config.js and add your key.');
  process.exit(1);
}
const BASE = (cfg.baseUrl || 'https://api.nilai.nillion.network').replace(/\/+$/, '');
const PORT = process.env.PORT || cfg.port || 8787;

/* ---- per-response signature check (copied verbatim from the n8n node) ---- */
const SPKI_SECP256K1_COMPRESSED_PREFIX = Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex');
function publicKeyFromCompressedBase64(b64) {
  const point = Buffer.from(String(b64).trim().replace(/^"|"$/g, ''), 'base64');
  return createPublicKey({ key: Buffer.concat([SPKI_SECP256K1_COMPRESSED_PREFIX, point]), format: 'der', type: 'spki' });
}
function verifyNilaiSignature(rawBody, publicKeyB64) {
  try {
    const obj = JSON.parse(rawBody);
    const signatureB64 = obj.signature;
    if (!signatureB64) return false;
    let preimage = rawBody.replace(`"signature":"${signatureB64}"`, '"signature":""');
    for (const field of ['created_at', 'temperature', 'top_p']) {
      preimage = preimage.replace(new RegExp(`("${field}":)(-?\\d+)([,}\\]])`), '$1$2.0$3');
    }
    return cryptoVerify('sha256', Buffer.from(preimage, 'utf8'),
      { key: publicKeyFromCompressedBase64(publicKeyB64), dsaEncoding: 'der' },
      Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

/* ---- ctx shim so the node's attestation code can make HTTP calls here ---- */
function makeCtx() {
  return {
    helpers: {
      httpRequest: async (opts) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
        try {
          const res = await fetch(opts.url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body, signal: ctrl.signal });
          if (opts.encoding === 'arraybuffer') return await res.arrayBuffer();
          if (opts.encoding === 'text') return await res.text();
          if (opts.json) return await res.json();
          return await res.text();
        } finally { clearTimeout(timer); }
      },
    },
  };
}

/* ---------------------------------------------------------------- handler */
async function handleVerify(payload) {
  const model = payload.model || 'google/gemma-4-26B-A4B-it';
  const input = String(payload.input || '');

  // 1. call nilAI (raw text preserved so signature verification is exact)
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model, input }),
  });
  const rawBody = await r.text();
  if (!r.ok) throw new Error('nilAI ' + r.status + ': ' + rawBody.slice(0, 200));
  const parsed = JSON.parse(rawBody);

  // 2. per-response signature
  let teeVerified = null;
  try {
    const pk = await (await fetch(BASE + '/v1/public_key')).json();
    teeVerified = verifyNilaiSignature(rawBody, pk);
  } catch (e) { teeVerified = false; }

  // 3. enclave attestation (reused, tested verifier)
  let attestation;
  try { attestation = await verifyEnclaveAttestation(makeCtx(), BASE); }
  catch (e) { attestation = { attestation_verified: false, error: e.message }; }

  // 4. pull the model's answer text out of the response
  const outputItems = Array.isArray(parsed.output) ? parsed.output : [];
  const message = outputItems.find((o) => o && o.type === 'message') || outputItems[0];
  const contents = Array.isArray(message && message.content) ? message.content : [];
  const part = contents.find((c) => c && c.type === 'output_text') || contents[0];
  const text = part && typeof part.text === 'string' ? part.text : '';

  return { text, tee_verified: teeVerified, attestation, signature: parsed.signature || null, model: parsed.model || model };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const out = await handleVerify(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => console.log(`nilAI verifier listening on http://localhost:${PORT}  (POST /)`));
