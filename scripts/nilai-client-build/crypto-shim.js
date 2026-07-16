import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { sha1 } from '@noble/hashes/legacy';
const algos = { sha256, sha512, sha1 };
export const randomUUID = () => globalThis.crypto.randomUUID();
export function createHash(name){
  const key = String(name).toLowerCase().replace('-','');
  const fn = algos[key] || sha256; const chunks=[];
  return { update(d){ chunks.push(typeof d==='string'? new TextEncoder().encode(d): d); return this; },
    digest(enc){ let len=0; chunks.forEach(c=>len+=c.length); const all=new Uint8Array(len); let o=0; chunks.forEach(c=>{all.set(c,o);o+=c.length;});
      const out=fn(all); if(enc==='hex') return Array.from(out).map(b=>b.toString(16).padStart(2,'0')).join(''); return out; } };
}
export default { randomUUID, createHash };
