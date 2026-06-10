/**
 * Dependency-free JVM classfile metadata parser.
 *
 * Extracts the API-relevant surface of a class: name, access flags, superclass,
 * interfaces, and all fields/methods (name + descriptor + access + generic
 * signature). Skips method bodies entirely — we only read metadata.
 *
 * Format reference: JVMS §4 (The class File Format). Handles every constant-pool
 * tag defined through Java 25 classfiles (major version 69). Unknown tags raise an
 * explicit error rather than guessing at their size (prime directive: a parser
 * that silently desyncs produces confidently-wrong data downstream).
 *
 * Verified against: real Minecraft 26.1.2 classfiles (major=69) and javac 17 output.
 */
import type { ClassApi, MemberApi } from '../core/model.ts';

// Constant pool tags (JVMS table 4.4-A, complete through Java 25).
const Tag = {
  Utf8: 1,
  Integer: 3,
  Float: 4,
  Long: 5,
  Double: 6,
  Class: 7,
  String: 8,
  Fieldref: 9,
  Methodref: 10,
  InterfaceMethodref: 11,
  NameAndType: 12,
  MethodHandle: 15,
  MethodType: 16,
  Dynamic: 17,
  InvokeDynamic: 18,
  Module: 19,
  Package: 20,
} as const;

export function parseClassFile(buf: Buffer): ClassApi {
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error('classfile: bad magic (not a classfile)');
  }
  const majorVersion = buf.readUInt16BE(6);

  // ---- constant pool ----
  let off = 8;
  const cpCount = buf.readUInt16BE(off);
  off += 2;
  const utf8: (string | undefined)[] = new Array(cpCount);
  const classNameIdx: (number | undefined)[] = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = buf.readUInt8(off);
    off += 1;
    switch (tag) {
      case Tag.Utf8: {
        const len = buf.readUInt16BE(off);
        off += 2;
        utf8[i] = buf.subarray(off, off + len).toString('utf8');
        off += len;
        break;
      }
      case Tag.Class:
        classNameIdx[i] = buf.readUInt16BE(off);
        off += 2;
        break;
      case Tag.String:
      case Tag.MethodType:
      case Tag.Module:
      case Tag.Package:
        off += 2;
        break;
      case Tag.MethodHandle:
        off += 3;
        break;
      case Tag.Integer:
      case Tag.Float:
      case Tag.Fieldref:
      case Tag.Methodref:
      case Tag.InterfaceMethodref:
      case Tag.NameAndType:
      case Tag.Dynamic:
      case Tag.InvokeDynamic:
        off += 4;
        break;
      case Tag.Long:
      case Tag.Double:
        off += 8;
        i++; // 8-byte constants occupy two constant-pool slots (JVMS 4.4.5)
        break;
      default:
        throw new Error(`classfile: unknown constant pool tag ${tag} at cp index ${i}`);
    }
  }

  const className = (idx: number): string | null => {
    const nameIdx = classNameIdx[idx];
    if (nameIdx === undefined) return null;
    return utf8[nameIdx] ?? null;
  };

  // ---- class header ----
  const access = buf.readUInt16BE(off);
  off += 2;
  const thisIdx = buf.readUInt16BE(off);
  off += 2;
  const superIdx = buf.readUInt16BE(off);
  off += 2;
  const binaryName = className(thisIdx);
  if (!binaryName) throw new Error('classfile: unresolvable this_class');
  const superName = superIdx === 0 ? null : className(superIdx);

  const ifCount = buf.readUInt16BE(off);
  off += 2;
  const interfaces: string[] = [];
  for (let i = 0; i < ifCount; i++) {
    const n = className(buf.readUInt16BE(off));
    if (n) interfaces.push(n);
    off += 2;
  }

  // ---- fields & methods ----
  const readMember = (): { member: MemberApi; attrs: Map<string, Buffer> } => {
    const macc = buf.readUInt16BE(off);
    off += 2;
    const nameIdx = buf.readUInt16BE(off);
    off += 2;
    const descIdx = buf.readUInt16BE(off);
    off += 2;
    const attrCount = buf.readUInt16BE(off);
    off += 2;
    const attrs = new Map<string, Buffer>();
    for (let a = 0; a < attrCount; a++) {
      const attrNameIdx = buf.readUInt16BE(off);
      off += 2;
      const len = buf.readUInt32BE(off);
      off += 4;
      const attrName = utf8[attrNameIdx];
      if (attrName === 'Signature') {
        attrs.set(attrName, buf.subarray(off, off + len));
      }
      off += len;
    }
    const name = utf8[nameIdx];
    const desc = utf8[descIdx];
    if (name === undefined || desc === undefined) {
      throw new Error('classfile: member with unresolvable name/descriptor');
    }
    const member: MemberApi = { name, desc, access: macc };
    const sig = attrs.get('Signature');
    if (sig && sig.length >= 2) {
      const sigStr = utf8[sig.readUInt16BE(0)];
      if (sigStr !== undefined) member.signature = sigStr;
    }
    return { member, attrs };
  };

  const fieldCount = buf.readUInt16BE(off);
  off += 2;
  const fields: MemberApi[] = [];
  for (let f = 0; f < fieldCount; f++) fields.push(readMember().member);

  const methodCount = buf.readUInt16BE(off);
  off += 2;
  const methods: MemberApi[] = [];
  for (let m = 0; m < methodCount; m++) methods.push(readMember().member);

  // ---- class attributes (only Signature matters for the API surface) ----
  let classSignature: string | undefined;
  const classAttrCount = buf.readUInt16BE(off);
  off += 2;
  for (let a = 0; a < classAttrCount; a++) {
    const attrNameIdx = buf.readUInt16BE(off);
    off += 2;
    const len = buf.readUInt32BE(off);
    off += 4;
    if (utf8[attrNameIdx] === 'Signature' && len >= 2) {
      const s = utf8[buf.readUInt16BE(off)];
      if (s !== undefined) classSignature = s;
    }
    off += len;
  }

  const api: ClassApi = { binaryName, access, majorVersion, superName, interfaces, methods, fields };
  if (classSignature !== undefined) api.signature = classSignature;
  return api;
}
