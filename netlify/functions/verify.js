/* Netlify Function: nilAI verifier.
 * Same job as server/verify.js, packaged as a serverless function so the API key
 * stays server-side (in the NILAI_API_KEY env var) and the browser only ever
 * talks to /api/verify on the same origin. Reuses the tested SEV-SNP verifier.
 */
'use strict';

const { createPublicKey, verify: cryptoVerify } = require('crypto');
const { verifyEnclaveAttestation } = require('../../server/nilai-verifier/attestation.js');

const BASE = (process.env.NILAI_BASE_URL || 'https://api.nilai.nillion.network').replace(/\/+$/, '');
const KEY = process.env.NILAI_API_KEY;

const SPKI = Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex');
function publicKeyFromCompressedBase64(b64) {
  const point = Buffer.from(String(b64).trim().replace(/^"|"$/g, ''), 'base64');
  return createPublicKey({ key: Buffer.concat([SPKI, point]), format: 'der', type: 'spki' });
}
function verifyNilaiSignature(rawBody, pk) {
  try {
    const obj = JSON.parse(rawBody);
    const s = obj.signature;
    if (!s) return false;
    let pre = rawBody.replace(`"signature":"${s}"`, '"signature":""');
    for (const f of ['created_at', 'temperature', 'top_p']) pre = pre.replace(new RegExp(`("${f}":)(-?\\d+)([,}\\]])`), '$1$2.0$3');
    return cryptoVerify('sha256', Buffer.from(pre, 'utf8'), { key: publicKeyFromCompressedBase64(pk), dsaEncoding: 'der' }, Buffer.from(s, 'base64'));
  } catch { return false; }
}
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

// Restrict who can call this proxy. Set ALLOWED_ORIGIN in the Netlify env to your site
// origin(s), comma-separated (e.g. "https://privateredact.app,https://nilredact.netlify.app")
// to stop it being an open proxy to nilAI. Left blank (e.g. local dev) = allow all.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const CORS = { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] || '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (statusCode, obj) => ({ statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

function originAllowed(event) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const h = event.headers || {};
  const origin = (h.origin || h.Origin || '').replace(/\/+$/, '');
  const referer = h.referer || h.Referer || '';
  return ALLOWED_ORIGINS.some((a) => origin === a || referer === a || referer.startsWith(a + '/'));
}

// Lightweight per-IP rate limit (per warm instance). For hard cross-instance
// guarantees, back this with a shared store (e.g. Netlify Blobs / Upstash).
const RATE_MAX = parseInt(process.env.RATE_LIMIT_PER_MIN || '15', 10);
const RATE_WINDOW_MS = 60000;
const hits = new Map();
function rateLimited(event) {
  const h = event.headers || {};
  const ip = h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  if (hits.size > 5000) { for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k); }
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) { hits.set(ip, { start: now, count: 1 }); return false; }
  rec.count++;
  return rec.count > RATE_MAX;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };
  if (!originAllowed(event)) return json(403, { error: 'forbidden: origin not allowed' });
  if (rateLimited(event)) return { statusCode: 429, headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' }, body: JSON.stringify({ error: 'too many requests, please slow down and try again shortly' }) };
  if (!KEY) return json(500, { error: 'server not configured: NILAI_API_KEY is missing' });

  try {
    const p = JSON.parse(event.body || '{}');
    const model = p.model || 'google/gemma-4-26B-A4B-it';
    const input = String(p.input || '');

    const r = await fetch(BASE + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({ model, input }),
    });
    const rawBody = await r.text();
    if (!r.ok) return json(502, { error: 'nilAI ' + r.status + ': ' + rawBody.slice(0, 200) });
    const parsed = JSON.parse(rawBody);

    let publicKey = null, teeVerified = false;
    try { publicKey = await (await fetch(BASE + '/v1/public_key')).json(); teeVerified = verifyNilaiSignature(rawBody, publicKey); } catch (e) {}

    let attestation;
    try { attestation = await verifyEnclaveAttestation(ctx(), BASE); }
    catch (e) { attestation = { attestation_verified: false, error: e.message }; }

    // Raw attestation evidence for an independently-verifiable receipt. This proves the
    // enclave is genuine; it contains nothing about the user's document.
    let rawReport = null, environment = null;
    try { const rr = await (await fetch(BASE + '/nilcc/api/v2/report')).json(); rawReport = rr.raw_report || null; environment = rr.environment || null; } catch (e) {}
    const receipt = { verified_at: new Date().toISOString(), endpoint: BASE, enclave_public_key: publicKey, attestation_report_hex: rawReport, environment };

    const items = Array.isArray(parsed.output) ? parsed.output : [];
    const msg = items.find((o) => o && o.type === 'message') || items[0];
    const cont = Array.isArray(msg && msg.content) ? msg.content : [];
    const part = cont.find((c) => c && c.type === 'output_text') || cont[0];
    const text = part && typeof part.text === 'string' ? part.text : '';

    return json(200, { text, tee_verified: teeVerified, attestation, signature: parsed.signature || null, model: parsed.model || model, receipt });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
