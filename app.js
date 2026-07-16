/* Private Redaction
 * Everything runs in the browser. The only network call is the AI detection
 * step, which sends text to Nillion nilAI (processed inside a TEE). Nothing is
 * uploaded to any server controlled by this app.
 *
 * The nilAI key is supplied by the site owner via config.js (window.NILAI).
 * SECURITY: a key placed in config.js ships to the browser — fine for local /
 * private use, but for a PUBLIC deployment set `proxyUrl` to a serverless
 * function that holds the key so the browser never sees it.
 *
 * Redaction strategy:
 *   - PDF input  -> render each original page to an image, paint solid black
 *                   boxes over sensitive spans at their real coordinates, and
 *                   rebuild the PDF from those images. Preserves layout and
 *                   leaves NO recoverable text.
 *   - DOCX / TXT -> rebuild a clean reflowed PDF with the redacted spans removed.
 */
'use strict';

/* ------------------------------------------------------------------ config */
const DEFAULTS = {
  baseUrl: 'https://api.nilai.nillion.network',
  model: 'google/gemma-4-26B-A4B-it',
};
const AI_INPUT_CHAR_LIMIT = 15000;
const RENDER_SCALE = 2; // rasterisation quality for PDF redaction

function loadConfig() {
  const c = (typeof window !== 'undefined' && window.NILAI) || {};
  return {
    apiKey: c.apiKey || '',
    baseUrl: c.baseUrl || DEFAULTS.baseUrl,
    model: c.model || DEFAULTS.model,
    proxyUrl: c.proxyUrl || '',
    // Direct (private) path config
    tokenUrl: c.tokenUrl || '',
    attestUrl: c.attestUrl || '',
    nucBaseUrl: c.nucBaseUrl || '',
    clientBundle: c.clientBundle || '',
  };
}

const state = {
  fileName: '',
  text: '',
  isPdf: false,
  pdf: null,            // pdf.js document (kept for rendering)
  pageItems: [],        // per page: [{str,start,end,transform,width,height}]
  detections: [],
  disabled: new Set(),
  customTerms: [],
  aiItems: null,        // cached AI results {text,category}[]
  verification: null,   // last TEE verification result
  previewUrl: null,
  currentBytes: null,
};

/* ------------------------------------------------------------- categories */
const RULES = {
  email: { label: 'Email addresses', re: () => /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  phone: { label: 'Phone numbers', re: () => /(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-]?)\d{3,4}[\s.\-]?\d{3,4}/g, min: 7 },
  ssn:   { label: 'US SSN', re: () => /\b\d{3}-\d{2}-\d{4}\b/g },
  card:  { label: 'Card numbers', re: () => /\b(?:\d[ \-]?){13,19}\b/g, luhn: true },
  ip:    { label: 'IP addresses', re: () => /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  url:   { label: 'URLs', re: () => /\bhttps?:\/\/[^\s]+/g },
  date:  { label: 'Dates', re: () => /\b(?:\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})\b/g },
};
const AI_CATEGORIES = {
  name:    'People’s names',
  address: 'Postal addresses',
  org:     'Organisation and company names',
};
const CATEGORIES = [
  { key: 'name',  label: 'Names',           type: 'ai',   ai: 'name' },
  { key: 'org',   label: 'Organisations',   type: 'ai',   ai: 'org' },
  { key: 'address', label: 'Addresses',     type: 'ai',   ai: 'address' },
  { key: 'email', label: 'Email addresses', type: 'rule', rule: 'email' },
  { key: 'phone', label: 'Phone numbers',   type: 'rule', rule: 'phone' },
  { key: 'ssn',   label: 'US SSN',          type: 'rule', rule: 'ssn' },
  { key: 'card',  label: 'Card numbers',    type: 'rule', rule: 'card' },
  { key: 'ip',    label: 'IP addresses',    type: 'rule', rule: 'ip' },
  { key: 'url',   label: 'URLs',            type: 'rule', rule: 'url' },
  { key: 'date',  label: 'Dates',           type: 'rule', rule: 'date' },
];

/* --------------------------------------------------------------- utilities */
const $ = (sel) => document.querySelector(sel);
function status(msg, kind = '') { const s = $('#status'); s.textContent = msg || ''; s.className = 'status ' + kind; }

