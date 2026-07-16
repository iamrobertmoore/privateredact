import { NilaiOpenAIClient, AuthType } from '@nillion/nilai-ts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
window.NilaiClient = { NilaiOpenAIClient, AuthType, secp256k1, sha256, ready: true };
