/**
 * A minimal CBOR reader for the WebAuthn wire format.
 *
 * WebAuthn hands the relying party two CBOR documents: the attestation object
 * (which carries the authenticator data) and the COSE public key inside it.
 * Both use the same small subset of RFC 8949, so a focused decoder is enough
 * and keeps the platform free of a native CBOR dependency.
 *
 * Decoding rules that matter for security:
 *   - byte strings become `Buffer`, never a UTF-8 string;
 *   - map keys keep their integer form, because COSE labels such as -1 and -2
 *     are negative integers and must not be confused with text labels;
 *   - every length is bounds-checked against the buffer, so a truncated or
 *     hostile document fails cleanly instead of reading past the end.
 */

export type CborValue = number | bigint | Buffer | string | boolean | null | undefined | CborValue[] | CborMap;

export class CborMap extends Map<number | string, CborValue> {
  /** Reads a COSE label that must be a small negative integer. */
  negative(key: number): CborValue | undefined {
    return this.get(-key);
  }
  /** Reads a COSE label that must be a positive integer. */
  positive(key: number): CborValue | undefined {
    return this.get(key);
  }
}

const MAX_DEPTH = 16;

/** Decodes an IEEE 754 half precision float, the only float CBOR uses in practice. */
function readFloat16(bytes: Buffer): number {
  const half = bytes.readUInt16BE(0);
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Decodes one CBOR value and returns it with the offset just past it. */
export function cborDecodeFirst(buffer: Buffer): { value: CborValue; offset: number } {
  const reader = new CborReader(buffer, 0);
  const value = reader.read(0);
  return { value, offset: reader.offset };
}

/** Decodes exactly one CBOR document, rejecting trailing bytes. */
export function cborDecode(buffer: Buffer): CborValue {
  const { value, offset } = cborDecodeFirst(buffer);
  if (offset !== buffer.length) throw new Error("Trailing bytes after the CBOR document");
  return value;
}

class CborReader {
  offset: number;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer, offset: number) {
    this.buffer = buffer;
    this.offset = offset;
  }

  private take(count: number): Buffer {
    if (count < 0 || this.offset + count > this.buffer.length) throw new Error("Truncated CBOR document");
    const slice = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  private readLength(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) return this.take(1).readUInt8(0);
    if (additional === 25) return this.take(2).readUInt16BE(0);
    if (additional === 26) return this.take(4).readUInt32BE(0);
    if (additional === 27) {
      const big = this.take(8).readBigUInt64BE(0);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR integer is out of range");
      return Number(big);
    }
    throw new Error("Unsupported CBOR length");
  }

  read(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new Error("CBOR document is nested too deeply");
    const initial = this.take(1)[0];
    const major = initial >> 5;
    const additional = initial & 0x1f;

    switch (major) {
      case 0:
        return this.readLength(additional);
      case 1: {
        const value = this.readLength(additional);
        if (value > Number.MAX_SAFE_INTEGER) throw new Error("CBOR integer is out of range");
        return -1 - value;
      }
      case 2: {
        const length = this.readLength(additional);
        return Buffer.from(this.take(length));
      }
      case 3: {
        const length = this.readLength(additional);
        return this.take(length).toString("utf8");
      }
      case 4: {
        const length = this.readLength(additional);
        const items: CborValue[] = [];
        for (let index = 0; index < length; index += 1) items.push(this.read(depth + 1));
        return items;
      }
      case 5: {
        const length = this.readLength(additional);
        const map = new CborMap();
        for (let index = 0; index < length; index += 1) {
          const key = this.read(depth + 1);
          const value = this.read(depth + 1);
          if (typeof key !== "number" && typeof key !== "string") throw new Error("Unsupported CBOR map key");
          map.set(key, value);
        }
        return map;
      }
      case 6: {
        // A tagged value carries the tag number then the tagged item.
        this.readLength(additional);
        return this.read(depth + 1);
      }
      case 7: {
        if (additional === 20) return false;
        if (additional === 21) return true;
        if (additional === 22) return null;
        if (additional === 23) return undefined;
        if (additional === 25) return readFloat16(this.take(2));
        if (additional === 26) return this.take(4).readFloatBE(0);
        if (additional === 27) return this.take(8).readDoubleBE(0);
        throw new Error("Unsupported CBOR simple value");
      }
      default:
        throw new Error("Unsupported CBOR major type");
    }
  }
}
