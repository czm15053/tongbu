import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePiProjectDir, findLatestPiSession } from '../src/providers/pi/index.js';
import { importTurnsToPi } from '../src/providers/pi/build.js';
import { parsePiSession } from '../src/providers/pi/parse.js';
import { getAdapter, listAdapters } from '../src/providers/registry.js';
import type { UnifiedTurn } from '../src/core/types.js';

test('encodePiProjectDir 与 pi 目录命名规则一致', () => {
  assert.equal(
    encodePiProjectDir('/Users/alice/projects/my-app'),
    '--Users-alice-projects-my-app--',
  );
  assert.equal(
    encodePiProjectDir('/private/tmp/pi-fresh2'),
    '--private-tmp-pi-fresh2--',
  );
});

test('listAdapters 含 pi', () => {
  assert.ok(listAdapters().some((a) => a.id === 'pi'));
  assert.equal(getAdapter('pi')?.resumeCommand({
    provider: 'pi',
    sessionId: 'abc',
    filePath: '/tmp/a.jsonl',
    cwd: '/tmp',
  }), 'pi --session abc');
});

test('findLatestPiSession: 其它 cwd 不得胜出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tongbu-pi-'));
  const cwd = '/proj/demo';
  const ours = join(root, encodePiProjectDir(cwd));
  const theirs = join(root, encodePiProjectDir('/proj/other'));
  mkdirSync(ours, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  try {
    const a = join(ours, '2026-08-22T00-00-00-000Z_aaaa.jsonl');
    const b = join(theirs, '2026-08-22T00-00-00-000Z_bbbb.jsonl');
    writeFileSync(a, '{}\n');
    writeFileSync(b, '{}\n');
    utimesSync(b, 1_800_000_000, 1_800_000_000);
    utimesSync(a, 1_700_000_000, 1_700_000_000);
    const found = await findLatestPiSession(cwd, root);
    assert.ok(found);
    assert.equal(found.ref.sessionId, 'aaaa');
    assert.equal(await findLatestPiSession('/none', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('importTurns → parse round-trip 含 thinking/tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tongbu-pi-rt-'));
  const cwd = '/proj/demo';
  try {
    const turns: UnifiedTurn[] = [
      { role: 'user', text: '跑一下', timestamp: '2026-08-22T00:00:00.000Z' },
      {
        role: 'assistant',
        text: '好了',
        timestamp: '2026-08-22T00:00:01.000Z',
        provider: 'pi',
        events: [
          { kind: 'thinking', summary: '想', detail: '想一下', timestamp: '2026-08-22T00:00:01.000Z', provider: 'pi' },
          { kind: 'tool_call', summary: 'bash', name: 'bash', callId: 'c1', timestamp: '2026-08-22T00:00:01.000Z', provider: 'pi', input: { cmd: 'ls' } },
          { kind: 'tool_result', summary: 'ok', detail: 'ok', name: 'bash', callId: 'c1', timestamp: '2026-08-22T00:00:01.000Z', provider: 'pi' },
        ],
      },
    ];
    const ref = await importTurnsToPi(turns, cwd, undefined, undefined, root);
    const back = await parsePiSession(ref);
    assert.equal(back[0]?.text, '跑一下');
    assert.equal(back[1]?.text, '好了');
    assert.equal(back[1]?.events?.some((e) => e.kind === 'thinking'), true);
    assert.equal(back[1]?.events?.some((e) => e.kind === 'tool_call' && e.callId === 'c1'), true);
    assert.equal(back[1]?.events?.some((e) => e.kind === 'tool_result' && e.callId === 'c1'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('importTurnsToPi：真实 usage 写入 assistant message.usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tongbu-pi-usage-'));
  try {
    const turns: UnifiedTurn[] = [
      { role: 'user', text: '跑一下', timestamp: '2026-08-21T06:00:00.000Z', provider: 'pi' },
      {
        role: 'assistant',
        text: '好',
        timestamp: '2026-08-21T06:00:01.000Z',
        provider: 'pi',
        usage: { inputTokens: 800, outputTokens: 50 },
      },
    ];
    const ref = await importTurnsToPi(turns, '/proj/usage', undefined, undefined, root);
    const raw = readFileSync(ref.filePath, 'utf8');
    const assistantMsgs = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === 'message' && r.message?.role === 'assistant')
      .map((r) => r.message.usage);
    assert.equal(assistantMsgs.length, 1);
    assert.equal(assistantMsgs[0].input, 800);
    assert.equal(assistantMsgs[0].output, 50);
    assert.equal(typeof assistantMsgs[0].cost?.total, 'number');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