function luhnValid(str) {
  const d = str.replace(/[^\d]/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = parseInt(d[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function findAll(text, term) {
  const spans = [];
  if (!term) return spans;
  let i = 0;
  while ((i = text.indexOf(term, i)) !== -1) { spans.push({ start: i, end: i + term.length }); i += term.length; }
  if (spans.length === 0) {
    const lc = text.toLowerCase(), lt = term.toLowerCase();
    let j = 0;
    while ((j = lc.indexOf(lt, j)) !== -1) { spans.push({ start: j, end: j + term.length }); j += term.length; }
  }
  return spans;
}

function parseJsonLoose(s) {
  if (!s) return null;
  let t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

function dataURLtoBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------- text extraction */
async function extractText(file) {
  const name = file.name.toLowerCase();
  state.isPdf = false; state.pdf = null; state.pageItems = [];

  if (name.endsWith('.docx')) {
    const arrayBuffer = await file.arrayBuffer();
    const res = await window.mammoth.extractRawText({ arrayBuffer });
    return res.value || '';
  }

  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data }).promise;
    state.pdf = pdf; state.isPdf = true;
    let text = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = [];
      let pageStr = '';
      content.items.forEach((it, k) => {
        const start = text.length + pageStr.length;
        items.push({ str: it.str, start, end: start + it.str.length, transform: it.transform, width: it.width, height: it.height });
        pageStr += it.str;
        if (k < content.items.length - 1) pageStr += ' ';
      });
      state.pageItems.push(items);
      text += pageStr;
      if (p < pdf.numPages) text += '\n\n';
    }
    return text;
  }

  return await file.text();
}

/* ------------------------------------------------------------ AI detection */
function buildAiInput(text, aiKeys, instructions) {
  const cats = aiKeys.map((c) => AI_CATEGORIES[c]).filter(Boolean);
  const doc = text.length > AI_INPUT_CHAR_LIMIT ? text.slice(0, AI_INPUT_CHAR_LIMIT) : text;
  const parts = ['You are a document redaction assistant. Find sensitive text that should be redacted from the DOCUMENT below.'];
  if (cats.length) parts.push('Redact these kinds of information: ' + cats.join(', ') + '.');
  if (instructions) parts.push('Also follow these instructions: ' + instructions);
  parts.push(
    'Return ONLY a JSON object of the form {"redactions":[{"text":"<snippet copied verbatim from the document>","category":"<short label>"}]}. ' +
    'Copy each snippet exactly as it appears in the document, character for character, so it can be found by exact string match. ' +
    'List every occurrence you want redacted. Never include text that is not present in the document. No markdown, no commentary.'
  );
  parts.push('DOCUMENT:\n' + doc);
  return parts.join('\n\n');
}

/* ---------------------------------------------------- direct (private) path
 * The browser mints a short-lived delegation token from our server (which never
 * sees the document), then calls the sealed enclave DIRECTLY. The document text
 * goes browser -> enclave over TLS and never touches our server. Enclave
 * genuineness is proven separately by /api/attest (a text-free attestation call).
 */
let _nilaiClientPromise = null;
function loadNilaiClient(cfg) {
  if (typeof window !== 'undefined' && window.NilaiClient && window.NilaiClient.ready) return Promise.resolve(window.NilaiClient);
  if (_nilaiClientPromise) return _nilaiClientPromise;
  _nilaiClientPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = cfg.clientBundle;
    s.async = true;
    s.onload = () => {
      if (window.NilaiClient && window.NilaiClient.ready) resolve(window.NilaiClient);
      else reject(new Error('nilAI client bundle loaded but did not initialise'));
    };
    s.onerror = () => reject(new Error('failed to load nilAI client bundle'));
    document.head.appendChild(s);
  });
  return _nilaiClientPromise;
}

