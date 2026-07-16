/* Pre-bundled Netlify function: nilAI delegation-token minter (ESM).
 * Built from @nillion/nilai-ts with @nillion/secretvaults stubbed out (nilDB path,
 * not needed for delegation) to keep the bundle free of Node-incompatible ESM.
 * The document text NEVER reaches this function — it only ever sees a public key.
 * Source + build: scripts/nilai-client-build/ (token-fn-entry.mjs + build-token-fn.mjs).
 */
import { DelegationTokenServer } from '@nillion/nilai-ts';

const KEY = process.env.NILAI_DELEGATION_KEY || process.env.NILAI_API_KEY;
const EXPIRY_SEC = parseInt(process.env.DELEGATION_TTL_SEC || '20', 10);
const MAX_USES = parseInt(process.env.DELEGATION_MAX_USES || '1', 10);

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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };
  if (!originAllowed(event)) return json(403, { error: 'forbidden: origin not allowed' });
  if (rateLimited(event)) return { statusCode: 429, headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' }, body: JSON.stringify({ error: 'too many requests, please slow down and try again shortly' }) };
  if (!KEY) return json(500, { error: 'server not configured: NILAI_API_KEY is missing' });

  try {
    const p = JSON.parse(event.body || '{}');
    const req = p.delegationRequest || p.request;
    if (!req || typeof req !== 'object' || req.type !== 'DELEGATION_TOKEN_REQUEST' || !req.public_key) {
      return json(400, { error: 'missing or invalid delegationRequest' });
    }
    const server = new DelegationTokenServer(KEY, { expirationTime: EXPIRY_SEC, tokenMaxUses: MAX_USES });
    const delegationToken = await server.createDelegationToken(req);
    return json(200, { delegationToken });
  } catch (e) {
    const m = (e && e.message) ? e.message : String(e);
    const hint = /hex/i.test(m) ? ' (the delegation key must be a hex private key, e.g. from nilpay.vercel.app — not a UUID API key)' : '';
    return json(500, { error: 'failed to mint delegation token: ' + m + hint });
  }
};
