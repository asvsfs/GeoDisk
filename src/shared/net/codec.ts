/**
 * @fileoverview Little-endian binary writer and reader.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Growable byte writer. */
export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  private pos = 0;

  constructor(capacity = 256) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  u8(v: number): this {
    this.need(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }

  u16(v: number): this {
    this.need(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  i16(v: number): this {
    this.need(2);
    this.view.setInt16(
      this.pos,
      Math.max(-32768, Math.min(32767, Math.round(v))),
      true,
    );
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.need(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  f32(v: number): this {
    this.need(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f64(v: number): this {
    this.need(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  /** UTF-8 string with a u8 byte-length prefix (truncated to 255 bytes). */
  str(v: string): this {
    let b = encoder.encode(v);
    if (b.length > 255) b = b.subarray(0, 255);
    this.u8(b.length);
    this.need(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  /** UTF-8 string with a u32 byte-length prefix, for long text such as JSON. */
  text(v: string): this {
    const b = encoder.encode(v);
    this.u32(b.length);
    this.need(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  /** Returns a view of the written bytes. */
  done(): Uint8Array {
    return this.bytes.subarray(0, this.pos);
  }

  private need(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }
}

/** Raised when a message is truncated or malformed. */
export class DecodeError extends Error {}

/** Bounds-checked byte reader. */
export class Reader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos;
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  str(): string {
    const n = this.u8();
    this.need(n);
    const s = decoder.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  text(): string {
    const n = this.u32();
    this.need(n);
    const s = decoder.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.byteLength)
      throw new DecodeError('truncated message');
  }
}
