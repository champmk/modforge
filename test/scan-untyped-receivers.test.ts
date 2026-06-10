/**
 * Untyped bindings (lambda parameters, `var` declarations) have no lexically
 * derivable type. The scanner's varTypes map is flat per file, so a name bound
 * untyped ANYWHERE in the file can never be a provable member receiver — the
 * confirmed P0: `threads.forEach(p -> p.getName())` was attributed to an
 * unrelated `PlayerEntity p` declaration and silently rewritten under --apply.
 * Expectations hand-derived from the sources below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanJavaSource, type JavaFinding } from '../src/scan/java.ts';

const PLAYER = 'net/minecraft/entity/player/PlayerEntity';

function members(text: string, memberName: string): JavaFinding[] {
  return scanJavaSource(text, 'Demo.java').findings.filter((f) => f.memberName === memberName);
}

test('lambda param colliding with a typed declaration is never a certain receiver', () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    'import java.util.List;',
    '',
    'public class Demo {',
    '\tvoid heal(PlayerEntity p) {',
    '\t\tp.getName();',
    '\t}',
    '\tvoid run(List<Thread> threads) {',
    '\t\tthreads.forEach(p -> p.getName());',
    '\t}',
    '}',
    '',
  ].join('\n');
  const found = members(src, 'getName');
  assert.equal(found.length, 2, JSON.stringify(found, null, 2));
  for (const f of found) {
    assert.equal(f.kind, 'member-unresolved-receiver', `line ${f.line}: a flat map cannot prove which 'p' this is — ${JSON.stringify(f)}`);
    assert.notEqual(f.className, PLAYER, 'must not attribute the lambda receiver to PlayerEntity');
  }
});

test('lambda param without collision is unresolved with a lambda-specific reason', () => {
  const src = [
    'package demo;',
    '',
    'import java.util.List;',
    '',
    'public class Demo {',
    '\tvoid run(List<String> list) {',
    '\t\tlist.forEach(s -> s.length());',
    '\t}',
    '}',
    '',
  ].join('\n');
  const found = members(src, 'length');
  assert.equal(found.length, 1, JSON.stringify(found, null, 2));
  assert.equal(found[0]!.kind, 'member-unresolved-receiver');
  assert.match(found[0]!.note ?? '', /lambda|'var'/);
});

test('parenthesized multi-param lambda binds all its params as untyped', () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    'import java.util.Map;',
    '',
    'public class Demo {',
    '\tPlayerEntity v;',
    '\tvoid run(Map<String, Thread> map) {',
    '\t\tmap.forEach((k, v) -> v.getHealth());',
    '\t}',
    '}',
    '',
  ].join('\n');
  const found = members(src, 'getHealth');
  assert.equal(found.length, 1, JSON.stringify(found, null, 2));
  assert.equal(found[0]!.kind, 'member-unresolved-receiver', JSON.stringify(found[0], null, 2));
});

test("a 'var' declaration colliding with a typed declaration poisons the name", () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    '',
    'public class Demo {',
    '\tvoid a() {',
    '\t\tPlayerEntity p = get();',
    '\t\tp.getHealth();',
    '\t}',
    '\tvoid b() {',
    '\t\tvar p = other();',
    '\t\tp.getHealth();',
    '\t}',
    '}',
    '',
  ].join('\n');
  const found = members(src, 'getHealth');
  assert.equal(found.length, 2, JSON.stringify(found, null, 2));
  for (const f of found) {
    assert.equal(f.kind, 'member-unresolved-receiver', `line ${f.line}: ${JSON.stringify(f)}`);
  }
});

test('explicitly TYPED lambda params stay tracked (no over-poisoning)', () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    'import java.util.List;',
    '',
    'public class Demo {',
    '\tvoid run(List<PlayerEntity> list) {',
    '\t\tlist.forEach((PlayerEntity x) -> x.getHealth());',
    '\t}',
    '}',
    '',
  ].join('\n');
  const found = members(src, 'getHealth');
  assert.equal(found.length, 1, JSON.stringify(found, null, 2));
  assert.equal(found[0]!.kind, 'member-instance', 'a typed lambda param is a tracked declared type');
  assert.equal(found[0]!.className, PLAYER);
});

test('plain typed locals in a lambda-free file are unaffected', () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    '',
    'public class Demo {',
    '\tvoid tick() {',
    '\t\tPlayerEntity q = get();',
    '\t\tq.getHealth();',
    '\t}',
    '}',
    '',
  ].join('\n');
  const found = members(src, 'getHealth');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, 'member-instance');
  assert.equal(found[0]!.className, PLAYER);
});
