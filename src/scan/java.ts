/**
 * Java source scanner — finds every Minecraft-symbol reference in a mod's source
 * tree, honestly classified (ARCHITECTURE §2 `src/scan/java.ts`).
 *
 * This is a pragmatic LEXER + lightweight structural extraction, NOT a parser:
 * strings/chars/text-blocks/comments are tokenized correctly (their content can
 * never leak into findings), and a single forward pass extracts references with
 * per-finding honesty labels. The honesty contract for the lexical limitation:
 *
 *  - every finding's `kind` states exactly HOW the reference was resolved;
 *  - `className` is only ever set when the binary name is DERIVABLE (explicit
 *    import, java.lang implicit, or a written fully-qualified name) — never
 *    inferred from flow, hierarchy, or wildcard imports;
 *  - simple names that cannot be resolved are kind `unknown-simple-name`;
 *    member accesses whose receiver type cannot be resolved are kind
 *    `member-unresolved-receiver` (the engine treats both as "needs
 *    verification" — honesty over coverage, never a guessed owner);
 *  - lexical heuristics that COULD be wrong always attach a `note` saying so
 *    (inner-class `$` placement, class-vs-constant segment splits, …).
 *
 * Feeding the bridge (the contract consumers rely on): every finding whose
 * `className` is owned by the old version's mapping surface becomes a
 * Resolution query —
 *  - class kinds (`import`/`extends`/`implements`/`type-use`/`new`/
 *    `class-literal`/`annotation-use`/`fqn-reference`) → `resolveClass`;
 *  - `member-static`/`member-instance`/`import-static` → `resolveMember`
 *    (kind from `memberKind`; source descriptors are NOT lexically derivable —
 *    `argCount` supports overload-arity ranking only);
 *  - `member-unresolved-receiver`/`unknown-simple-name` → the needs-verification
 *    pile; `JavaScanResult.imports` wildcards carry the candidate packages.
 *
 * Known, deliberately-encoded limitations (all degrade to honest kinds/notes,
 * never to a wrong `className`):
 *  - no flow analysis: variable types come from declarations seen in the same
 *    file, one flat map per file; redeclared names with differing types make the
 *    receiver unresolvable (noted) rather than picking one;
 *  - `var`/lambda-inferred/multi-catch variables have no lexical type → member
 *    accesses through them are `member-unresolved-receiver`;
 *  - unicode escapes outside literals (`Aclass`) are not pre-processed;
 *  - annotations inside generic argument lists (`List<@Nullable Foo>`) are
 *    skipped (the type itself is still emitted);
 *  - unqualified enum constants in `case` labels (typed by the selector) and
 *    multi-declarator statements (`Foo a = x, b = y;` records only `a`) are
 *    not modeled.
 *
 * Determinism: outputs are stably sorted; no clock, no randomness. The lexer
 * fails loudly (offset + line/col + reason) on malformed input — a desynced
 * scan must never produce silently-wrong findings.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toBinaryName } from '../core/model.ts';

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** How a reference was found AND how far resolution honestly got. */
export type JavaRefKind =
  | 'import' // import a.b.C;
  | 'import-static' // import static a.b.C.member;
  | 'import-wildcard' // import a.b.*;  (flagged: brings unknowable names into scope)
  | 'import-static-wildcard' // import static a.b.C.*;
  | 'fqn-reference' // fully-qualified name written in code, no member access
  | 'extends'
  | 'implements'
  | 'type-use' // declared types, generics arguments, casts, instanceof, throws, …
  | 'annotation-use' // @X
  | 'new' // new X( / X::new / new X[]
  | 'class-literal' // X.class
  | 'member-static' // Type.member where Type resolved via imports/java.lang/FQN
  | 'member-instance' // var.member where var's declared type was captured in-file
  | 'member-unresolved-receiver' // .member whose receiver type is not lexically resolvable
  | 'unknown-simple-name'; // a simple name with no import/java.lang/FQN resolution

/** One Minecraft-symbol-relevant reference found in a source file. */
export interface JavaFinding {
  /** Normalized (forward-slash) path as given to the scanner. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  col: number;
  kind: JavaRefKind;
  /**
   * Binary class name (slashes, `$` for nesting) when DERIVABLE from this
   * file's imports, java.lang implicits, or a written FQN. Absent for the
   * honest kinds (`unknown-simple-name`, `member-unresolved-receiver`,
   * `import-wildcard`) — absence means "not derivable", never "empty".
   */
  className?: string;
  /** The reference text as written in source (type/receiver/import text). */
  rawName: string;
  /** Member name for member/static-import kinds. */
  memberName?: string;
  /** `method` for calls/method-references, `field` for bare member accesses. */
  memberKind?: 'method' | 'field';
  /**
   * Count of top-level arguments at the callsite, when lexically countable
   * (balanced delimiters; generics skipped) — for overload arity matching.
   */
  argCount?: number;
  /** Honest qualification of any heuristic applied, or why resolution failed. */
  note?: string;
}

/** One structured import statement. */
export interface JavaImport {
  kind: 'class' | 'static-member' | 'wildcard' | 'static-wildcard';
  line: number;
  /** Dotted text as written (without `import`/`static`/`;`). */
  raw: string;
  /** Binary class name (all kinds except `wildcard`). */
  className?: string;
  /** Dotted package for `wildcard` imports. */
  packageName?: string;
  /** Imported member for `static-member`. */
  memberName?: string;
  note?: string;
}