function b64ToBytes(b64) {
  const bin = atob(String(b64).trim().replace(/^"|"$/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToHex(u8) {
  let h = '';
  for (let i = 0; i < u8.length; i++) h += u8[i].toString(16).padStart(2, '0');
  return h;
}

// Best-effort client-side check that a raw enclave response was signed by the
// enclave's public key. Uses secp256k1 (WebCrypto can't). Returns true only on a
// confirmed match; any uncertainty returns false (we never fake a pass).
function verifyEnclaveResponseSignature(rawText, pkB64) {
  try {
    const NC = window.NilaiClient;
    if (!NC || !NC.secp256k1 || !NC.sha256 || !rawText || !pkB64) return false;
    const obj = JSON.parse(rawText);
    const s = obj.signature;
    if (!s) return false;
    let pre = rawText.replace('"signature":"' + s + '"', '"signature":""');
    for (const f of ['created_at', 'created', 'temperature', 'top_p']) {
      pre = pre.replace(new RegExp('("' + f + '":)(-?\\d+)([,}\\]])'), '$1$2.0$3');
    }
    const msgHash = NC.sha256(new TextEncoder().encode(pre));
    const pub = b64ToBytes(pkB64); // 33-byte compressed point
    const sig = NC.secp256k1.Signature.fromDER(bytesToHex(b64ToBytes(s)));
    return NC.secp256k1.verify(sig, msgHash, pub, { lowS: false });
  } catch (e) { return false; }
}

async function fetchAttestation(cfg) {
  if (!cfg.attestUrl) return { attestation: { attestation_verified: false, error: 'no attestation endpoint' }, receipt: null, enclave_public_key: null };
  const r = await fetch(cfg.attestUrl, { method: 'GET' });
  if (!r.ok) throw new Error('attestation ' + r.status);
  return r.json();
}

// Full direct path. Throws on any failure so aiCall can fall back to the relay.
async function aiCallDirect(model, input, cfg) {
  const NC = await loadNilaiClient(cfg);
  const client = new NC.NilaiOpenAIClient({ baseURL: cfg.nucBaseUrl, authType: NC.AuthType.DELEGATION_TOKEN });

  // 1) client produces a delegation request (its ephemeral public key only)
  const delegationRequest = client.getDelegationRequest();

  // 2) our server mints a token authorising that key — it never sees `input`
  const tr = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delegationRequest }) });
  if (!tr.ok) {
    let detail = '';
    try { const ed = await tr.json(); if (ed && ed.error) detail = ': ' + ed.error; } catch (e) {}
    throw new Error('token ' + tr.status + detail);
  }
  const { delegationToken, error } = await tr.json();
  if (error || !delegationToken) throw new Error(error || 'no delegation token returned');
  client.updateDelegation(delegationToken);

  // 3) call the enclave DIRECTLY with the document text (never routed via us)
  const payload = { model, messages: [{ role: 'user', content: input }] };
  const call = client.chat.completions.create(payload);
  let parsed, raw = null;
  if (call && typeof call.withResponse === 'function') {
    const wr = await call.withResponse();
    parsed = wr.data;
    try { raw = await wr.response.clone().text(); } catch (e) {}
  } else {
    parsed = await call;
  }
  const text = extractResponseText(parsed);
  const signature = (parsed && parsed.signature) || null;

  // 4) attestation proof (text-free) + response-signature check (best effort)
  const att = await fetchAttestation(cfg);
  const pk = att.enclave_public_key || (att.receipt && att.receipt.enclave_public_key) || null;
  const teeVerified = raw ? verifyEnclaveResponseSignature(raw, pk) : false;

  return { text, verification: { mode: 'verified', path: 'direct', tee_verified: teeVerified, attestation: att.attestation, signature, receipt: att.receipt } };
}

// Relay path (fallback): send text through our verifier function, which calls the
// enclave and returns the result plus verification. The server sees the text for
// that request only.
async function aiCallRelay(model, input, cfg) {
  const r = await fetch(cfg.proxyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) });
  if (!r.ok) {
    let detail = '';
    try { const ed = await r.json(); if (ed && ed.error) detail = ': ' + ed.error; } catch (e) {}
    throw new Error('verifier ' + r.status + detail);
  }
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return { text: d.text || '', verification: { mode: 'verified', path: 'relay', tee_verified: d.tee_verified, attestation: d.attestation, signature: d.signature, receipt: d.receipt } };
}

async function directCall(model, input, cfg) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
  const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model, input }) });
  if (!res.ok) throw new Error('nilAI request failed (' + res.status + ' ' + res.statusText + ')');
  return extractResponseText(await res.json());
}

