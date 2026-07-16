/* Frontend config — loaded before app.js. Safe to commit: it contains NO secret.
 *
 * The nilAI key lives ONLY server-side (the verifier / Netlify function, via the
 * NILAI_API_KEY env var). The browser only ever calls `proxyUrl`, which returns
 * the redaction result plus the TEE verification. There is no `apiKey` here, so
 * nothing sensitive is shipped to visitors.
 *
 * Local dev and production both use `/api/verify` when run with `netlify dev` or
 * deployed to Netlify. If you host the verifier elsewhere (e.g. an EC2 box), set
 * `proxyUrl` to its absolute HTTPS URL instead.
 */
window.NILAI = {
  // Direct (private) path — the browser mints a delegation token via tokenUrl,
  // then calls the enclave directly at nucBaseUrl, so document text never touches
  // our server. attestUrl supplies the (text-free) enclave attestation proof.
  tokenUrl: '/api/token',
  attestUrl: '/api/attest',
  nucBaseUrl: 'https://api.nilai.nillion.network/nuc/v1/',
  clientBundle: 'lib/nilai-client.min.js',

  // Fallback path — if the direct path is unavailable, relay through the verifier
  // (server sees the text for that request only, but the enclave is still verified).
  proxyUrl: '/api/verify',

  baseUrl: 'https://api.nilai.nillion.network',
  model: 'google/gemma-4-26B-A4B-it'
};
