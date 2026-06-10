/**
 * checkTargetsAgainstJar — verdict semantics for mixin-check (frozen contract).
 *
 * This replays the confirmed P0 (finding 01): mixin-check shipped ABSENT
 * ("break on this version") verdicts for owners that were never expected inside
 * the MC jar (java/util/Map, Guava, the mod's own classes) and for inherited
 * members that exist in the target jar via a supertype. The fix introduces a
 * pure function whose verdicts are hand-derived below — never copied from any
 * engine output.
 *
 * Synthetic target jar (built by hand from src/core/model.ts):
 *   net/minecraft/world/entity/Entity   super=java/lang/Object
 *                                        methods: level ()Lnet/minecraft/world/level/Level;
 *   net/minecraft/world/entity/Targeting super=java/lang/Object   (an interface)
 *                                        methods: getTarget ()Lnet/minecraft/world/entity/LivingEntity;
 *   net/minecraft/world/entity/Mob       super=Entity  implements=[Targeting]
 *                                        methods: tick ()V
 *   net/minecraft/world/phys/AbstractVec super=java/lang/Object
 *                                        methods: add (DDD)Lnet/minecraft/world/phys/Vec3;
 *   net/minecraft/world/phys/Vec3        super=AbstractVec
 *
 * BFS (superclass before interfaces; owner excluded; classes absent from the jar
 * leave the walk) traced by hand:
 *   from Mob → [Entity, Targeting, java/lang/Object(absent→leaves)]
 *     Mob#level     : not on Mob; Entity declares level     → present, inherited from Entity
 *     Mob#getTarget : not on Mob, not on Entity; Targeting declares getTarget
 *                                                            → present, inherited from Targeting
 *     Mob#toString  : on nobody in-jar; java/lang/Object method → info (never absent)
 *   from Vec3 → [AbstractVec, java/lang/Object(absent)]
 *     Vec3#add (Lnet/minecraft/world/phys/Vec3;)L..Vec3; : AbstractVec has add but
 *       descriptor (DDD)L..Vec3; differs everywhere       → absent (near-miss names (DDD)...)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTargetsAgainstJar,
  type MixinVerdict,
  type MixinTargetCheck,
  type MixinSurface,
} from '../src/scan/mixin.ts';
import type { JarApi, ClassApi } from '../src/core/model.ts';

function cls(
  binaryName: string,
  superName: string | null,
  opts: { interfaces?: string[]; methods?: [string, string][]; fields?: [string, string][] } = {},
): ClassApi {
  return {
    binaryName,
    access: 0x0001,
    majorVersion: 69,
    superName,
    interfaces: opts.interfaces ?? [],
    methods: (opts.methods ?? []).map(([n, d]) => ({ name: n, desc: d, access: 0x0001 })),
    fields: (opts.fields ?? []).map(([n, d]) => ({ name: n, desc: d, access: 0x0001 })),
  };
}

const JAR: JarApi = {
  id: '26.1.2-client',
  classes: new Map(
    [
      cls('net/minecraft/world/entity/Entity', 'java/lang/Object', {
        methods: [['level', '()Lnet/minecraft/world/level/Level;']],
      }),
      cls('net/minecraft/world/entity/Targeting', 'java/lang/Object', {
        methods: [['getTarget', '()Lnet/minecraft/world/entity/LivingEntity;']],
      }),
      cls('net/minecraft/world/entity/Mob', 'net/minecraft/world/entity/Entity', {
        interfaces: ['net/minecraft/world/entity/Targeting'],
        methods: [['tick', '()V']],
      }),
      cls('net/minecraft/world/phys/AbstractVec', 'java/lang/Object', {
        methods: [['add', '(DDD)Lnet/minecraft/world/phys/Vec3;']],
      }),
      cls('net/minecraft/world/phys/Vec3', 'net/minecraft/world/phys/AbstractVec'),
    ].map((c) => [c.binaryName, c] as const),
  ),
};

let lineSeq = 0;
function check(
  surface: MixinSurface,
  ref: MixinTargetCheck['ref'],
  note?: string,
): MixinTargetCheck {
  const c: MixinTargetCheck = {
    surface,
    mixinClass: 'mod.SomeMixin',
    file: 'src/main/java/mod/SomeMixin.java',
    line: ++lineSeq,
    ref,
  };
  if (note !== undefined) c.note = note;
  return c;
}

/** Verdict for the single check, asserting checkTargetsAgainstJar preserves identity. */
function verdictFor(c: MixinTargetCheck): MixinVerdict {
  const out = checkTargetsAgainstJar([c], JAR);
  assert.equal(out.length, 1, 'one verdict per input check');
  assert.equal(out[0]!.check, c, 'verdict carries the same check object');
  return out[0]!;
}

