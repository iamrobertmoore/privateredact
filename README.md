<p align="center">
  <img src="og-image.png" alt="Private Redaction" width="640">
</p>

<h1 align="center">Private Redaction</h1>

<p align="center">
  Redact sensitive information from documents in your browser — with cryptographic proof the AI that scanned them ran privately.
</p>

<p align="center">
  <a href="https://privateredact.app"><b>privateredact.app</b></a>
</p>

---

Private Redaction blacks out names, emails, phone numbers, addresses, IDs, card numbers and any custom terms in PDF, DOCX and TXT files. Your document is opened and redacted **entirely on your own device** — the file is never uploaded. To find what's sensitive, the extracted text is analysed by a private AI running inside a hardware-sealed enclave, and every run is verified against that enclave's attestation. So instead of trusting a promise that your document stayed private, you get to check it.

Free, no sign-up, runs in the browser.

## Why it's private

- **The file never leaves your device.** Extraction, redaction and PDF generation all happen client-side. Only the extracted *text* is sent for analysis — the document itself is never uploaded.
- **The AI runs in a sealed enclave.** Detection is performed by [Nillion nilAI](https://docs.nillion.com/build/private-llms/overview), a private LLM running inside an AMD SEV-SNP Trusted Execution Environment — hardware that the operator, the model host and the cloud provider cannot see into.
- **Verifiable, not asserted.** Every run is checked against the enclave's hardware attestation and a per-response signature, and the result is shown alongside your redaction.
- **Real redaction.** Redacted content is removed from the output, not just visually covered — there is no hidden text layer to recover.

## How it works

```
Browser
  file ──(read locally; never uploaded)──▶ extracted text
  text ──▶ verifier (serverless) ──▶ private LLM in a TEE   ← detection happens in the enclave
                    │  verifies the response signature (secp256k1)
                    │  verifies the SEV-SNP attestation (AMD certificate chain)
                    ◀── detected items + verification result
  redact + rebuild the PDF locally, show the preview + verification
```

Text detection uses a mix of local pattern rules (emails, phone numbers, card numbers, IDs, etc.) and the private LLM (names, organisations, addresses, and free-text instructions). The verifier is a small serverless function that holds the API credential server-side and runs a dependency-free AMD SEV-SNP attestation check; the browser only ever calls it, never the model directly.

## What the verification checks

- **Response signature** — the specific response was signed inside the enclave (secp256k1 ECDSA), verified against the enclave's public key.
- **Enclave attestation** — the AMD SEV-SNP attestation report is verified against AMD's certificate chain (root → intermediate → chip key), along with the report signature, the firmware/TCB versions, that debug mode is off, the launch measurement, and that the report is bound to the live session.

## Redaction output

- **PDF:** each page is rendered to an image, opaque boxes are painted over the sensitive spans, and the PDF is rebuilt from those images — the output contains no text objects, so nothing can be copied back out.
- **DOCX / TXT:** rebuilt as a clean PDF with the redacted spans removed.

## Run your own

The frontend is static and the verifier runs as a serverless function, so the model credential stays server-side and the browser only calls `/api/verify` on the same origin.

You'll need a Nillion nilAI API key. Then, on Netlify (or any host with serverless functions):

1. Deploy the repo. `netlify.toml` sets the publish and functions directories and the `/api/verify` route.
2. Set `NILAI_API_KEY` as an environment variable (the only secret; it never reaches the browser).
3. Set `ALLOWED_ORIGIN` to your site's origin(s) so the verifier isn't an open proxy.

For local development, `netlify dev` serves the site and the function together; put your key in a local `.env`.

## Notes & limitations

- **Automated redaction is not infallible.** It can miss things or over-cover; always review the preview before relying on or sharing the output.
- **The text is relayed to reach the enclave.** The file stays on your device, but the extracted text passes through the app's own verifier on its way to the enclave. The sealed, unreadable property is a guarantee about the enclave, not that relay.
- **PDF output is image-based**, so the redacted document's text is no longer selectable or searchable — the trade-off that guarantees true removal.
- This is an early, evolving tool provided **as is**, without warranty. See the [Terms of Use](https://privateredact.app/terms.html).

## Built with

- [Nillion nilAI](https://docs.nillion.com/build/private-llms/overview) — private LLM inference inside a TEE
- [pdf.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/), [mammoth](https://github.com/mwilliamson/mammoth.js) — in-browser document handling

## License

[MIT](LICENSE)