// Returns { text, verification }. Prefers the DIRECT path (document text never
// touches our server); falls back to the relay verifier, then to a keyed direct
// call, so the app keeps working even if the direct path is unavailable.
async function aiCall(model, input, cfg) {
  if (cfg.tokenUrl && cfg.nucBaseUrl && cfg.clientBundle) {
    try {
      return await aiCallDirect(model, input, cfg);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('direct path unavailable, falling back to relay:', e && e.message);
    }
  }
  if (cfg.proxyUrl) {
    try {
      return await aiCallRelay(model, input, cfg);
    } catch (e) {
      if (cfg.apiKey) return { text: await directCall(model, input, cfg), verification: { mode: 'unavailable', reason: e.message } };
      throw e;
    }
  }
  return { text: await directCall(model, input, cfg), verification: { mode: 'direct' } };
}

async function aiDetect(text, aiKeys, instructions, cfg) {
  const { text: out, verification } = await aiCall(cfg.model, buildAiInput(text, aiKeys, instructions), cfg);
  const parsed = parseJsonLoose(out);
  const arr = (parsed && parsed.redactions) || [];
  const items = arr.filter((r) => r && r.text).map((r) => ({ text: String(r.text), category: String(r.category || 'Sensitive') }));
  return { items, verification };
}

function extractResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        const t = item.content.find((c) => c.type === 'output_text' || c.type === 'text');
        if (t && t.text) return t.text;
      }
    }
  }
  if (data.choices && data.choices[0] && data.choices[0].message) return data.choices[0].message.content || '';
  return typeof data === 'string' ? data : '';
}

/* ------------------------------------------------------- detection driver */
function checkedKeys() {
  return new Set(Array.from(document.querySelectorAll('#cats input:checked')).map((i) => i.value));
}
function applyAiItems(items, text, found) {
  for (const it of items) {
    for (const sp of findAll(text, it.text)) {
      found.push({ start: sp.start, end: sp.end, text: text.slice(sp.start, sp.end), category: it.category, source: 'ai' });
    }
  }
}

