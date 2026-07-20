/* Netlify Function: enclave attestation (text-free).
 *
 * Proves the nilAI enclave is genuine AMD SEV-SNP hardware running the expected
 * build, and returns the raw attestation report so the result can be verified
 * independently against AMD's KDS. This step involves NO document text and no AI
 * call — it is purely about the enclave, so it's safe to run server-side even in
 * the direct/private path (the browser can't reach AMD's KDS itself).
 *
 * Used by the direct path (browser talks to nilAI directly for the actual work;
 * this endpoint supplies the trust proof + downloadable receipt).
 */
'use strict';

const { verifyEnclaveAttestation } = require('../../server/nilai-verifier/attestation.js');

const BASE = (process.env.NILAI_BASE_URL || 'https://api.nilai.nillion.network').replace(/\/+$/, '');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ALLOW_EXT = process.env.ALLOW_EXTENSION_ORIGINS === 'true';
const CORS = { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] || '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (statusCode, obj) => ({ statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

function originAllowed(event) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const h = event.headers || {};
  const origin = (h.origin || h.Origin || '').replace(/\/+$/, '');
  const referer = h.referer || h.Referer || '';
  if (ALLOW_EXT && origin.startsWith('chrome-extension://')) return true;
  return ALLOWED_ORIGINS.some((a) => origin === a || referer === a || referer.startsWith(a + '/'));
}

// Small helper matching the shape verifyEnclaveAttestation expects.
function ctx() {
  return { helpers: { httpRequest: async (o) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), o.timeout || 15000);
    try {
      const r = await fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.body, signal: c.signal });
      if (o.encoding === 'arraybuffer') return await r.arrayBuffer();
      if (o.encoding === 'text') return await r.text();
      if (o.json) return await r.json();
      return await r.text();
    } finally { clearTimeout(t); }
  } } };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!originAllowed(event)) return json(403, { error: 'forbidden: origin not allowed' });

  let attestation;
  try { attestation = await verifyEnclaveAttestation(ctx(), BASE); }
  catch (e) { attestation = { attestation_verified: false, error: e && e.message ? e.message : String(e) }; }

  let publicKey = null;
  try { publicKey = await (await fetch(BASE + '/v1/public_key')).json(); } catch (e) {}

  let rawReport = null, environment = null;
  try { const rr = await (await fetch(BASE + '/nilcc/api/v2/report')).json(); rawReport = rr.raw_report || null; environment = rr.environment || null; } catch (e) {}

  const receipt = { verified_at: new Date().toISOString(), endpoint: BASE, enclave_public_key: publicKey, attestation_report_hex: rawReport, environment };
  return json(200, { attestation, enclave_public_key: publicKey, receipt });
};
