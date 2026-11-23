// Minimal CBOR decoder — enough for WebAuthn attestation objects and COSE keys.
// Copyright (c) 2026 Jerod Ulicki

export function decodeCbor(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;

  function readLength(info) {
    if (info < 24) return info;
    if (info === 24) { const v = view.getUint8(pos); pos += 1; return v; }
    if (info === 25) { const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) {
      const hi = view.getUint32(pos), lo = view.getUint32(pos + 4); pos += 8;
      return hi * 2 ** 32 + lo;
    }
    throw new Error('CBOR: indefinite lengths not supported');
  }

  function item() {
    const first = view.getUint8(pos); pos += 1;
    const major = first >> 5, info = first & 31;
    switch (major) {
      case 0: return readLength(info);
      case 1: return -1 - readLength(info);
      case 2: { const n = readLength(info); const b = buf.subarray(pos, pos + n); pos += n; return Buffer.from(b); }
      case 3: { const n = readLength(info); const s = buf.subarray(pos, pos + n).toString('utf8'); pos += n; return s; }
      case 4: { const n = readLength(info); const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: {
        const n = readLength(info); const m = new Map();
        for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); }
        return m;
      }
      case 6: readLength(info); return item(); // tag: ignore, return content
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { pos += 2; return 0; }
        if (info === 26) { const v = view.getFloat32(pos); pos += 4; return v; }
        if (info === 27) { const v = view.getFloat64(pos); pos += 8; return v; }
        throw new Error('CBOR: unsupported simple value');
      default: throw new Error('CBOR: bad major type');
    }
  }

  const value = item();
  return { value, length: pos };
}