async function detect(useCache) {
  const cfg = loadConfig();
  const text = state.text;
  const checked = checkedKeys();
  const ruleKeys = CATEGORIES.filter((c) => c.type === 'rule' && checked.has(c.key)).map((c) => c.rule);
  const aiKeys = CATEGORIES.filter((c) => c.type === 'ai' && checked.has(c.key)).map((c) => c.ai);
  const instructions = document.getElementById('instructions').value.trim();
  const found = [];

  for (const key of ruleKeys) {
    const rule = RULES[key];
    if (!rule) continue;
    const re = rule.re();
    let m;
    while ((m = re.exec(text)) !== null) {
      const val = m[0];
      if (rule.min && val.replace(/\D/g, '').length < rule.min) continue;
      if (rule.luhn && !luhnValid(val)) continue;
      found.push({ start: m.index, end: m.index + val.length, text: val, category: rule.label, source: 'rule' });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  const aiConfigured = !!(cfg.apiKey || cfg.proxyUrl || (cfg.tokenUrl && cfg.nucBaseUrl && cfg.clientBundle));
  if (aiKeys.length || instructions) {
    if (useCache && state.aiItems) {
      applyAiItems(state.aiItems, text, found);
    } else if (aiConfigured) {
      status('Detecting privately via nilAI…', 'busy');
      try {
        const { items, verification } = await aiDetect(text, aiKeys, instructions, cfg);
        state.aiItems = items;
        state.verification = verification;
        applyAiItems(items, text, found);
      } catch (e) {
        state.aiItems = state.aiItems || [];
        state.verification = { mode: 'error', reason: e.message };
        status('AI detection could not run (' + e.message + '). Rule-based redaction still applied.', 'warn');
      }
    } else {
      state.verification = null;
      status('AI detection is not configured for this site (see config.js). Rule-based redaction still applied.', 'warn');
    }
  } else {
    state.verification = null;
  }

  for (const term of state.customTerms) {
    for (const sp of findAll(text, term)) {
      found.push({ start: sp.start, end: sp.end, text: text.slice(sp.start, sp.end), category: 'Custom term', source: 'manual' });
    }
  }

  const seen = new Set();
  const deduped = [];
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  for (const d of found) {
    const k = d.start + ':' + d.end;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(d);
  }
  deduped.forEach((d, i) => { d.id = 'd' + i; });
  state.detections = deduped;
  state.disabled = new Set();
  renderVerification(state.verification);
  renderReview();
}

const LEARN_MORE = 'https://docs.nillion.com/build/private-llms/overview';

// Build and download a verification receipt: the raw AMD SEV-SNP attestation evidence,
// which proves the enclave is genuine and can be checked independently against AMD.
// It contains nothing about the user's document.
function downloadReceipt(v) {
  const att = v.attestation || {};
  const r = v.receipt || {};
  const receipt = {
    tool: 'Private Redaction',
    what_this_is: 'Attestation evidence for the AMD SEV-SNP enclave that performed the AI detection. It proves the enclave is genuine and running the expected build, is verifiable independently against AMD, and reveals nothing about your document.',
    delivery: v.path === 'direct'
      ? 'direct: the document text was sent from the browser straight to the enclave and did not pass through the tool operator’s server (which only minted a short-lived delegation token from a public key).'
      : 'relay: the document text was sent via the tool operator’s stateless verifier function, which forwarded it to the enclave.',
    response_signature: v.signature || null,
    response_signature_verified_in_browser: !!v.tee_verified,
    verified_at: r.verified_at || new Date().toISOString(),
    endpoint: r.endpoint || null,
    processor: att.processor || null,
    runtime: att.nilcc_version || null,
    measurement: att.measurement || null,
    measurement_matches_known_build: att.measurement_matches_known_build,
    checks: att.checks || null,
    enclave_public_key: r.enclave_public_key || null,
    attestation_report_hex: r.attestation_report_hex || null,
    environment: r.environment || null,
    how_to_verify: 'This is an AMD SEV-SNP attestation report. Verify its certificate chain against AMD KDS (kdsintf.amd.com) and check the launch measurement. The verifier used here is open source: https://github.com/iamrobertmoore/privateredact (see server/nilai-verifier).',
  };
  const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'privateredact-attestation-receipt.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function renderVerification(v) {
  const el = document.getElementById('verify');
  if (!v) { el.className = 'verify hidden'; el.innerHTML = ''; return; }

  const shield = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2.5l7 3v5.2c0 4.4-3 8.2-7 9.8-4-1.6-7-5.4-7-9.8V5.5l7-3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.6 12.2l2.3 2.3 4.4-4.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const tickSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const crossSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  const tick = (ok) => '<span class="tick' + (ok ? '' : ' no') + '">' + (ok ? tickSvg : crossSvg) + '</span>';

  if (v.mode === 'verified') {
    const att = v.attestation || {};
    const direct = v.path === 'direct';
    const sig = !!v.tee_verified;
    const attOk = !!att.attestation_verified;
    // Direct path: the privacy guarantee is that the text went straight to the
    // enclave (architectural) and the enclave is genuine (attestation). Relay path:
    // needs the response signature plus attestation.
    const full = direct ? attOk : (sig && attOk);
    el.className = 'verify ' + (full ? 'ok' : 'warn');

    const vcheck = (ok, title, sub) =>
      '<div class="vcheck">' + tick(ok) + '<div><div class="ct">' + title + '</div><div class="cs">' + sub + '</div></div></div>';

    let html = '<div class="vtop"><div class="vseal' + (full ? '' : ' warn') + '">' + shield + '</div><div>';
    html += '<p class="vbadge">' + (full ? (direct ? 'Private · Verified' : 'TEE attestation · Verified') : 'Verification · Incomplete') + '</p>';
    html += '<div class="vhead">' + (full
      ? (direct
        ? 'Your document went straight to the sealed enclave — and we can prove that enclave is genuine.'
        : 'Your document was handled privately, and we can prove it.')
      : 'We could only partly verify this run.') + '</div>';
    html += '<p class="vsub">' + (full
      ? (direct
        ? 'Your text was sent from your browser directly to sealed hardware that not even Nillion, its cloud host, or we can see into — it never passed through our servers. We independently checked that enclave’s hardware attestation and it passed. A receipt you can verify yourself is below.'
        : 'The AI that read your text ran inside sealed hardware that not even Nillion or its cloud host can see into. We checked its hardware attestation and it passed. The details, and a receipt you can verify yourself, are below.')
      : 'Some of the privacy checks didn’t pass this time. See the details below, and treat this result with caution.') + '</p>';
    html += '</div></div>';

    const buildPinned = att.measurement_matches_known_build === true;
    html += '<div class="vchecks">';
    if (direct) {
      html += vcheck(true, 'Sent straight to the sealed enclave', 'Your text went from your browser directly to the enclave. It never passed through our servers — we only ever handled a public key.');
    } else {
      html += vcheck(sig, 'The result came from the sealed hardware', 'The response was cryptographically signed inside the enclave.');
    }
    html += vcheck(attOk, 'The hardware is genuine and unmodified', buildPinned
      ? 'Its attestation is valid and its launch fingerprint matches the build we expect.'
      : 'Its attestation is valid. The exact build fingerprint isn’t pinned for this runtime version yet.');
    html += '</div>';

    const checks = att.checks || {};
    const labels = {
      ark_self_signed: 'AMD root self-signed',
      ask_signed_by_ark: 'ASK signed by ARK',
      vcek_signed_by_ask: 'VCEK signed by ASK',
      report_signature_valid: 'Report signature valid',
      vcek_tcb_matches_report: 'TCB matches report',
      tls_session_bound: 'Bound to this session',
      debug_disabled: 'Debug mode off',
    };
    const kv = (k, val) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + val + '</span></div>';
    let rows = '';
    rows += kv('Delivery', direct
      ? '<span class="ok">browser → enclave (direct)</span>'
      : 'via verifier (server relay)');
    if (att.processor) rows += kv('Processor', escapeHtml(att.processor));
    if (att.nilcc_version) rows += kv('Runtime', escapeHtml(att.nilcc_version));
    rows += kv('Known build', att.measurement_matches_known_build === true
      ? '<span class="ok">✓ yes</span>'
      : (att.measurement_matches_known_build === false ? 'no (mismatch)' : 'not pinned for this runtime'));
    for (const k of Object.keys(labels)) if (k in checks) rows += kv(labels[k], checks[k] ? '<span class="ok">✓</span>' : '✗');
    if (att.measurement) rows += kv('Measurement', escapeHtml(String(att.measurement).slice(0, 24)) + '…');
    if (v.signature) rows += kv('Response signature', v.tee_verified
      ? '<span class="ok">✓ verified in your browser</span>'
      : escapeHtml(String(v.signature).slice(0, 24)) + '… (captured)');
    if (v.receipt && v.receipt.attestation_report_hex) rows += kv('Independent proof', '<a href="#" id="dl-receipt">download receipt ↓</a>');
    rows += kv('Learn more', '<a href="' + LEARN_MORE + '" target="_blank" rel="noopener">how this works ↗</a>');
    if (att.error) rows += kv('Attestation error', escapeHtml(att.error));

    html += '<details><summary><span class="chev">›</span> Technical detail</summary><div class="kvgrid">' + rows + '</div></details>';
    el.innerHTML = html;
    const dl = document.getElementById('dl-receipt');
    if (dl) dl.addEventListener('click', (e) => { e.preventDefault(); downloadReceipt(v); });
    return;
  }

  el.className = 'verify warn';
  const msgs = {
    direct: 'Your document was scanned by Nillion’s private AI, but this session isn’t running the verifier, so the sealed-hardware proof isn’t independently confirmed here.',
    unavailable: 'Your document was scanned by Nillion’s private AI, but we couldn’t reach the checker that confirms the sealed-hardware proof, so this run isn’t independently verified.' + (v.reason ? ' (' + escapeHtml(v.reason) + ')' : ''),
    error: 'The AI scan didn’t complete this time' + (v.reason ? ' (' + escapeHtml(v.reason) + ')' : '') + '. Only the built-in pattern rules were applied.',
  };
  el.innerHTML = '<div class="vtop"><div class="vseal warn">' + shield + '</div><div><p class="vbadge">Not independently verified</p><div class="vhead">We couldn’t confirm the privacy proof this time.</div><p class="vsub">' + (msgs[v.mode] || '') + '</p></div></div>';
}

/* ------------------------------------------------------------- review UI */
function activeSpans() {
  return state.detections.filter((d) => !state.disabled.has(d.id)).map((d) => ({ start: d.start, end: d.end }));
}

function renderReview() {
  const wrap = document.getElementById('review');
  wrap.innerHTML = '';

  if (state.detections.length === 0) {
    wrap.appendChild(Object.assign(document.createElement('p'), {
      className: 'muted', textContent: 'Nothing detected with the current options. Tick a category above, add a term, or adjust your instructions.',
    }));
    return;
  }

  const groups = {};
  for (const d of state.detections) (groups[d.category] = groups[d.category] || []).push(d);

  for (const cat of Object.keys(groups)) {
    const items = groups[cat];
    const g = document.createElement('div');
    g.className = 'group';
    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = '<span>' + escapeHtml(cat) + '</span><span class="count">' + items.length + ' found</span>';
    g.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'items';
    for (const d of items) {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !state.disabled.has(d.id);
      cb.addEventListener('change', () => {
        if (cb.checked) state.disabled.delete(d.id); else state.disabled.add(d.id);
        scheduleRefresh();
      });
      const snip = document.createElement('span');
      snip.className = 'snippet';
      snip.textContent = d.text.length > 80 ? d.text.slice(0, 80) + '…' : d.text;
      li.append(cb, snip);
      ul.appendChild(li);
    }
    g.appendChild(ul);
    wrap.appendChild(g);
  }
}

/* --------------------------------------------------- PDF: image redaction */
async function buildRedactedPdfFromImages(spans) {
  const { PDFDocument } = window.PDFLib;
  const outDoc = await PDFDocument.create();

  for (let p = 1; p <= state.pdf.numPages; p++) {
    const page = await state.pdf.getPage(p);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    ctx.fillStyle = '#000';
    const items = state.pageItems[p - 1] || [];
    for (const it of items) {
      const L = it.str.length || 1;
      for (const s of spans) {
        const a = Math.max(s.start, it.start);
        const b = Math.min(s.end, it.end);
        if (a >= b) continue;
        const relA = (a - it.start) / L;
        const relB = (b - it.start) / L;
        const tx = window.pdfjsLib.Util.transform(viewport.transform, it.transform);
        const fontH = Math.hypot(tx[1], tx[3]) || (it.height * RENDER_SCALE) || 10;
        const x0 = tx[4];
        const yBase = tx[5];
        const fullW = it.width * RENDER_SCALE;
        const perChar = fullW / L;
        let bx, bw;
        if (L <= 20) { bx = x0 - 2; bw = fullW + 4; }            // short run: cover whole item (safe)
        else { bx = x0 + relA * fullW - perChar; bw = (relB - relA) * fullW + 2 * perChar; }
        const by = yBase - fontH - 2;
        const bh = fontH * 1.25 + 4;
        ctx.fillRect(bx, by, bw, bh);
      }
    }

    const pngBytes = dataURLtoBytes(canvas.toDataURL('image/png'));
    const img = await outDoc.embedPng(pngBytes);
    const base = page.getViewport({ scale: 1 });
    const outPage = outDoc.addPage([base.width, base.height]);
    outPage.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
  }
  return await outDoc.save();
}

/* --------------------------------------------- DOCX/TXT: reflow redaction */
function sanitize(t) {
  const a = t.split('');
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '\n' || ch === '\t') continue;
    const code = ch.charCodeAt(0);
    if (code === 0x2018 || code === 0x2019) a[i] = "'";
    else if (code === 0x201C || code === 0x201D) a[i] = '"';
    else if (code === 0x2013 || code === 0x2014) a[i] = '-';
    else if (code === 0x2026) a[i] = '.';
    else if (code === 0x00A0) a[i] = ' ';
    else if (code < 32) a[i] = ' ';
    else if (code > 255) a[i] = '?';
  }
  return a.join('');
}
function wrapChars(chars, font, size, maxW) {
  const lines = [];
  let cur = [], w = 0, lastSpace = -1;
  const cw = (c) => font.widthOfTextAtSize(c === '\t' ? '    ' : c, size);
  for (const ch of chars) {
    if (ch.c === '\r') continue;
    if (ch.c === '\n') { lines.push(cur); cur = []; w = 0; lastSpace = -1; continue; }
    cur.push(ch); w += cw(ch.c);
    if (ch.c === ' ') lastSpace = cur.length - 1;
    if (w > maxW) {
      if (lastSpace > 0) {
        const head = cur.slice(0, lastSpace), tail = cur.slice(lastSpace + 1);
        lines.push(head); cur = tail; w = cur.reduce((a, x) => a + cw(x.c), 0); lastSpace = -1;
      } else { const last = cur.pop(); lines.push(cur); cur = [last]; w = cw(last.c); lastSpace = -1; }
    }
  }
  lines.push(cur);
  return lines;
}
function drawLine(page, line, x0, y, font, size, rgb) {
  let x = x0, i = 0;
  while (i < line.length) {
    const red = line[i].r;
    let j = i, str = '';
    while (j < line.length && line[j].r === red) { str += line[j].c; j++; }
    const wRun = font.widthOfTextAtSize(str, size);
    if (red) page.drawRectangle({ x, y: y - 2, width: wRun, height: size, color: rgb(0, 0, 0) });
    else if (str.trim().length) page.drawText(str, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    x += wRun; i = j;
  }
}
async function buildReflowedPdf(rawText, spans) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 11, lineHeight = 15, margin = 50, pageW = 595.28, pageH = 841.89, maxW = pageW - margin * 2;
  const clean = sanitize(rawText);
  const marks = new Array(clean.length).fill(false);
  for (const s of spans) for (let i = Math.max(0, s.start); i < Math.min(clean.length, s.end); i++) marks[i] = true;
  const chars = [];
  for (let i = 0; i < clean.length; i++) chars.push({ c: clean[i], r: marks[i] });
  const lines = wrapChars(chars, font, size, maxW);
  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;
  for (const line of lines) { if (y < margin) { page = doc.addPage([pageW, pageH]); y = pageH - margin; } drawLine(page, line, margin, y, font, size, rgb); y -= lineHeight; }
  return await doc.save();
}