// ---------------------------------------------------------------------------
// Case 1 — the literal false verdict shipped: java/util/Map member must be INFO.
// ---------------------------------------------------------------------------
test('java/util/Map member check is info, never the shipped false ABSENT', () => {
  const v = verdictFor(
    check('at-invoke', { owner: 'java/util/Map', name: 'get', desc: '(Ljava/lang/Object;)Ljava/lang/Object;' }),
  );
  assert.notEqual(v.status, 'absent'); // this was "ABSENT java/util/Map — target class not in 26.1.2"
  assert.equal(v.status, 'info');
  assert.match(v.note ?? '', /outside Minecraft/i);
  assert.match(v.note ?? '', /not verifiable/i);
});

// ---------------------------------------------------------------------------
// Case 2 — Guava library owner → info.
// ---------------------------------------------------------------------------
test('com/google/common/collect/Lists owner is info, not absent', () => {
  const v = verdictFor(check('at-invoke', { owner: 'com/google/common/collect/Lists', name: 'newArrayList' }));
  assert.equal(v.status, 'info');
  assert.notEqual(v.status, 'absent');
});

// ---------------------------------------------------------------------------
// Case 3 — mod-local owner (not net/minecraft, not com/mojang) → info.
// ---------------------------------------------------------------------------
test('mod-local owner net/caffeinemc/... is info, not absent', () => {
  const v = verdictFor(
    check('at-invoke', { owner: 'net/caffeinemc/mods/lithium/SomeClass', name: 'doThing', desc: '()V' }),
  );
  assert.equal(v.status, 'info');
  assert.notEqual(v.status, 'absent');
});

// ---------------------------------------------------------------------------
// Case 4 — MC owner genuinely absent from the jar → absent (a real break).
// ---------------------------------------------------------------------------
test('MC owner absent from the target jar is absent with a rename hint', () => {
  const v = verdictFor(check('mixin-target', { owner: 'net/minecraft/world/Gone' }));
  assert.equal(v.status, 'absent');
  assert.match(v.note ?? '', /renamed/i);
});

// ---------------------------------------------------------------------------
// Case 5 — inherited through a SUPERCLASS chain → present, names the declarer.
// ---------------------------------------------------------------------------
test('Mob#level inherited from Entity is present with an inheritance note', () => {
  const v = verdictFor(
    check('at-invoke', {
      owner: 'net/minecraft/world/entity/Mob',
      name: 'level',
      desc: '()Lnet/minecraft/world/level/Level;',
    }),
  );
  assert.equal(v.status, 'present');
  assert.match(v.note ?? '', /inherited from/i);
  assert.ok((v.note ?? '').includes('net/minecraft/world/entity/Entity'), 'names Entity as the declarer');
});

// ---------------------------------------------------------------------------
// Case 6 — inherited through an INTERFACE the owner implements → present.
// ---------------------------------------------------------------------------
test('Mob#getTarget inherited from interface Targeting is present', () => {
  const v = verdictFor(
    check('at-invoke', {
      owner: 'net/minecraft/world/entity/Mob',
      name: 'getTarget',
      desc: '()Lnet/minecraft/world/entity/LivingEntity;',
    }),
  );
  assert.equal(v.status, 'present');
  assert.match(v.note ?? '', /inherited from/i);
  assert.ok((v.note ?? '').includes('net/minecraft/world/entity/Targeting'), 'names Targeting as the declarer');
});

