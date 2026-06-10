/**
 * Dependency-free JVM classfile parser.
 *
 * Two tiers:
 * - Metadata fast path (default): name, access flags, superclass, interfaces,
 *   and all fields/methods (name + descriptor + access + generic signature),
 *   plus cheap always-on extras: MethodParameters names, Record-attribute
 *   presence, PermittedSubclasses. Method bodies are skipped entirely.
 * - Code scan (opt-in via `scanCode`): additionally parses the structured
 *   Fieldref/Methodref/InterfaceMethodref/NameAndType constant-pool entries and
 *   walks every method's Code attribute, extracting the ordered member-reference
 *   instructions (invoke* / get* / put*) — the ground truth the Mixin Verifier
 *   needs for instruction-level `@At` INVOKE/FIELD verification.
 *
 * Format reference: JVMS §4 (The class File Format). Handles every constant-pool
 * tag defined through Java 25 classfiles (major version 69). Unknown CP tags and
 * unknown opcodes raise an explicit error with the offending offset rather than
 * guessing at their size (prime directive: a parser that silently desyncs
 * produces confidently-wrong data downstream).
 *
 * Verified against: real Minecraft 26.1.2 classfiles (major=69) and javac 17
 * output; the code scan verified by walking every method body in the 26.1.2
 * client jar without a single length-decode error.
 */
import type { ClassApi, CodeRef, MemberApi } from '../core/model.ts';

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

/** Options for {@link parseClassFile}. */
export interface ParseClassFileOptions {
  /**
   * Walk every method's Code attribute and populate `MemberApi.codeRefs`
   * (required for instruction-level mixin verification). Off by default —
   * the metadata fast path does no per-instruction work at all.
   */
  scanCode?: boolean;
}

/**
 * Total instruction lengths (opcode byte included) for fixed-size opcodes.
 * 0 = variable-length (tableswitch / lookupswitch / wide) — handled explicitly
 * by the walker — or not a defined opcode; a 0 reaching the walker's default
 * branch is a loud error, never a guessed skip.
 */
const OP_LEN: Uint8Array = (() => {
  const t = new Uint8Array(256);
  const fill = (from: number, to: number, len: number) => {
    for (let o = from; o <= to; o++) t[o] = len;
  };
  fill(0x00, 0x0f, 1); // nop .. dconst_1
  t[0x10] = 2; // bipush
  t[0x11] = 3; // sipush
  t[0x12] = 2; // ldc
  t[0x13] = 3; // ldc_w
  t[0x14] = 3; // ldc2_w
  fill(0x15, 0x19, 2); // iload .. aload (u1 local index)
  fill(0x1a, 0x35, 1); // iload_0 .. saload
  fill(0x36, 0x3a, 2); // istore .. astore (u1 local index)
  fill(0x3b, 0x83, 1); // istore_0 .. lxor
  t[0x84] = 3; // iinc
  fill(0x85, 0x98, 1); // i2l .. dcmpg
  fill(0x99, 0xa8, 3); // ifeq .. jsr (s2 branch offset)
  t[0xa9] = 2; // ret
  // 0xaa tableswitch, 0xab lookupswitch: variable (4-byte aligned) — in walker
  fill(0xac, 0xb1, 1); // ireturn .. return
  fill(0xb2, 0xb8, 3); // getstatic .. invokestatic (u2 cp index)
  t[0xb9] = 5; // invokeinterface (u2 cp, u1 count, u1 must-be-zero)
  t[0xba] = 5; // invokedynamic (u2 cp, two must-be-zero bytes)
  t[0xbb] = 3; // new
  t[0xbc] = 2; // newarray
  t[0xbd] = 3; // anewarray
  t[0xbe] = 1; // arraylength
  t[0xbf] = 1; // athrow
  t[0xc0] = 3; // checkcast
  t[0xc1] = 3; // instanceof
  t[0xc2] = 1; // monitorenter
  t[0xc3] = 1; // monitorexit
  // 0xc4 wide: variable (4 or 6 bytes) — in walker
  t[0xc5] = 4; // multianewarray
  t[0xc6] = 3; // ifnull
  t[0xc7] = 3; // ifnonnull
  t[0xc8] = 5; // goto_w
  t[0xc9] = 5; // jsr_w
  return t;
})();