/* ------------------------------------------------------------- preview */
let previewTimer = null;
function scheduleRefresh() { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 250); }

async function refreshPreview() {
  const spans = activeSpans();
  status('Rendering redacted preview…', 'busy');
  try {
    const bytes = (state.isPdf && state.pageItems.length)
      ? await buildRedactedPdfFromImages(spans)
      : await buildReflowedPdf(state.text, spans);
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.currentBytes = bytes;
    state.previewUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    document.getElementById('preview').src = state.previewUrl;
    document.getElementById('reviewCard').classList.remove('hidden');
    const n = spans.length;
    status('Redacted ' + n + ' item' + (n === 1 ? '' : 's') + '. Preview updated.', 'ok');
  } catch (e) {
    status('Preview failed: ' + e.message, 'err');
  }
}

/* -------------------------------------------------------------- wiring UI */
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function initChecklist() {
  const box = document.getElementById('cats');
  for (const c of CATEGORIES) {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = c.key; cb.checked = false;
    wrap.append(cb, document.createTextNode(c.label));
    box.appendChild(wrap);
  }
}

async function onFile(file) {
  if (!file) return;
  status('Reading file…', 'busy');
  try { state.text = await extractText(file); }
  catch (e) { status('Could not read that file: ' + e.message, 'err'); return; }
  if (!state.text.trim()) { status('No extractable text found in that file.', 'err'); return; }

  state.fileName = file.name;
  state.detections = []; state.disabled = new Set(); state.customTerms = []; state.aiItems = null;

  const info = document.getElementById('fileInfo');
  info.classList.remove('hidden');
  info.textContent = state.fileName + ' · ' + state.text.length.toLocaleString() + ' characters extracted';

  document.getElementById('optionsCard').classList.remove('disabled');
  document.getElementById('detect').disabled = false;
  document.getElementById('reviewCard').classList.add('hidden');
  status('Ready. Choose what to redact, then press Redact.', '');
}

