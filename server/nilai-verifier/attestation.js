"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectProcessor = detectProcessor;
exports.verifyTcbExtensions = verifyTcbExtensions;
exports.checkReportDataBinding = checkReportDataBinding;
exports.verifyEnclaveAttestation = verifyEnclaveAttestation;
const crypto_1 = require("crypto");
const tls_1 = require("tls");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const KDS_DOMAIN = 'kdsintf.amd.com';
const KNOWN_MEASUREMENTS = {
    '0.3.0': '981bcaa62bcd63cb03c7b93a67d1a8c17ff63e45e6d16323a8784bacbfcb254313741bcf32d0bccc795d6ea0e6ac1481',
};
const certChainCache = {};
const vcekCache = {};
function certCacheDir() {
    for (const base of [(0, path_1.join)((0, os_1.homedir)(), '.n8n'), (0, os_1.tmpdir)()]) {
        try {
            const dir = (0, path_1.join)(base, '.nilai-cert-cache');
            (0, fs_1.mkdirSync)(dir, { recursive: true });
            return dir;
        }
        catch {
        }
    }
    return (0, os_1.tmpdir)();
}
function readCertCache(name) {
    try {
        const p = (0, path_1.join)(certCacheDir(), name);
        return (0, fs_1.existsSync)(p) ? (0, fs_1.readFileSync)(p) : null;
    }
    catch {
        return null;
    }
}
function writeCertCache(name, data) {
    try {
        (0, fs_1.writeFileSync)((0, path_1.join)(certCacheDir(), name), data);
    }
    catch {
    }
}
function detectProcessor(family, model) {
    if (family === 0x19) {
        if (model <= 0x0f)
            return 'Milan';
        if ((model >= 0x10 && model <= 0x1f) || (model >= 0xa0 && model <= 0xaf))
            return 'Genoa';
        return null;
    }
    if (family === 0x1a)
        return 'Turin';
    return null;
}
function leToBe48(le) {
    const be = Buffer.from(le).reverse();
    return be.subarray(be.length - 48);
}
const SNP_OID = {
    bootloader: '2b060104019c78010301',
    tee: '2b060104019c78010302',
    snp: '2b060104019c78010303',
    ucode: '2b060104019c78010308',
    hwid: '2b060104019c780104',
};
function extValue(der, oidHex) {
    const oid = Buffer.from(oidHex, 'hex');
    const idx = der.indexOf(oid);
    if (idx < 0)
        return null;
    let p = idx + oid.length;
    if (der[p] === 0x01)
        p += 3;
    if (der[p] !== 0x04)
        return null;
    let len = der[p + 1];
    let start = p + 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++)
            len = (len << 8) | der[start + i];
        start += n;
    }
    return der.subarray(start, start + len);
}
function intExt(der, oidHex) {
    const v = extValue(der, oidHex);
    if (!v || v[0] !== 0x02)
        return null;
    return v[v.length - 1];
}
function verifyTcbExtensions(vcekDer, tcb, chipIdHex) {
    if (intExt(vcekDer, SNP_OID.bootloader) !== tcb.bootloader)
        return false;
    if (intExt(vcekDer, SNP_OID.tee) !== tcb.tee)
        return false;
    if (intExt(vcekDer, SNP_OID.snp) !== tcb.snp)
        return false;
    if (intExt(vcekDer, SNP_OID.ucode) !== tcb.microcode)
        return false;
    const hwid = extValue(vcekDer, SNP_OID.hwid);
    if (!hwid || hwid.toString('hex') !== chipIdHex)
        return false;
    return true;
}
function parseCertChain(pem) {
    try {
        const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
        let ark;
        let ask;
        for (const block of blocks) {
            const c = new crypto_1.X509Certificate(block);
            if (c.verify(c.publicKey))
                ark = c;
            else
                ask = c;
        }
        return ark && ask ? { ark, ask } : null;
    }
    catch {
        return null;
    }
}
async function getServerCertDer(host) {
    return new Promise((resolve) => {
        let settled = false;
        let socket;
        const finish = (v) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                socket?.destroy();
            }
            catch {
            }
            resolve(v);
        };
        const timer = setTimeout(() => finish(null), 7000);
        try {
            socket = (0, tls_1.connect)({ host, port: 443, servername: host, rejectUnauthorized: true }, () => {
                try {
                    const peer = socket.getPeerCertificate();
                    finish(peer && peer.raw ? peer.raw : null);
                }
                catch {
                    finish(null);
                }
            });
            socket.on('error', () => finish(null));
        }
        catch {
            finish(null);
        }
    });
}
function checkReportDataBinding(reportDataHex, certDer) {
    try {
        const spki = new crypto_1.X509Certificate(certDer).publicKey.export({ type: 'spki', format: 'der' });
        const fingerprint = (0, crypto_1.createHash)('sha256').update(spki).digest('hex');
        return (reportDataHex.length === 128 &&
            reportDataHex.slice(0, 2) === '00' &&
            reportDataHex.slice(2, 66) === fingerprint &&
            /^0+$/.test(reportDataHex.slice(66)));
    }
    catch {
        return false;
    }
}
async function verifyEnclaveAttestation(ctx, baseUrl) {
    try {
        const reportResp = (await ctx.helpers.httpRequest({
            method: 'GET',
            url: `${baseUrl}/nilcc/api/v2/report`,
            json: true, timeout: 15000,
        }));
        const report = reportResp.report;
        const raw = Buffer.from(reportResp.raw_report, 'hex');
        const nilccVersion = reportResp.environment?.nilcc_version;
        if (raw.length < 0x4a0) {
            throw new Error(`attestation report too short (${raw.length} bytes, expected 1184)`);
        }
        const policy = raw.readBigUInt64LE(0x08);
        const debugAllowed = ((policy >> 19n) & 1n) === 1n;
        const tcb = {
            bootloader: raw[0x180],
            tee: raw[0x181],
            snp: raw[0x186],
            microcode: raw[0x187],
        };
        const chipIdHex = raw.subarray(0x1a0, 0x1e0).toString('hex');
        const reportVersion = raw.readUInt32LE(0x00);
        const family = reportVersion >= 3 ? raw[0x188] : report.cpuid_fam_id;
        const model = reportVersion >= 3 ? raw[0x189] : report.cpuid_mod_id;
        const processor = detectProcessor(family, model);
        if (!processor) {
            throw new Error(`unsupported processor (family 0x${family.toString(16)}, model 0x${model.toString(16)})`);
        }
        const pad2 = (n) => String(n).padStart(2, '0');
        if (!certChainCache[processor]) {
            const chainCacheName = `certchain_${processor}.pem`;
            const cachedChain = readCertCache(chainCacheName);
            let chain = cachedChain ? parseCertChain(cachedChain.toString('utf8')) : null;
            if (!chain) {
                const chainPem = (await ctx.helpers.httpRequest({
                    method: 'GET',
                    url: `https://${KDS_DOMAIN}/vcek/v1/${processor}/cert_chain`,
                    encoding: 'text',
                    timeout: 15000,
                }));
                chain = parseCertChain(chainPem);
                if (!chain)
                    throw new Error('AMD KDS returned an unparseable certificate chain');
                writeCertCache(chainCacheName, Buffer.from(chainPem, 'utf8'));
            }
            certChainCache[processor] = chain;
        }
        const { ark, ask } = certChainCache[processor];
        const vcekUrl = `https://${KDS_DOMAIN}/vcek/v1/${processor}/${chipIdHex}` +
            `?blSPL=${pad2(tcb.bootloader)}&teeSPL=${pad2(tcb.tee)}&snpSPL=${pad2(tcb.snp)}&ucodeSPL=${pad2(tcb.microcode)}`;
        if (!vcekCache[vcekUrl]) {
            const vcekCacheName = `vcek_${chipIdHex}_${tcb.bootloader}_${tcb.tee}_${tcb.snp}_${tcb.microcode}.der`;
            const cachedDer = readCertCache(vcekCacheName);
            let vcekCert = null;
            if (cachedDer) {
                try {
                    vcekCert = new crypto_1.X509Certificate(cachedDer);
                }
                catch {
                    vcekCert = null;
                }
            }
            if (!vcekCert) {
                const fetched = (await ctx.helpers.httpRequest({
                    method: 'GET',
                    url: vcekUrl,
                    encoding: 'arraybuffer',
                    timeout: 15000,
                }));
                const der = Buffer.from(fetched);
                vcekCert = new crypto_1.X509Certificate(der);
                writeCertCache(vcekCacheName, der);
            }
            vcekCache[vcekUrl] = vcekCert;
        }
        const vcek = vcekCache[vcekUrl];
        const arkSelfSigned = ark.verify(ark.publicKey);
        const askByArk = ask.verify(ark.publicKey);
        const vcekByAsk = vcek.verify(ask.publicKey);
        const sig = Buffer.concat([
            leToBe48(raw.subarray(0x2a0, 0x2e8)),
            leToBe48(raw.subarray(0x2e8, 0x330)),
        ]);
        const signedBytes = raw.subarray(0x0, 0x2a0);
        let sigValid = false;
        try {
            sigValid = (0, crypto_1.verify)('sha384', signedBytes, { key: vcek.publicKey, dsaEncoding: 'ieee-p1363' }, sig);
        }
        catch {
            sigValid = false;
        }
        const measurement = raw.subarray(0x90, 0x90 + 48).toString('hex');
        const known = nilccVersion ? KNOWN_MEASUREMENTS[nilccVersion] : undefined;
        const measurementMatches = known ? measurement === known : null;
        const reportData = raw.subarray(0x50, 0x50 + 64).toString('hex');
        const tcbOk = verifyTcbExtensions(vcek.raw, tcb, chipIdHex);
        const host = (() => {
            try {
                return new URL(baseUrl).hostname;
            }
            catch {
                return '';
            }
        })();
        const serverCertDer = host ? await getServerCertDer(host) : null;
        const tlsBound = serverCertDer ? checkReportDataBinding(reportData, serverCertDer) : false;
        const checks = {
            ark_self_signed: arkSelfSigned,
            ask_signed_by_ark: askByArk,
            vcek_signed_by_ask: vcekByAsk,
            report_signature_valid: sigValid,
            vcek_tcb_matches_report: tcbOk,
            tls_session_bound: tlsBound,
            debug_disabled: !debugAllowed,
        };
        const attestation_verified = Object.values(checks).every(Boolean) && measurementMatches !== false;
        return {
            attestation_verified,
            processor,
            nilcc_version: nilccVersion,
            measurement,
            measurement_matches_known_build: measurementMatches,
            report_data: reportData,
            checks,
        };
    }
    catch (e) {
        return { attestation_verified: false, error: e.message };
    }
}
