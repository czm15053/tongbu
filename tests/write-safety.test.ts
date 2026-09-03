import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digestFile, writeFileAtomic } from '../src/core/atomic.js';
import { addFinding, findingsStatus, mergeFindings } from '../src/core/findings.js';
import { assertRoundTrip } from '../src/core/verify.js';
import type { ProcessEvent, UnifiedTurn } from '../src/core/types.js';

function turn(role: 'user' | 'assistant', text: string, events: ProcessEvent[] = []): UnifiedTurn {
  return { role, text, timestamp: '2026-08-30T00:00:00.000Z', provider: 'test', events: events.length ? events : undefined };
}

function ev(kind: ProcessEvent['kind'], callId?: string): ProcessEvent {
  return { kind, summary: kind, timestamp: '2026-08-30T00:00:00.000Z', provider: 'test', callId };
}

test('writeFileAtomic: verify 抛错零写盘，原文件不损坏、无 tmp 残留', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-atomic-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, 'ORIGINAL\n', 'utf8');
    await assert.rejects(
      writeFileAtomic(file, 'NEW\n', { verify: async () => { throw new Error('bad content'); } }),
      /bad content/,
    );
    assert.equal(await readFile(file, 'utf8'), 'ORIGINAL\n');
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.includes('tongbu-tmp')), `tmp 残留: ${files.join(',')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic: replace backup 生成 .bak；verify 通过则内容落盘', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-atomic-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, 'V1\n', 'utf8');
    await writeFileAtomic(file, 'V2\n', { backup: true, verify: async () => {} });
    assert.equal(await readFile(file, 'utf8'), 'V2\n');
    assert.equal(await readFile(`${file}.bak`, 'utf8'), 'V1\n');
    // 无 backup 时不产生 .bak
    await writeFileAtomic(file, 'V3\n', { verify: async () => {} });
    assert.equal(await readFile(`${file}.bak`, 'utf8'), 'V1\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic: 新文件 0600 创建', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-atomic-'));
  try {
    const file = path.join(dir, 'new.jsonl');
    await writeFileAtomic(file, 'x\n');
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('digestFile: 内容指纹一致；缺失返回 null', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-atomic-'));
  try {
    const file = path.join(dir, 'a.jsonl');
    await writeFile(file, 'hello\n', 'utf8');
    const d1 = await digestFile(file);
    const d2 = await digestFile(file);
    assert.ok(d1 && d2 && d1.sha256 === d2.sha256 && d1.sizeBytes === 6);
    assert.equal(await digestFile(path.join(dir, 'missing')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findings: 合并计数、排序、三档归约', () => {
  const list: import('../src/core/findings.js').Finding[] = [];
  addFinding(list, 'claude.compaction', 'skipped');
  addFinding(list, 'claude.compaction', 'skipped', 3);
  addFinding(list, 'handoff.append', 'exact', 5);
  addFinding(list, 'handoff.rewrite', 'degraded');
  assert.deepEqual(list, [
    { code: 'claude.compaction', disposition: 'skipped', count: 4 },
    { code: 'handoff.append', disposition: 'exact', count: 5 },
    { code: 'handoff.rewrite', disposition: 'degraded', count: 1 },
  ]);
  assert.equal(findingsStatus(list), 'degraded');
  assert.equal(findingsStatus([]), 'exact');
  assert.equal(findingsStatus(mergeFindings(list, [{ code: 'x', disposition: 'blocked', count: 1 }])), 'blocked');
});

test('assertRoundTrip: 一致通过；turn 数/事件计数/文本/callId 失误各自报错', () => {
  const good = [turn('user', '问题'), turn('assistant', '回答', [ev('thinking'), ev('tool_call', 'c1'), ev('tool_result', 'c1')])];
  assert.doesNotThrow(() => assertRoundTrip(good, structuredClone(good), 'test'));

  assert.throws(() => assertRoundTrip(good.slice(0, 1), good, 'test'), /turn 数不一致/);

  const noThinking = structuredClone(good);
  noThinking[1]!.events = noThinking[1]!.events!.filter((e) => e.kind !== 'thinking');
  assert.throws(() => assertRoundTrip(good, noThinking, 'test'), /thinking 计数不一致/);

  const noCall = structuredClone(good);
  for (const e of noCall[1]!.events!) e.callId = undefined;
  assert.throws(() => assertRoundTrip(good, noCall, 'test'), /丢失 callId: c1/);

  const badText = structuredClone(good);
  badText[0]!.text = '另一个问题';
  assert.throws(() => assertRoundTrip(badText, good, 'test'), /文本不一致/);

  // 输入侧全空 turn 被忽略；builder 生成的 callId 不要求反向存在
  const withEmpty = [...good, turn('assistant', '')];
  assert.doesNotThrow(() => assertRoundTrip(withEmpty, good, 'test'));
  const generated = [turn('user', 'q'), turn('assistant', 'a', [ev('tool_call', 'gen-1'), ev('tool_result', 'gen-1')])];
  const inputNoIds = [turn('user', 'q'), turn('assistant', 'a', [ev('tool_call'), ev('tool_result')])];
  assert.doesNotThrow(() => assertRoundTrip(inputNoIds, generated, 'test'));
});