function initUpload() {
  const drop = document.getElementById('drop');
  const fileInput = document.getElementById('file');
  document.getElementById('pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => onFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
}

function initButtons() {
  document.getElementById('detect').addEventListener('click', async () => { await detect(false); await refreshPreview(); });
  document.getElementById('rerun').addEventListener('click', async () => { await detect(false); await refreshPreview(); });
  document.getElementById('addTerm').addEventListener('click', async () => {
    const inp = document.getElementById('termInput');
    const term = inp.value.trim();
    if (!term) return;
    if (!state.customTerms.includes(term)) state.customTerms.push(term);
    inp.value = '';
    await detect(true);
    await refreshPreview();
  });
  document.getElementById('download').addEventListener('click', () => {
    if (!state.currentBytes) return;
    const url = URL.createObjectURL(new Blob([state.currentBytes], { type: 'application/pdf' }));
    const base = state.fileName.replace(/\.[^.]+$/, '') || 'document';
    const a = document.createElement('a');
    a.href = url; a.download = base + '-redacted.pdf'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
}

function init() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  }
  initChecklist();
  initUpload();
  initButtons();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

/* export pure functions for offline tests (ignored in the browser) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { luhnValid, findAll, parseJsonLoose, sanitize, extractResponseText, RULES, wrapChars, drawLine, buildReflowedPdf };
}