/** Everything extracted from one compilation unit. */
export interface JavaScanResult {
  /** Normalized (forward-slash) path as given to the scanner. */
  file: string;
  /** Dotted package name, `''` for the default package. */
  packageName: string;
  imports: JavaImport[];
  /** Stably sorted: (line, col, kind, rawName, memberName, className). */
  findings: JavaFinding[];
  /** Simple names of types declared in this file (mod-local), sorted. */
  declaredTypes: string[];
}

/** Aggregated scan of a source tree. */
export interface JavaTreeScan {
  /** Per-file results, sorted by file path. */
  files: JavaScanResult[];
  /** All findings flattened in file order (each already file-tagged). */
  findings: JavaFinding[];
  /** Files that failed to lex/scan — loud, never silently skipped. */
  errors: { file: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** Reserved words only — contextual keywords (var/record/permits/sealed/yield) lex as idents. */
const KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', '_',
]);

const PRIMITIVES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void']);

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native',
  'strictfp', 'default', 'transient', 'volatile',
]);

/**
 * java.lang implicits (curated, Java 21 era). A miss here only yields an honest
 * `unknown-simple-name` — never a wrong className — and java.lang types are
 * never Minecraft classes, so bridge correctness is unaffected either way.
 */
const JAVA_LANG = new Set([
  'AbstractMethodError', 'Appendable', 'ArithmeticException', 'ArrayIndexOutOfBoundsException',
  'ArrayStoreException', 'AssertionError', 'AutoCloseable', 'Boolean', 'BootstrapMethodError',
  'Byte', 'CharSequence', 'Character', 'Class', 'ClassCastException', 'ClassLoader',
  'ClassNotFoundException', 'CloneNotSupportedException', 'Cloneable', 'Comparable', 'Deprecated',
  'Double', 'Enum', 'Error', 'Exception', 'ExceptionInInitializerError', 'Float',
  'FunctionalInterface', 'IllegalAccessError', 'IllegalAccessException', 'IllegalArgumentException',
  'IllegalCallerException', 'IllegalMonitorStateException', 'IllegalStateException',
  'IllegalThreadStateException', 'IncompatibleClassChangeError', 'IndexOutOfBoundsException',
  'InheritableThreadLocal', 'InstantiationError', 'InstantiationException', 'Integer',
  'InternalError', 'InterruptedException', 'Iterable', 'LinkageError', 'Long', 'Math', 'Module',
  'ModuleLayer', 'NegativeArraySizeException', 'NoClassDefFoundError', 'NoSuchFieldError',
  'NoSuchFieldException', 'NoSuchMethodError', 'NoSuchMethodException', 'NullPointerException',
  'Number', 'NumberFormatException', 'Object', 'OutOfMemoryError', 'Override', 'Package', 'Process',
  'ProcessBuilder', 'ProcessHandle', 'Readable', 'Record', 'ReflectiveOperationException',
  'Runnable', 'Runtime', 'RuntimeException', 'SafeVarargs', 'SecurityException', 'SecurityManager',
  'Short', 'StackOverflowError', 'StackTraceElement', 'StackWalker', 'StrictMath', 'String',
  'StringBuffer', 'StringBuilder', 'StringIndexOutOfBoundsException', 'SuppressWarnings', 'System',
  'Thread', 'ThreadDeath', 'ThreadGroup', 'ThreadLocal', 'Throwable', 'TypeNotPresentException',
  'UnknownError', 'UnsatisfiedLinkError', 'UnsupportedClassVersionError',
  'UnsupportedOperationException', 'VerifyError', 'VirtualMachineError', 'Void',
]);

interface Tok {
  kind: 'ident' | 'kw' | 'punct' | 'str' | 'char' | 'num';
  /** Source text for ident/kw/punct; literal tokens carry their delimiter only. */
  text: string;
  /** Byte offset of the token start in the original text. */
  off: number;
}

const IDENT_START = /[\p{L}\p{Nl}$_]/u;
const IDENT_PART = /[\p{L}\p{Nl}\p{Nd}$_]/u;

/**
 * Multi-char operators we MUST keep whole so expression shapes are not misread
 * as generics (`&&`, `||`) or so structural markers survive (`->`, `::`, `...`).
 * Operators starting with `<`/`>` are deliberately NOT combined: generic
 * argument lists then always close with single `>` tokens, which keeps the
 * speculative generics scan exact (`Map<K,List<V>>=` can never steal a close).
 */
