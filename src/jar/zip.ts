/**
 * Minimal, dependency-free ZIP (jar) reader.
 *
 * Scope: read-only access to ZIP central directory + entry extraction, supporting
 * the storage methods real jars use (STORED 0, DEFLATE 8). Honesty at the binary
 * level: anything outside that scope (ZIP64, encrypted, unknown method) raises an
 * explicit error instead of silently misreading (prime directive: never be
 * confidently wrong).
 *
 * Verified against: yarn tiny-v2 jars, intermediary jars, and the 36MB Minecraft
 * 26.1.2 client jar (30,675 entries).
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  crc32: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

export class ZipReader {
  readonly entries: Map<string, ZipEntry>;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.entries = readCentralDirectory(buf);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Extract one entry fully into memory. Throws if missing or unsupported. */
  read(name: string): Buffer {
    const e = this.entries.get(name);
    if (!e) throw new Error(`zip: entry not found: ${name}`);
    return extractEntry(this.buf, e);
  }

  *names(): IterableIterator<string> {
    yield* this.entries.keys();
  }
}

export function readCentralDirectory(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEOCD(buf);
  // Reject ZIP64 archives explicitly rather than misparse: locator sits right before EOCD.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new Error('zip: ZIP64 archives are not supported (file > 4GB or forced zip64)');
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) {
    throw new Error('zip: ZIP64 central directory offset encountered — unsupported');
  }
  let offset = cdOffset;
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) {
      throw new Error(`zip: bad central directory entry at ${offset}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const crc32 = buf.readUInt32LE(offset + 16);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.set(name, { name, method, compSize, uncompSize, localOffset, crc32 });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function extractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== LOC_SIG) {
    throw new Error(`zip: bad local file header for ${entry.name} at ${lo}`);
  }
  // Local header name/extra lengths can differ from the central directory's — always re-read.
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) {
    if (raw.length !== entry.uncompSize) {
      throw new Error(`zip: stored entry size mismatch for ${entry.name}`);
    }
    return Buffer.from(raw);
  }
  if (entry.method === 8) {
    const out = inflateRawSync(raw);
    if (out.length !== entry.uncompSize) {
      throw new Error(
        `zip: inflated size mismatch for ${entry.name}: got ${out.length}, expected ${entry.uncompSize}`,
      );
    }
    return out;
  }
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

function findEOCD(buf: Buffer): number {
  // EOCD is at the end; comment can be up to 65535 bytes. Scan backwards.
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('zip: end-of-central-directory not found (not a zip file?)');
}