// Member-reference opcodes → JVMS mnemonics (the instructions the Mixin
// Verifier checks `@At(INVOKE/FIELD)` targets against).
const MEMBER_OP = new Map<number, string>([
  [0xb2, 'getstatic'],
  [0xb3, 'putstatic'],
  [0xb4, 'getfield'],
  [0xb5, 'putfield'],
  [0xb6, 'invokevirtual'],
  [0xb7, 'invokespecial'],
  [0xb8, 'invokestatic'],
  [0xb9, 'invokeinterface'],
]);

/**
 * Parse one classfile into its API surface.
 *
 * With `opts.scanCode`, every method that has a Code attribute additionally
 * gets `codeRefs`: the ordered list of member-reference instructions resolved
 * through the constant pool. Without it, the metadata-only fast path performs
 * no constant-pool ref parsing and no bytecode walking.
 */
export function parseClassFile(buf: Buffer, opts: ParseClassFileOptions = {}): ClassApi {
  const scanCode = opts.scanCode === true;
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
  // Structured ref entries, parsed ONLY under scanCode (the fast path keeps
  // skipping them — allocation and reads gated to preserve its exact cost).
  // [class_index, name_and_type_index] / [name_index, descriptor_index].
  const cpRefs: ([number, number] | undefined)[] | null = scanCode ? new Array(cpCount) : null;
  const cpNats: ([number, number] | undefined)[] | null = scanCode ? new Array(cpCount) : null;
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
      case Tag.Fieldref:
      case Tag.Methodref:
      case Tag.InterfaceMethodref:
        if (cpRefs) cpRefs[i] = [buf.readUInt16BE(off), buf.readUInt16BE(off + 2)];
        off += 4;
        break;
      case Tag.NameAndType:
        if (cpNats) cpNats[i] = [buf.readUInt16BE(off), buf.readUInt16BE(off + 2)];
        off += 4;
        break;
      case Tag.Integer:
      case Tag.Float:
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

  // Resolve a Fieldref/Methodref/InterfaceMethodref cp entry to owner/name/desc.
  // Only reachable under scanCode (the only mode in which cpRefs/cpNats exist).
  const resolveMemberRef = (cpIdx: number, opName: string, pc: number, where: string): CodeRef => {
    if (!cpRefs || !cpNats) {
      throw new Error('classfile: internal: member-ref tables absent without scanCode');
    }
    const ref = cpRefs[cpIdx];
    if (ref === undefined) {
      throw new Error(
        `classfile: ${opName} at code offset ${pc} in ${where} references cp #${cpIdx}, ` +
          'which is not a Fieldref/Methodref/InterfaceMethodref',
      );
    }
    const [ownerClassIdx, natIdx] = ref;
    const nat = cpNats[natIdx];
    const owner = className(ownerClassIdx);
    if (nat === undefined || owner === null) {
      throw new Error(
        `classfile: unresolvable member ref cp #${cpIdx} (${opName} at code offset ${pc} in ${where})`,
      );
    }
    const [nameIdx, descIdx] = nat;
    const name = utf8[nameIdx];
    const desc = utf8[descIdx];
    if (name === undefined || desc === undefined) {
      throw new Error(
        `classfile: member ref cp #${cpIdx} has non-Utf8 name/descriptor (${opName} at code offset ${pc} in ${where})`,
      );
    }
    return { op: opName, owner, name, desc };
  };

  // Walk one Code attribute's instruction stream, emitting member refs in
  // stream order. Length decoding is exact: every opcode is either in OP_LEN,
  // handled as a documented variable-length form, or a loud error — the walker
  // never resynchronizes by guessing.
  const extractCodeRefs = (codeAttr: Buffer, where: string): CodeRef[] => {
    if (codeAttr.length < 8) {
      throw new Error(`classfile: truncated Code attribute (${codeAttr.length} bytes) in ${where}`);
    }
    // Layout: max_stack u2, max_locals u2, code_length u4, code[code_length], ...
    const codeLength = codeAttr.readUInt32BE(4);
    if (codeAttr.length < 8 + codeLength) {
      throw new Error(
        `classfile: Code attribute shorter than its code_length (${codeLength}) in ${where}`,
      );
    }
    const code = codeAttr.subarray(8, 8 + codeLength);
    const refs: CodeRef[] = [];
    let pc = 0;
    while (pc < codeLength) {
      const op = code.readUInt8(pc);
      const memberOp = MEMBER_OP.get(op);
      if (memberOp !== undefined) {
        const ilen = op === 0xb9 ? 5 : 3;
        if (pc + ilen > codeLength) {
          throw new Error(`classfile: truncated ${memberOp} at code offset ${pc} in ${where}`);
        }
        // invokeinterface: 4th operand byte must be zero (JVMS) — nonzero means desync.
        if (op === 0xb9 && code.readUInt8(pc + 4) !== 0) {
          throw new Error(
            `classfile: invokeinterface nonzero fourth operand byte at code offset ${pc} in ${where} — refusing to desync`,
          );
        }
        refs.push(resolveMemberRef(code.readUInt16BE(pc + 1), memberOp, pc, where));
        pc += ilen;
        continue;
      }
      if (op === 0xba) {
        // invokedynamic: deliberately NOT emitted (bootstrap-driven, no static
        // owner — see CodeRef docs). Both trailing bytes must be zero (JVMS).
        if (pc + 5 > codeLength) {
          throw new Error(`classfile: truncated invokedynamic at code offset ${pc} in ${where}`);
        }
        if (code.readUInt8(pc + 3) !== 0 || code.readUInt8(pc + 4) !== 0) {
          throw new Error(
            `classfile: invokedynamic nonzero operand padding at code offset ${pc} in ${where} — refusing to desync`,
          );
        }
        pc += 5;
        continue;
      }
      if (op === 0xaa || op === 0xab) {
        // tableswitch / lookupswitch: operands start at the next multiple of 4
        // from the START OF THE CODE ARRAY (JVMS) — (pc+4) & ~3 rounds pc+1 up.
        const base = (pc + 4) & ~3;
        const opName = op === 0xaa ? 'tableswitch' : 'lookupswitch';
        const headLen = op === 0xaa ? 12 : 8; // default+low+high / default+npairs
        if (base + headLen > codeLength) {
          throw new Error(`classfile: truncated ${opName} at code offset ${pc} in ${where}`);
        }
        if (op === 0xaa) {
          const low = code.readInt32BE(base + 4);
          const high = code.readInt32BE(base + 8);
          if (low > high) {
            throw new Error(`classfile: tableswitch low>high at code offset ${pc} in ${where}`);
          }
          pc = base + 12 + (high - low + 1) * 4;
        } else {
          const npairs = code.readInt32BE(base + 4);
          if (npairs < 0) {
            throw new Error(`classfile: lookupswitch negative npairs at code offset ${pc} in ${where}`);
          }
          pc = base + 8 + npairs * 8;
        }
        continue;
      }
      if (op === 0xc4) {
        // wide: <wide, iinc, u2 index, s2 const> = 6 bytes; <wide, *load/*store/ret, u2 index> = 4.
        if (pc + 2 > codeLength) {
          throw new Error(`classfile: truncated wide at code offset ${pc} in ${where}`);
        }
        const sub = code.readUInt8(pc + 1);
        if (sub === 0x84) {
          pc += 6;
        } else if ((sub >= 0x15 && sub <= 0x19) || (sub >= 0x36 && sub <= 0x3a) || sub === 0xa9) {
          pc += 4;
        } else {
          throw new Error(
            `classfile: invalid wide-modified opcode 0x${sub.toString(16).padStart(2, '0')} at code offset ${pc} in ${where}`,
          );
        }
        continue;
      }
      const len = OP_LEN[op] ?? 0;
      if (len === 0) {
        throw new Error(
          `classfile: unknown opcode 0x${op.toString(16).padStart(2, '0')} at code offset ${pc} in ${where} — refusing to desync`,
        );
      }
      pc += len;
    }
    if (pc !== codeLength) {
      throw new Error(
        `classfile: instruction stream overran code_length (pc=${pc}, code_length=${codeLength}) in ${where} — truncated final instruction`,
      );
    }
    return refs;
  };

  // MethodParameters: u1 count, then count × { u2 name_index, u2 access_flags }.
  // Positional alignment is preserved; '' marks an unnamed slot (name_index 0).
  const parseMethodParameters = (mp: Buffer, where: string): string[] => {
    if (mp.length < 1) {
      throw new Error(`classfile: empty MethodParameters attribute in ${where}`);
    }
    const n = mp.readUInt8(0);
    if (mp.length < 1 + n * 4) {
      throw new Error(`classfile: truncated MethodParameters attribute in ${where}`);
    }
    const names: string[] = [];
    for (let p = 0; p < n; p++) {
      const nameIdx = mp.readUInt16BE(1 + p * 4);
      if (nameIdx === 0) {
        names.push('');
        continue;
      }
      const s = utf8[nameIdx];
      if (s === undefined) {
        throw new Error(`classfile: MethodParameters name index ${nameIdx} not a Utf8 in ${where}`);
      }
      names.push(s);
    }
    return names;
  };

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
      // 'Code' is only retained under scanCode — the fast path skips bodies.
      if (
        attrName === 'Signature' ||
        attrName === 'MethodParameters' ||
        (scanCode && attrName === 'Code')
      ) {
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
    const mp = attrs.get('MethodParameters');
    if (mp) {
      member.paramNames = parseMethodParameters(mp, `${binaryName}.${name}${desc}`);
    }
    const codeAttr = attrs.get('Code');
    if (codeAttr) {
      member.codeRefs = extractCodeRefs(codeAttr, `${binaryName}.${name}${desc}`);
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

  // ---- class attributes (Signature, Record presence, PermittedSubclasses) ----
  let classSignature: string | undefined;
  let isRecord = false;
  let permittedSubclasses: string[] | undefined;
  const classAttrCount = buf.readUInt16BE(off);
  off += 2;
  for (let a = 0; a < classAttrCount; a++) {
    const attrNameIdx = buf.readUInt16BE(off);
    off += 2;
    const len = buf.readUInt32BE(off);
    off += 4;
    const attrName = utf8[attrNameIdx];
    if (attrName === 'Signature' && len >= 2) {
      const s = utf8[buf.readUInt16BE(off)];
      if (s !== undefined) classSignature = s;
    } else if (attrName === 'Record') {
      // Presence alone marks a record class; components mirror fields we already extract.
      isRecord = true;
    } else if (attrName === 'PermittedSubclasses') {
      if (len < 2) {
        throw new Error(`classfile: truncated PermittedSubclasses attribute in ${binaryName}`);
      }
      const n = buf.readUInt16BE(off);
      if (len < 2 + n * 2) {
        throw new Error(`classfile: PermittedSubclasses length mismatch in ${binaryName}`);
      }
      const names: string[] = [];
      for (let k = 0; k < n; k++) {
        const cn = className(buf.readUInt16BE(off + 2 + k * 2));
        if (!cn) {
          throw new Error(`classfile: PermittedSubclasses entry ${k} unresolvable in ${binaryName}`);
        }
        names.push(cn);
      }
      names.sort(); // determinism: semantically a set — stable output order
      permittedSubclasses = names;
    }
    off += len;
  }

  const api: ClassApi = { binaryName, access, majorVersion, superName, interfaces, methods, fields };
  if (classSignature !== undefined) api.signature = classSignature;
  if (isRecord) api.isRecord = true;
  if (permittedSubclasses !== undefined) api.permittedSubclasses = permittedSubclasses;
  return api;
}