const MULTI_PUNCT = ['...', '->', '::', '==', '!=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], off: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Tokenize Java source. Comments are dropped; string/char/text-block content is
 * consumed but never surfaced (a literal can never produce a finding). Throws
 * with offset + line:col + reason on malformed input — fail loudly, never desync.
 */
function lexJava(text: string, fileName: string): Tok[] {
  const toks: Tok[] = [];
  const n = text.length;
  const starts = buildLineStarts(text);
  const fail = (off: number, reason: string): never => {
    const line = lineOf(starts, off);
    const col = off - (starts[line - 1] as number) + 1;
    throw new Error(`java-scan: ${fileName}: ${reason} at offset ${off} (line ${line}:${col})`);
  };

  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f') {
      i++;
      continue;
    }
    // comments
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= n) fail(start, 'unterminated block comment');
      i += 2;
      continue;
    }
    // text block
    if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      const start = i;
      i += 3;
      for (;;) {
        if (i >= n) fail(start, 'unterminated text block');
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
          i += 3;
          break;
        }
        i++;
      }
      toks.push({ kind: 'str', text: '"""', off: start });
      continue;
    }
    // string / char literal (single-line in Java)
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      for (;;) {
        if (i >= n || text[i] === '\n') fail(start, `unterminated ${c === '"' ? 'string' : 'char'} literal`);
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          i++;
          break;
        }
        i++;
      }
      toks.push({ kind: c === '"' ? 'str' : 'char', text: c, off: start });
      continue;
    }
    // number (also `.5` — must not become a '.' punct)
    if ((c >= '0' && c <= '9') || (c === '.' && (text[i + 1] as string) >= '0' && (text[i + 1] as string) <= '9')) {
      const start = i;
      // integer/hex/binary part + underscores
      while (i < n && /[0-9a-fA-F_xXbB]/.test(text[i] as string)) i++;
      // fraction (only when followed by a digit or an exponent/suffix — `1.foo` is not Java)
      if (text[i] === '.' && /[0-9eEfFdD]/.test(text[i + 1] ?? '')) {
        i++;
        while (i < n && /[0-9_]/.test(text[i] as string)) i++;
      }
      // exponent
      if (/[eEpP]/.test(text[i] ?? '') && /[0-9+-]/.test(text[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[0-9_]/.test(text[i] as string)) i++;
      }
      // suffix
      if (/[lLfFdD]/.test(text[i] ?? '')) i++;
      toks.push({ kind: 'num', text: text.slice(start, i), off: start });
      continue;
    }
    // identifier / keyword
    if (IDENT_START.test(c)) {
      const start = i;
      i++;
      while (i < n && IDENT_PART.test(text[i] as string)) i++;
      const t = text.slice(start, i);
      toks.push({ kind: KEYWORDS.has(t) ? 'kw' : 'ident', text: t, off: start });
      continue;
    }
    // multi-char punct
    let matched = false;
    for (const p of MULTI_PUNCT) {
      if (text.startsWith(p, i)) {
        toks.push({ kind: 'punct', text: p, off: i });
        i += p.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // single-char punct (anything else — unknown chars surface as themselves)
    toks.push({ kind: 'punct', text: c, off: i });
    i++;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Name resolution (imports + java.lang implicits — never guesses)
// ---------------------------------------------------------------------------

type NameResolution =
  | { kind: 'resolved'; className: string; note?: string }
  | { kind: 'type-variable' }
  | { kind: 'file-local'; note: string }
  | { kind: 'unknown'; note: string };

const isClassLikeSeg = (s: string): boolean => /^[A-Z]/.test(s) && /[a-z]/.test(s);
const isUpperStart = (s: string): boolean => /^[A-Z]/.test(s);

/**
 * Dotted FQN → binary name. `$` placement is not lexically decidable in Java
 * (`a.b.Outer.Inner` is identical to a package chain), so the Java NAMING
 * CONVENTION is applied — packages lowercase, classes capitalized — and a note
 * is attached whenever the heuristic actually fired (nested segments present).
 * Minecraft's own namespace follows the convention, so this is exact for MC.
 */
function fqnToBinary(dotted: string): { binary: string; note?: string } {
  const segs = dotted.split('.');
  let split = segs.findIndex(isUpperStart);
  if (split === -1) split = segs.length - 1; // all-lowercase FQN: best-effort last segment
  const pkg = segs.slice(0, split);
  const cls = segs.slice(split);
  const binary = (pkg.length > 0 ? pkg.join('/') + '/' : '') + cls.join('$');
  if (cls.length > 1) {
    return { binary, note: `nested-class '$' placement assumed by naming convention (${dotted} → ${binary})` };
  }
  return { binary };
}

// ---------------------------------------------------------------------------
// Speculative scanners (pure lookahead — never consume, never emit)
// ---------------------------------------------------------------------------

interface GenericsParse {
  /** Token index just after the closing `>`. */
  end: number;
  /** Dotted type chains inside the list (annotation names excluded). */
  chains: { text: string; off: number }[];
}

/**
 * Try to read a generic ARGUMENT list starting at `<`. Strictly type-shaped
 * tokens only (idents, `.` `,` `?` `[` `]` `<` `>` `@` and extends/super/
 * primitive keywords); anything else — operators, literals, parens — rejects
 * the parse so comparisons (`a < b`) are never misread as generics. `&` is
 * rejected too: intersection types occur only in casts/bounds, both handled
 * elsewhere, and allowing it would misread `x = a < b & c > d`.
 */
function tryParseGenerics(toks: Tok[], open: number): GenericsParse | null {
  const t0 = toks[open];
  if (!t0 || t0.text !== '<') return null;
  const chains: { text: string; off: number }[] = [];
  let depth = 1;
  let i = open + 1;
  let cur: { text: string; off: number } | null = null;
  let afterAt = false;
  const endChain = (): void => {
    if (cur) chains.push(cur);
    cur = null;
  };
  while (i < toks.length) {
    const t = toks[i] as Tok;
    if (t.kind === 'ident' || (t.kind === 'kw' && PRIMITIVES.has(t.text))) {
      if (afterAt) {
        afterAt = false; // type annotation name — skipped (documented limitation)
      } else if (t.kind === 'kw') {
        endChain(); // primitive (array component) — no class ref
      } else if (cur && toks[i - 1]?.text === '.') {
        cur = { text: cur.text + '.' + t.text, off: cur.off };
      } else {
        endChain();
        cur = { text: t.text, off: t.off };
      }
      i++;
      continue;
    }
    if (t.kind === 'kw' && (t.text === 'extends' || t.text === 'super')) {
      endChain();
      i++;
      continue;
    }
    if (t.kind !== 'punct') return null;
    switch (t.text) {
      case '<':
        depth++;
        endChain();
        break;
      case '>':
        depth--;
        endChain();
        if (depth === 0) return { end: i + 1, chains };
        break;
      case ',':
      case '?':
      case '[':
      case ']':
        endChain();
        break;
      case '.':
        if (!cur) return null; // leading dot — not a type shape
        break;
      case '@':
        afterAt = true;
        endChain();
        break;
      default:
        return null;
    }
    i++;
  }
  return null; // ran off the file — not generics
}

/**
 * Count top-level arguments of a call whose `(` is at `open`. Pure lookahead.
 * Generic argument lists inside (e.g. `new HashMap<String, Integer>()`) are
 * skipped via {@link tryParseGenerics} so their commas never miscount.
 * Returns null when the args are not lexically countable (unbalanced at EOF).
 */
function countCallArgs(toks: Tok[], open: number): number | null {
  let depth = 0;
  let commas = 0;
  let any = false;
  let i = open;
  while (i < toks.length) {
    const t = toks[i] as Tok;
    if (t.kind === 'punct') {
      if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
      else if (t.text === ')' || t.text === ']' || t.text === '}') {
        depth--;
        if (depth === 0) return any ? commas + 1 : 0;
      } else if (t.text === ',' && depth === 1) {
        commas++;
      } else if (t.text === '<' && depth >= 1 && toks[i - 1]?.kind === 'ident') {
        const g = tryParseGenerics(toks, i);
        if (g) {
          any = true;
          i = g.end;
          continue;
        }
      }
      if (depth === 1 && t.text !== '(' && t.text !== ')') any = true;
    } else {
      if (depth >= 1) any = true;
    }
    i++;
  }
  return null;
}

/** Declaration terminators: what may legally follow `Type name` in a declaration. */
const DECL_TERMS = new Set(['=', ';', ',', ')', ':', '->']);

// ---------------------------------------------------------------------------
// Per-file scanner
// ---------------------------------------------------------------------------

type ParenKind = 'call' | 'control' | 'for' | 'try' | 'params' | 'expr';

interface VarDecl {
  written: string;
  res: NameResolution;
}

class FileScanner {
  private readonly toks: Tok[];
  private readonly lineStarts: number[];
  private readonly file: string;
  private pkg = '';
  /** simple name → dotted FQN (explicit class imports). */
  private readonly imports = new Map<string, string>();
  /** member name → dotted owner FQN (explicit static imports). */
  private readonly staticImports = new Map<string, string>();
  private readonly wildcardPkgs: string[] = [];
  private readonly staticWildcardOwners: string[] = [];
  private readonly importList: JavaImport[] = [];
  /** Type-parameter names declared in this file (flat — see module doc). */
  private readonly typeParams = new Set<string>();
  /** Type names declared in this file (mod-local). */
  private readonly localTypes = new Set<string>();
  /** Method names declared in this file (suppresses own-method call noise). */
  private readonly localMethods = new Set<string>();
  /** var name → declared type; 'conflict' when redeclared with differing types. */
  private readonly varTypes = new Map<string, VarDecl | 'conflict'>();
  private readonly findings: JavaFinding[] = [];
  private readonly parens: ParenKind[] = [];
  private nextParen: ParenKind | null = null;

  constructor(text: string, file: string) {
    this.file = file;
    this.toks = lexJava(text, file);
    this.lineStarts = buildLineStarts(text);
  }

  private at(i: number): Tok | undefined {
    return this.toks[i];
  }

  private emit(kind: JavaRefKind, off: number, rawName: string, extra: {
    className?: string;
    memberName?: string;
    memberKind?: 'method' | 'field';
    argCount?: number;
    note?: string;
  } = {}): void {
    const line = lineOf(this.lineStarts, off);
    const col = off - (this.lineStarts[line - 1] as number) + 1;
    const f: JavaFinding = { file: this.file, line, col, kind, rawName };
    if (extra.className !== undefined) f.className = extra.className;
    if (extra.memberName !== undefined) f.memberName = extra.memberName;
    if (extra.memberKind !== undefined) f.memberKind = extra.memberKind;
    if (extra.argCount !== undefined) f.argCount = extra.argCount;
    if (extra.note !== undefined && extra.note !== '') f.note = extra.note;
    this.findings.push(f);
  }

  /**
   * Resolve a TYPE name as written (simple or dotted). Order for simple names:
   * type parameters (shadow everything in their scope — flat per file),
   * explicit imports, java.lang implicits, file-declared types, honest unknown.
   */
  private resolveTypeName(written: string): NameResolution {
    if (!written.includes('.')) {
      if (this.typeParams.has(written)) return { kind: 'type-variable' };
      const imp = this.imports.get(written);
      if (imp !== undefined) {
        const { binary, note } = fqnToBinary(imp);
        return note !== undefined ? { kind: 'resolved', className: binary, note } : { kind: 'resolved', className: binary };
      }
      if (JAVA_LANG.has(written)) return { kind: 'resolved', className: 'java/lang/' + written };
      if (this.localTypes.has(written)) {
        return { kind: 'file-local', note: `'${written}' is declared in this compilation unit (mod-local)` };
      }
      return {
        kind: 'unknown',
        note:
          this.wildcardPkgs.length > 0
            ? `'${written}' not explicitly imported — package-local, or via wildcard import(s) ${this.wildcardPkgs.map((w) => w + '.*').join(', ')}`
            : `'${written}' not explicitly imported — package-local or otherwise out of lexical scope`,
      };
    }
    // dotted: first segment imported → nesting IS decidable via the import
    const first = written.slice(0, written.indexOf('.'));
    const outer = this.imports.get(first);
    if (outer !== undefined) {
      const o = fqnToBinary(outer);
      const binary = o.binary + '$' + written.split('.').slice(1).join('$');
      const note = o.note !== undefined ? o.note : `nested class resolved via import of '${first}'`;
      return { kind: 'resolved', className: binary, note };
    }
    if (isUpperStart(first)) {
      if (this.localTypes.has(first)) {
        return { kind: 'file-local', note: `'${written}' is nested in file-declared type '${first}' (mod-local)` };
      }
      return { kind: 'unknown', note: `qualifier '${first}' of '${written}' is not resolvable from imports` };
    }
    // package-qualified FQN
    if (!written.split('.').some(isUpperStart)) {
      return { kind: 'unknown', note: `'${written}' has no capitalized segment — package reference or non-conventional name` };
    }
    const { binary, note } = fqnToBinary(written);
    return note !== undefined ? { kind: 'resolved', className: binary, note } : { kind: 'resolved', className: binary };
  }

  /**
   * Emit one type reference under the honesty mapping: resolved → `kind` with
   * className; type variable → suppressed (not a class reference at all);
   * file-local/unknown → `unknown-simple-name` with the precise reason.
   */
  private emitTypeRef(kind: JavaRefKind, written: string, off: number, ctxNote?: string): void {
    const r = this.resolveTypeName(written);
    if (r.kind === 'type-variable') return;
    const joinNotes = (a?: string, b?: string): string | undefined =>
      a !== undefined && b !== undefined ? `${a}; ${b}` : a ?? b;
    if (r.kind === 'resolved') {
      const extra: { className: string; note?: string } = { className: r.className };
      const note = joinNotes(ctxNote, r.note);
      if (note !== undefined) extra.note = note;
      this.emit(kind, off, written, extra);
      return;
    }
    const note = joinNotes(ctxNote, r.note);
    this.emit('unknown-simple-name', off, written, note !== undefined ? { note } : {});
  }

  // -------------------------------------------------------------------------
  // Main driver
  // -------------------------------------------------------------------------

  /** Resolved binary name of this file's superclass, for `super.` accesses. */
  private superClassName: string | null = null;

  scan(): JavaScanResult {
    const toks = this.toks;
    // Pass 0: collect file-declared type names + type parameters + method names
    // first, so forward references inside the file resolve honestly.
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.kind === 'kw' && (t.text === 'class' || t.text === 'interface' || t.text === 'enum' || t.text === 'record')) {
        const name = this.at(i + 1);
        if (name && name.kind === 'ident') {
          this.localTypes.add(name.text);
          const lt = this.at(i + 2);
          if (lt && lt.text === '<') {
            // type PARAMETER list: collect bare idents at depth 1 before extends/super bounds
            let depth = 1;
            let j = i + 3;
            let expectName = true;
            while (j < toks.length && depth > 0) {
              const tj = toks[j]!;
              if (tj.text === '<') depth++;
              else if (tj.text === '>') depth--;
              else if (depth === 1 && tj.text === ',') expectName = true;
              else if (depth === 1 && expectName && tj.kind === 'ident') {
                this.typeParams.add(tj.text);
                expectName = false;
              } else if (depth === 1 && tj.kind === 'kw' && (tj.text === 'extends' || tj.text === 'super')) {
                expectName = false;
              }
              j++;
            }
          }
        }
      }
      // method declarations: ident '(' where the PREVIOUS significant token is
      // type-shaped (ident / '>' / ']') and not '.', 'new', or a call chain.
      if (t.kind === 'ident' && this.at(i + 1)?.text === '(') {
        const prev = this.at(i - 1);
        if (prev && prev.text !== '.' && prev.text !== 'new' && (prev.kind === 'ident' || prev.text === '>' || prev.text === ']')) {
          this.localMethods.add(t.text);
        }
      }
    }

    // Pass 1: the real walk.
    let i = 0;
    while (i < toks.length) {
      const t = toks[i]!;

      // ---- package ----
      if (t.kind === 'kw' && t.text === 'package') {
        const { chain, end } = this.readDottedChain(i + 1);
        this.pkg = chain;
        i = end;
        continue;
      }

      // ---- imports ----
      if (t.kind === 'kw' && t.text === 'import') {
        i = this.handleImport(i);
        continue;
      }

      // ---- type declaration headers: extends / implements ----
      if (t.kind === 'kw' && (t.text === 'class' || t.text === 'interface' || t.text === 'enum' || t.text === 'record')) {
        i = this.handleTypeHeader(i);
        continue;
      }

      // ---- annotations ----
      if (t.text === '@') {
        const next = this.at(i + 1);
        if (next && next.kind === 'kw' && next.text === 'interface') {
          i += 2; // @interface declaration, not a use
          continue;
        }
        if (next && next.kind === 'ident') {
          const { chain, end } = this.readDottedChain(i + 1);
          this.emitTypeRef('annotation-use', chain, next.off);
          i = end;
          continue;
        }
      }

      // ---- new X( / new a.b.X( / new X[ ----
      if (t.kind === 'kw' && t.text === 'new') {
        const next = this.at(i + 1);
        if (next && next.kind === 'ident') {
          const { chain, end } = this.readDottedChain(i + 1);
          this.emitTypeRef('new', chain, next.off);
          i = end;
          continue;
        }
      }

      // ---- instanceof Chain ----
      if (t.kind === 'kw' && t.text === 'instanceof') {
        const next = this.at(i + 1);
        if (next && next.kind === 'ident') {
          const { chain, end } = this.readDottedChain(i + 1);
          this.emitTypeRef('type-use', chain, next.off, 'instanceof');
          i = end;
          continue;
        }
      }

      // ---- throws A, B ----
      if (t.kind === 'kw' && t.text === 'throws') {
        let j = i + 1;
        while (j < toks.length) {
          const tj = this.at(j);
          if (!tj || tj.kind !== 'ident') break;
          const { chain, end } = this.readDottedChain(j);
          this.emitTypeRef('type-use', chain, tj.off, 'throws clause');
          j = end;
          if (this.at(j)?.text === ',') j++;
          else break;
        }
        i = j;
        continue;
      }

      // ---- identifier-led constructs ----
      if (t.kind === 'ident') {
        i = this.handleIdentifier(i);
        continue;
      }

      i++;
    }

    const cmp = (a: JavaFinding, b: JavaFinding): number =>
      a.line - b.line ||
      a.col - b.col ||
      a.kind.localeCompare(b.kind) ||
      a.rawName.localeCompare(b.rawName) ||
      (a.memberName ?? '').localeCompare(b.memberName ?? '') ||
      (a.className ?? '').localeCompare(b.className ?? '');
    this.findings.sort(cmp);
    return {
      file: this.file,
      packageName: this.pkg,
      imports: this.importList,
      findings: this.findings,
      declaredTypes: [...this.localTypes].sort(),
    };
  }

  /** Read a dotted ident chain (`a.b.C`) starting at a token index. */
  private readDottedChain(start: number): { chain: string; end: number } {
    const parts: string[] = [];
    let i = start;
    while (i < this.toks.length) {
      const t = this.at(i);
      if (!t || t.kind !== 'ident') break;
      parts.push(t.text);
      const dot = this.at(i + 1);
      const after = this.at(i + 2);
      if (dot && dot.text === '.' && after && after.kind === 'ident') i += 2;
      else {
        i += 1;
        break;
      }
    }
    return { chain: parts.join('.'), end: i };
  }

  private handleImport(impIdx: number): number {
    let i = impIdx + 1;
    let isStatic = false;
    const t = this.at(i);
    if (t && t.kind === 'kw' && t.text === 'static') {
      isStatic = true;
      i++;
    }
    const startTok = this.at(i);
    const parts: string[] = [];
    let wildcard = false;
    while (i < this.toks.length) {
      const tt = this.at(i)!;
      if (tt.kind === 'ident') {
        parts.push(tt.text);
        i++;
      } else if (tt.text === '.') {
        const nx = this.at(i + 1);
        if (nx && nx.text === '*') {
          wildcard = true;
          i += 2;
          break;
        }
        i++;
      } else break;
    }
    if (this.at(i)?.text === ';') i++;
    if (!startTok || parts.length === 0) return i;
    const raw = parts.join('.') + (wildcard ? '.*' : '');
    const off = startTok.off;
    const line = lineOf(this.lineStarts, off);

    if (!isStatic && !wildcard) {
      const fqn = parts.join('.');
      const simple = parts[parts.length - 1]!;
      this.imports.set(simple, fqn);
      const { binary, note } = fqnToBinary(fqn);
      const imp: JavaImport = { kind: 'class', line, raw, className: binary };
      if (note !== undefined) imp.note = note;
      this.importList.push(imp);
      const extra: { className: string; note?: string } = { className: binary };
      if (note !== undefined) extra.note = note;
      this.emit('import', off, raw, extra);
    } else if (!isStatic && wildcard) {
      const pkg = parts.join('.');
      this.wildcardPkgs.push(pkg);
      this.importList.push({ kind: 'wildcard', line, raw, packageName: pkg });
      this.emit('import-wildcard', off, raw, {
        note: `wildcard import — names from ${pkg} enter scope unknowably`,
      });
    } else if (isStatic && wildcard) {
      const owner = parts.join('.');
      this.staticWildcardOwners.push(owner);
      const { binary, note } = fqnToBinary(owner);
      const imp: JavaImport = { kind: 'static-wildcard', line, raw, className: binary };
      if (note !== undefined) imp.note = note;
      this.importList.push(imp);
      const extra: { className: string; note?: string } = { className: binary };
      extra.note = note !== undefined ? note : 'static wildcard — member names enter scope unknowably';
      this.emit('import-static-wildcard', off, raw, extra);
    } else {
      // import static a.b.C.member;
      const member = parts[parts.length - 1]!;
      const owner = parts.slice(0, -1).join('.');
      this.staticImports.set(member, owner);
      const { binary, note } = fqnToBinary(owner);
      const imp: JavaImport = { kind: 'static-member', line, raw, className: binary, memberName: member };
      if (note !== undefined) imp.note = note;
      this.importList.push(imp);
      const extra: { className: string; memberName: string; note?: string } = { className: binary, memberName: member };
      if (note !== undefined) extra.note = note;
      this.emit('import-static', off, raw, extra);
    }
    return i;
  }

  private handleTypeHeader(kwIdx: number): number {
    // class/interface/enum/record Name [<...>] [extends ...] [implements ...] {
    let i = kwIdx + 1;
    const isInterface = this.at(kwIdx)!.text === 'interface';
    if (this.at(i)?.kind !== 'ident') return i;
    i++; // past the name (already collected in pass 0)
    const lt = this.at(i);
    if (lt && lt.text === '<') {
      const g = tryParseGenerics(this.toks, i);
      i = g ? g.end : i + 1;
    }
    // record header parens (components are declarations)
    if (this.at(i)?.text === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < this.toks.length && depth > 0) {
        const tj = this.at(j)!;
        if (tj.text === '(') depth++;
        else if (tj.text === ')') depth--;
        j++;
      }
      i = j;
    }
    while (i < this.toks.length) {
      const t = this.at(i);
      if (!t) break;
      if (t.kind === 'kw' && (t.text === 'extends' || t.text === 'implements')) {
        const kind: JavaRefKind = t.text === 'extends' ? 'extends' : 'implements';
        let j = i + 1;
        let first = true;
        while (j < this.toks.length) {
          const tj = this.at(j);
          if (!tj || tj.kind !== 'ident') break;
          const { chain, end } = this.readDottedChain(j);
          this.emitTypeRef(kind, chain, tj.off);
          if (kind === 'extends' && !isInterface && first) {
            const r = this.resolveTypeName(chain);
            if (r.kind === 'resolved') this.superClassName = r.className;
          }
          first = false;
          j = end;
          const g = this.at(j);
          if (g && g.text === '<') {
            const gp = tryParseGenerics(this.toks, j);
            if (gp) {
              for (const c of gp.chains) this.emitTypeRef('type-use', c.text, c.off, 'generic argument');
              j = gp.end;
            } else j++;
          }
          if (this.at(j)?.text === ',') j++;
          else break;
        }
        i = j;
        continue;
      }
      if (t.text === '{') break;
      i++;
    }
    return i;
  }

  /**
   * Identifier-led constructs: declarations, member accesses, class literals,
   * bare static-import calls, FQN references. One decision point, every exit
   * path documented by the kind it emits (or deliberately not emits).
   */
  private handleIdentifier(idx: number): number {
    const t = this.at(idx)!;
    const prev = this.at(idx - 1);
    // Receiver positions we must NOT re-interpret: `.x` (we handle chains from
    // their head), annotation names (handled at `@`).
    if (prev && (prev.text === '.' || prev.text === '@')) return idx + 1;

    // `this.member` → own class: mod-local, deliberately not emitted.
    if (t.text === 'this' && this.at(idx + 1)?.text === '.') {
      return idx + 2;
    }
    // `super.member(...)` → the superclass, when extends resolved.
    if (t.text === 'super' && this.at(idx + 1)?.text === '.') {
      const mem = this.at(idx + 2);
      if (mem && mem.kind === 'ident') {
        const isCall = this.at(idx + 3)?.text === '(';
        if (this.superClassName) {
          const extra: {
            className: string; memberName: string; memberKind: 'method' | 'field'; argCount?: number; note: string;
          } = {
            className: this.superClassName,
            memberName: mem.text,
            memberKind: isCall ? 'method' : 'field',
            note: 'via super — owner is the declared superclass',
          };
          if (isCall) {
            const n = countCallArgs(this.toks, idx + 3);
            if (n !== null) extra.argCount = n;
          }
          this.emit('member-instance', mem.off, 'super.' + mem.text, extra);
        } else {
          this.emit('member-unresolved-receiver', mem.off, 'super.' + mem.text, {
            memberName: mem.text,
            memberKind: isCall ? 'method' : 'field',
            note: 'super receiver, but the extends clause did not resolve to a known class',
          });
        }
        return idx + 3;
      }
    }

    const { chain, end } = this.readDottedChain(idx);
    const afterChainTok = this.at(end);

    // `Chain.class` → class literal (readDottedChain stops before keywords).
    if (afterChainTok && afterChainTok.text === '.' && this.at(end + 1)?.kind === 'kw' && this.at(end + 1)!.text === 'class') {
      this.emitTypeRef('class-literal', chain, t.off);
      return end + 2;
    }

    // `Chain::member` → method reference.
    if (afterChainTok && afterChainTok.text === '::') {
      const mem = this.at(end + 1);
      if (mem && (mem.kind === 'ident' || (mem.kind === 'kw' && mem.text === 'new'))) {
        if (mem.kind === 'kw') {
          this.emitTypeRef('new', chain, t.off, 'constructor reference');
        } else {
          this.emitMemberOnChain(chain, t.off, mem.text, 'method', null, 'method reference');
        }
        return end + 2;
      }
    }

    // Chain followed by generics? Try as a declared type with generic args.
    let genEnd = end;
    let genChains: { text: string; off: number }[] = [];
    if (afterChainTok && afterChainTok.text === '<') {
      const g = tryParseGenerics(this.toks, end);
      if (g) {
        genEnd = g.end;
        genChains = g.chains;
      }
    }
    // Array dims on the type
    let dimEnd = genEnd;
    while (this.at(dimEnd)?.text === '[' && this.at(dimEnd + 1)?.text === ']') dimEnd += 2;

    // Declaration: TypeChain [generics] [dims] name (=|;|,|)|:|->)
    const nameTok = this.at(dimEnd);
    const termTok = this.at(dimEnd + 1);
    if (
      nameTok && nameTok.kind === 'ident' &&
      termTok && DECL_TERMS.has(termTok.text) &&
      (isUpperStart(chain.split('.').pop()!) || chain.includes('.'))
    ) {
      this.emitTypeRef('type-use', chain, t.off, 'declared type');
      for (const c of genChains) this.emitTypeRef('type-use', c.text, c.off, 'generic argument');
      const res = this.resolveTypeName(chain);
      const existing = this.varTypes.get(nameTok.text);
      if (existing && (existing === 'conflict' || existing.written !== chain)) {
        this.varTypes.set(nameTok.text, 'conflict');
      } else {
        this.varTypes.set(nameTok.text, { written: chain, res });
      }
      return dimEnd + 1;
    }

    // Member access from the chain: the LAST segment may be the member.
    if (chain.includes('.')) {
      const segs = chain.split('.');
      const memberName = segs[segs.length - 1]!;
      const receiver = segs.slice(0, -1).join('.');
      const isCall = afterChainTok?.text === '(';
      const argCount = isCall ? countCallArgs(this.toks, end) : null;
      if (segs.length === 2) {
        const v = this.varTypes.get(segs[0]!);
        if (v !== undefined) {
          if (v === 'conflict') {
            this.emit('member-unresolved-receiver', t.off, chain, {
              memberName,
              memberKind: isCall ? 'method' : 'field',
              note: `receiver '${segs[0]}' redeclared with differing types in this file`,
            });
          } else if (v.res.kind === 'resolved') {
            const extra: {
              className: string; memberName: string; memberKind: 'method' | 'field'; argCount?: number; note?: string;
            } = {
              className: v.res.className,
              memberName,
              memberKind: isCall ? 'method' : 'field',
            };
            if (argCount !== null) extra.argCount = argCount;
            const note = v.res.note;
            extra.note = note !== undefined
              ? `receiver '${segs[0]}' declared as ${v.written}; ${note}`
              : `receiver '${segs[0]}' declared as ${v.written}`;
            this.emit('member-instance', t.off, chain, extra);
          } else {
            this.emit('member-unresolved-receiver', t.off, chain, {
              memberName,
              memberKind: isCall ? 'method' : 'field',
              note: `receiver '${segs[0]}' has unresolvable declared type '${v.written}'`,
            });
          }
          return isCall ? end + 1 : end;
        }
      }
      if (!isUpperStart(memberName)) {
        this.emitMemberOnChain(receiver, t.off, memberName, isCall ? 'method' : 'field', argCount, undefined);
        return isCall ? end + 1 : end;
      }
      // ALL_CAPS final segment = a constant field by Java convention, not a
      // nested class (RenderPipelines.GUI_TEXTURED). Nested classes are CamelCase.
      if (/^[A-Z][A-Z0-9_]*$/.test(memberName) && memberName.length > 1 && !/[a-z]/.test(memberName)) {
        this.emitMemberOnChain(
          receiver, t.off, memberName, isCall ? 'method' : 'field', argCount,
          'ALL_CAPS segment treated as a constant field (Java naming convention)',
        );
        return isCall ? end + 1 : end;
      }
      // Whole chain looks like a type (FQN reference / nested class use).
      this.emitTypeRef('fqn-reference', chain, t.off);
      return end;
    }

    // Single identifier: bare static-import usage, or noise.
    if (afterChainTok?.text === '(') {
      const owner = this.staticImports.get(chain);
      if (owner !== undefined) {
        const r = fqnToBinary(owner);
        const n = countCallArgs(this.toks, end);
        const extra: { className: string; memberName: string; memberKind: 'method'; argCount?: number; note: string } = {
          className: r.binary,
          memberName: chain,
          memberKind: 'method',
          note: `bare call bound by static import of ${owner}.${chain}` + (r.note !== undefined ? `; ${r.note}` : ''),
        };
        if (n !== null) extra.argCount = n;
        this.emit('member-static', t.off, chain, extra);
        return end + 1;
      }
      // own method / unknowable bare call — deliberately not emitted (noise).
      return end + 1;
    }
    return end;
  }

  /** Emit a member access whose receiver chain must resolve as a TYPE. */
  private emitMemberOnChain(
    receiver: string,
    off: number,
    memberName: string,
    memberKind: 'method' | 'field',
    argCount: number | null,
    ctxNote: string | undefined,
  ): void {
    const r = this.resolveTypeName(receiver);
    if (r.kind === 'resolved') {
      const extra: {
        className: string; memberName: string; memberKind: 'method' | 'field'; argCount?: number; note?: string;
      } = { className: r.className, memberName, memberKind };
      if (argCount !== null) extra.argCount = argCount;
      const note = ctxNote !== undefined && r.note !== undefined ? `${ctxNote}; ${r.note}` : ctxNote ?? r.note;
      if (note !== undefined) extra.note = note;
      this.emit('member-static', off, receiver + '.' + memberName, extra);
      return;
    }
    if (r.kind === 'type-variable') return;
    this.emit('member-unresolved-receiver', off, receiver + '.' + memberName, {
      memberName,
      memberKind,
      note: r.note,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Scan one Java source file. Throws (loudly, with location) on lexer failure. */
export function scanJavaSource(text: string, fileName: string): JavaScanResult {
  return new FileScanner(text, fileName.replace(/\\/g, '/')).scan();
}

/** Directories never descended into (build outputs, VCS, backups). */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.gradle', 'build', 'out', 'bin', 'target', '.idea', '.modforge-backup', 'dist',
]);

/**
 * Scan a source tree for `.java` files. Per-file failures are collected loudly
 * in `errors` (with the file and reason) — never silently skipped.
 */
export function scanTree(dir: string): JavaTreeScan {
  const files: JavaScanResult[] = [];
  const errors: { file: string; error: string }[] = [];
  const walk = (d: string): void => {
    const entries = readdirSync(d, { withFileTypes: true });
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of sorted) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && e.name.endsWith('.java')) {
        const norm = p.replace(/\\/g, '/');
        try {
          files.push(scanJavaSource(readFileSync(p, 'utf8'), norm));
        } catch (err) {
          errors.push({ file: norm, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  };
  walk(dir);
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files, findings: files.flatMap((f) => f.findings), errors };
}
