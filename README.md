# Private Redaction (MVP)

Upload a document, choose what to redact, and download a redacted PDF. The whole thing runs in your browser; the only data that leaves the page is the text sent to Nillion **nilAI** for AI-assisted detection, which is processed inside a Trusted Execution Environment (TEE).

This is an early MVP with deliberately neutral styling so the UX can be nailed before any branding.

## Why this is private

- **No backend.** The app is three static files (`index.html`, `styles.css`, `app.js`). When hosted on Netlify, GitHub Pages, S3/CloudFront, etc., there is no server of ours in the path, so no server we control ever receives your document.
- **Extraction, redaction and PDF generation happen locally** in the browser (pdf.js, mammoth, pdf-lib).
- **AI detection is the only network call**, and it goes to nilAI, where inference runs in a hardware-isolated TEE. The key is set by the site owner in `config.js` (see the security note below).
- **Real redaction, not black boxes over live text.** For PDFs, each page is rendered to an image, black boxes are painted over the sensitive spans, and the PDF is rebuilt from those images — so the output contains no text objects at all and nothing can be copied back out. For DOCX/TXT the text is rebuilt with redacted spans removed. Either way there is no hidden layer.

## How it works

```
File ──▶ extract text (browser) ──▶ detect ──▶ review/adjust ──▶ rebuild PDF (browser) ──▶ download
                                      │
                                      ├─ rule-based regex (email, phone, SSN, cards, IPs, URLs, dates) — 100% local
                                      ├─ nilAI in a TEE (names, orgs, addresses, free-text instructions)
                                      └─ your own literal terms
```

## Running locally

Two parts: the **verifier** (a small Node server that proves the TEE and holds the key) and the **static app**.

**1. Start the verifier**
```bash
cd nillion-redact
cp server/verify-config.example.js server/verify-config.js   # add your nilAI key
node server/verify.js                                        # http://localhost:8787
```

**2. Serve the app** (another terminal). pdf.js needs a real `http://` origin, so don't open the file directly:
```bash
python3 -m http.server 8000     # open http://localhost:8000
```

`config.js` (gitignored) points `proxyUrl` at the verifier. When it's running, every AI-detection run is cryptographically checked and the app shows a **"Processed in a verified TEE"** panel with the evidence. If the verifier isn't running, the app falls back to a direct nilAI call using the `apiKey` in `config.js` and clearly marks the run as **not** independently verified.

## What the verification proves

The verifier reuses the exact, tested checks from the `n8n-nodes-nilai` package and returns the result to the browser:

- **Response signature (`tee_verified`)** — the specific response was signed inside the enclave (secp256k1 ECDSA), verified against the enclave's public key.
- **Enclave attestation (`attestation_verified`)** — the AMD SEV-SNP hardware attestation report is verified against AMD's certificate chain (ARK→ASK→VCEK), the report signature, the TCB values, debug-disabled, the launch measurement, and binding to the live TLS session.

So the user sees proof, not a promise. The panel shows each sub-check and the raw evidence.

## Deploy it (Netlify)

The frontend is static and the verifier runs as a Netlify Function, so the nilAI key stays server-side and the browser only ever calls `/api/verify` on the same origin. `config.js` contains no secret.

1. Push the repo to GitHub and "Add new site → Import from Git" in Netlify (or run `netlify deploy`). `netlify.toml` sets the publish dir and functions dir.
2. In Netlify → Site settings → Environment variables, add **`NILAI_API_KEY`** (a freshly rotated nilAI key). That's the only place the key lives.
3. Deploy. The verifier is live at `/api/verify`; the app uses it automatically and shows the "Verified in a TEE" panel on each run.

Local dev with the same wiring:
```bash
npm i -g netlify-cli
cp .env.example .env          # put your nilAI key in .env
netlify dev                   # serves the site + the function at /api/verify
```

Notes:
- **Rotate the key** before deploying; set it only in the Netlify env var (and local `.env`), never in `config.js`.
- **Internal-only:** gate the site with Netlify's password protection / Netlify Identity (Site settings → Access control) so only your team can reach it.
- **Function timeout:** the attestation makes a few outbound calls; the built-in cert cache keeps warm runs fast. If a cold run times out, raise the function timeout on your plan.
- **Prefer AWS?** The same function code runs as a Lambda behind API Gateway, or you can run `node server/verify.js` on an EC2 box behind HTTPS and set `proxyUrl` in `config.js` to its URL.

## Known MVP limitations (intentional, for now)

- **PDF output preserves the original layout but is image-based** (rendered pages, so the text is no longer selectable/searchable). This is the trade-off that guarantees true removal. DOCX/TXT still produce a reflowed text PDF.
- **Redaction boxes on PDFs are positioned from pdf.js text coordinates** and are padded to cover cleanly; very unusual fonts/layouts could need a wider pad. Always eyeball the preview before downloading.
- **Supported inputs:** PDF, DOCX, TXT, MD. Scanned images / OCR are not handled yet.
- **Large documents** are truncated for the AI step (first ~15k characters); rule-based detection still covers the whole document.
- **No attestation UI yet.** The verification work from the n8n node can be ported here later to show a "provably private" badge on the result.
- **Third-party libraries load from a CDN.** For a trust-critical production build, vendor them locally so nothing but your own code runs.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell and UI |
| `styles.css` | Neutral styling |
| `app.js` | Extraction, detection, review, PDF generation |
| `config.js` | Frontend config: verifier URL / fallback key (gitignored) |
| `config.example.js` | Template to copy to `config.js` |
| `server/verify.js` | Local verification server (calls nilAI, checks signature + attestation) |
| `server/nilai-verifier/attestation.js` | Reused SEV-SNP verifier from the n8n node |
| `server/verify-config.js` | Server key (gitignored) |
| `test/smoke.js` | Offline sanity checks for the pure logic |
| `test/pdf.js` | End-to-end check that redacted text is unrecoverable |