// ---------------------------------------------------------------------------
// Case 7 — name present but every descriptor differs → absent (near-miss note).
// ---------------------------------------------------------------------------
test('Vec3#add with a never-seen descriptor is absent, naming the differing descriptor', () => {
  const v = verdictFor(
    check('at-invoke', {
      owner: 'net/minecraft/world/phys/Vec3',
      name: 'add',
      desc: '(Lnet/minecraft/world/phys/Vec3;)Lnet/minecraft/world/phys/Vec3;',
    }),
  );
  assert.equal(v.status, 'absent');
  assert.ok((v.note ?? '').includes('(DDD)Lnet/minecraft/world/phys/Vec3;'), 'near-miss note names the descriptor actually seen');
});

// ---------------------------------------------------------------------------
// Case 8 — java/lang/Object method not declared anywhere in-jar → info.
// ---------------------------------------------------------------------------
test('Mob#toString (an Object method, undeclared in-jar) is info, never absent', () => {
  const v = verdictFor(
    check('at-invoke', { owner: 'net/minecraft/world/entity/Mob', name: 'toString', desc: '()Ljava/lang/String;' }),
  );
  assert.notEqual(v.status, 'absent');
  assert.equal(v.status, 'info');
});

// ---------------------------------------------------------------------------
// Case 9 — class-only check on a present MC class → present.
// ---------------------------------------------------------------------------
test('class-only check on a present MC class is present', () => {
  const v = verdictFor(check('mixin-target', { owner: 'net/minecraft/world/entity/Mob' }));
  assert.equal(v.status, 'present');
});

// ---------------------------------------------------------------------------
// Case 10 — no owner → unparseable (carries the check's own note, else default).
// ---------------------------------------------------------------------------
test('check with no owner is unparseable and keeps its own note', () => {
  const withNote = verdictFor(check('shadow', {}, 'owner implied by @Mixin target(s)'));
  assert.equal(withNote.status, 'unparseable');
  assert.equal(withNote.note, 'owner implied by @Mixin target(s)');

  const noNote = verdictFor(check('unparseable', {}));
  assert.equal(noNote.status, 'unparseable');
  assert.equal(noNote.note, 'no owner derivable');
});

// ---------------------------------------------------------------------------
// Bonus — a directly-declared member is present WITHOUT an inheritance note
// (guards against unconditionally emitting "inherited from").
// ---------------------------------------------------------------------------
test('directly-declared member is present and not labelled inherited', () => {
  const v = verdictFor(
    check('at-invoke', {
      owner: 'net/minecraft/world/entity/Entity',
      name: 'level',
      desc: '()Lnet/minecraft/world/level/Level;',
    }),
  );
  assert.equal(v.status, 'present');
  assert.ok(!/inherited from/i.test(v.note ?? ''), 'no inheritance note for a directly-declared member');
});

// ---------------------------------------------------------------------------
// Case 11 — output order equals input order (determinism, identity-preserving).
// ---------------------------------------------------------------------------
test('output order equals input order', () => {
  const inputs: MixinTargetCheck[] = [
    check('at-invoke', { owner: 'java/util/Map', name: 'get' }),       // info
    check('mixin-target', { owner: 'net/minecraft/world/Gone' }),      // absent
    check('mixin-target', { owner: 'net/minecraft/world/entity/Mob' }),// present
    check('shadow', {}),                                               // unparseable
  ];
  const verdicts = checkTargetsAgainstJar(inputs, JAR);
  assert.equal(verdicts.length, inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(verdicts[i]!.check, inputs[i], `verdict ${i} maps to input ${i} in order`);
  }
  assert.deepEqual(
    verdicts.map((v) => v.status),
    ['info', 'absent', 'present', 'unparseable'],
  );
});
