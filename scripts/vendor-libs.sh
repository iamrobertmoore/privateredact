#!/usr/bin/env bash
# Download the browser libraries locally so the deployed site loads NO third-party
# CDN scripts (closes the supply-chain risk from CDN-hosted JavaScript).
# Run from the project root before deploying:  bash scripts/vendor-libs.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p lib
base="https://cdnjs.cloudflare.com/ajax/libs"
curl -fsSL "$base/pdf.js/3.11.174/pdf.min.js"           -o lib/pdf.min.js
curl -fsSL "$base/pdf.js/3.11.174/pdf.worker.min.js"    -o lib/pdf.worker.min.js
curl -fsSL "$base/mammoth/1.6.0/mammoth.browser.min.js" -o lib/mammoth.browser.min.js
curl -fsSL "$base/pdf-lib/1.17.1/pdf-lib.min.js"        -o lib/pdf-lib.min.js
echo "Vendored 4 libraries into ./lib"
