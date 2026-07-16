import { Buffer as _Buffer } from 'buffer';
export const Buffer = _Buffer;
export const process = { env: { NODE_ENV: 'production' }, browser: true, version: '', nextTick: (f) => Promise.resolve().then(f) };
