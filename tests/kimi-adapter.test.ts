import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseKimiSession } from '../src/providers/kimi/parse.js';
import {
  buildKimiWireLines,
  encodeKimiWorkspaceDir,
  importTurnsToKimi,
  kimiSessionsRoot,
} from '../src/providers/kimi/build.js';
import { findLatestKimiSession, listKimiSessions } from '../src/providers/kimi/index.js';
import { getAdapter, listAdapters } from '../src/providers/registry.js';
import type { SessionRef, UnifiedTurn } from '../src/core/types.js';

const TS = '2026-08-21T01:00:00.000Z';

const headerLines = () => [
  JSON.stringify({ type: 'metadata', agentId: 'main', payload: { version: '1.5' }, time: 1 }),
  JSON.stringify({ type: 'runtime.set_binding', agentId: 'main', binding: { cwd: '/a/b' }, time: 2 }),
  JSON.stringify({ type: 'profile.bind', agentId: 'main', profile: { id: 'p1' }, time: 3 }),
  JSON.stringify({ type: 'permission.set_mode', agentId: 'main', mode: 'normal', time: 4 }),
];

async function withTempFile(lines: string[], fn: (ref: SessionRef) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-kimi-'));
  const filePath = path.join(dir, 'wire.jsonl');
  await writeFile(filePath, lines.join('\n') + '\n');
  try {
    await fn({ provider: 'kimi', sessionId: 's1', filePath, cwd: '/a/b' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('encodeKimiWorkspaceDir 与 Kimi 目录一致', () => {
  assert.equal(encodeKimiWorkspaceDir('/a/b/c'), 'wd_c_42146b29e39f');
  assert.equal(encodeKimiWorkspaceDir('C:\\x'), 'wd_cx_520186e299d5');
  assert.equal(encodeKimiWorkspaceDir('/home/u/项目 1'), 'wd_1_19ccd4664e1f');
});

test('parse：过滤内部事件，保留 user/assistant/thinking/tools', async () => {
  const lines = [
    ...headerLines(),
    JSON.stringify({
      type: 'turn.prompt',
      agentId: 'main',
      input: [{ type: 'text', text: '你好' }],
      origin: { kind: 'user' },
      time: Date.parse('2026-08-21T01:00:01.000Z'),
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'main',
      event: { type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 },
      time: Date.parse('2026-08-21T01:00:02.000Z'),
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'main',
      event: {
        type: 'content.part',
        uuid: 'u2',
        turnId: '0',
        step: 1,
        part: { type: 'think', think: '想…' },
      },
      time: Date.parse('2026-08-21T01:00:02.100Z'),
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'main',
      event: {
        type: 'tool.call',
        uuid: 'u3',
        turnId: '0',
        step: 1,
        toolCallId: 'c1',
        name: 'Bash',
        args: { command: 'ls' },
      },
      time: Date.parse('2026-08-21T01:00:02.200Z'),
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'main',
      event: {
        type: 'tool.result',
        parentUuid: 'u3',
        turnId: '0',
        step: 1,
        toolCallId: 'c1',
        result: { output: 'file.txt' },
      },
      time: Date.parse('2026-08-21T01:00:02.300Z'),
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      agentId: 'main',
      event: {
        type: 'content.part',
        uuid: 'u4',
        turnId: '0',
        step: 1,
        part: { type: 'text', text: '最终回复' },
      },
      time: Date.parse('2026-08-21T01:00:03.000Z'),
    }),
    JSON.stringify({
      type: 'turn.ended',
      agentId: 'main',
      turnId: 0,
      reason: 'completed',
      time: Date.parse('2026-08-21T01:00:04.000Z'),
    }),
  ];
  await withTempFile(lines, async (ref) => {
    const turns = await parseKimiSession(ref);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].text, '你好');
    assert.equal(turns[1].role, 'assistant');
    assert.equal(turns[1].text, '最终回复');
    assert.equal(turns[1].provider, 'kimi');
    assert.deepEqual(
      turns[1].events?.map((e) => ({ kind: e.kind, name: e.name, callId: e.callId, detail: e.detail })),
      [
        { kind: 'thinking', name: undefined, callId: undefined, detail: '想…' },
        { kind: 'tool_call', name: 'Bash', callId: 'c1', detail: '{"command":"ls"}' },
        { kind: 'tool_result', name: undefined, callId: 'c1', detail: 'file.txt' },
      ],
    );
  });
});

test('buildKimiWireLines：用户消息 + assistant 事件结构完整', () => {
  const turns: UnifiedTurn[] = [
    { role: 'user', text: '问题', timestamp: '2026-08-21T02:00:00.000Z' },
    {
      role: 'assistant',
      text: '回答',
      timestamp: '2026-08-21T02:00:01.000Z',
      provider: 'kimi',
      events: [
        {
          kind: 'thinking',
          summary: '思考中…',
          detail: '先想想',
          timestamp: '2026-08-21T02:00:01.100Z',
          provider: 'kimi',
        },
      ],
    },
  ];
  const lines = buildKimiWireLines(turns, 0).map((l) => JSON.parse(l));
  assert.equal(lines.length, 9);
  assert.equal(lines[0].type, 'turn.prompt');
  assert.equal(lines[0].input[0].text, '问题');
  assert.equal(lines[1].type, 'context.append_message');
  // thinking 在 step 1
  assert.equal(lines[2].event.type, 'step.begin');
  assert.equal(lines[2].event.step, 1);
  assert.equal(lines[3].event.type, 'content.part');
  assert.equal(lines[3].event.part.type, 'think');
  assert.equal(lines[4].event.type, 'step.end');
  assert.equal(lines[4].event.step, 1);
  // 最终文本在独立的 step 2，保证 Kimi TUI 把它排在工具调用之后
  assert.equal(lines[5].event.type, 'step.begin');
  assert.equal(lines[5].event.step, 2);
  assert.equal(lines[6].event.type, 'content.part');
  assert.equal(lines[6].event.part.type, 'text');
  assert.equal(lines[6].event.part.text, '回答');
  assert.equal(lines[7].event.type, 'step.end');
  assert.equal(lines[7].event.step, 2);
  assert.equal(lines[8].type, 'turn.ended');
  assert.equal(lines[8].turnId, 0);
});

test('importTurns → parse round-trip：含 thinking/tool，路径布局正确', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const workspaceId = encodeKimiWorkspaceDir(cwd);
    const sessionId = 'session_test_123';
    const sessionDir = path.join(kimiSessionsRoot(), workspaceId, sessionId);
    const filePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, headerLines().join('\n') + '\n');

    const turns: UnifiedTurn[] = [
      { role: 'user', text: '跑一下', timestamp: '2026-08-21T03:00:00.000Z' },
      {
        role: 'assistant',
        text: '调用完成',
        timestamp: '2026-08-21T03:00:04.000Z',
        provider: 'claude',
        events: [
          {
            kind: 'thinking',
            summary: '先列目录',
            detail: '先列目录再看 git',
            timestamp: '2026-08-21T03:00:01.000Z',
            provider: 'claude',
          },
          {
            kind: 'tool_call',
            summary: 'Bash: pwd',
            detail: '{"command":"pwd && ls -la"}',
            timestamp: '2026-08-21T03:00:02.000Z',
            provider: 'claude',
            name: 'Bash',
            callId: 'call-1',
            input: { command: 'pwd && ls -la', description: 'Show cwd' },
          },
          {
            kind: 'tool_result',
            summary: '工具返回',
            detail: '/a/b\nfile.txt',
            timestamp: '2026-08-21T03:00:03.000Z',
            provider: 'claude',
            callId: 'call-1',
          },
        ],
      },
    ];

    const ref = await importTurnsToKimi(turns, cwd, { provider: 'kimi', sessionId, filePath, cwd }, { replace: true });
    assert.equal(ref.provider, 'kimi');
    assert.equal(ref.sessionId, sessionId);
    assert.equal(ref.filePath, filePath);

    const raw = await readFile(filePath, 'utf8');
    const records = raw.trim().split('\n').map((l) => JSON.parse(l));
    const headerTypes = records.slice(0, 4).map((r) => r.type);
    assert.deepEqual(headerTypes, ['metadata', 'runtime.set_binding', 'profile.bind', 'permission.set_mode']);

    const back = await parseKimiSession(ref);
    assert.equal(back.length, 2);
    assert.equal(back[0].text, '跑一下');
    assert.equal(back[1].text, '调用完成');
    assert.equal(back[1].provider, 'kimi');
    assert.equal(back[1].events?.some((e) => e.kind === 'thinking' && e.detail === '先列目录再看 git'), true);
    assert.equal(back[1].events?.some((e) => e.kind === 'tool_call' && e.name === 'Bash' && e.callId === 'call-1'), true);
    assert.equal(back[1].events?.some((e) => e.kind === 'tool_result' && e.callId === 'call-1' && e.detail === '/a/b\nfile.txt'), true);
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('findLatestKimiSession / listKimiSessions：按 session_index.jsonl 映射', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/proj/demo';
    const workspaceId = encodeKimiWorkspaceDir(cwd);
    const sessionId = 'session_aaa';
    const sessionDir = path.join(kimiSessionsRoot(), workspaceId, sessionId);
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await mkdir(path.dirname(wirePath), { recursive: true });
    await writeFile(wirePath, headerLines().join('\n') + '\n');

    const indexPath = path.join(home, '.kimi-code', 'session_index.jsonl');
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(
      indexPath,
      JSON.stringify({ sessionId, sessionDir, workDir: cwd }) + '\n' +
        JSON.stringify({ sessionId: 'session_other', sessionDir: '/tmp/other', workDir: '/proj/other' }) + '\n',
    );

    const latest = await findLatestKimiSession(cwd);
    assert.ok(latest);
    assert.equal(latest.ref.sessionId, sessionId);
    assert.equal(latest.ref.filePath, wirePath);

    const list = await listKimiSessions(cwd);
    assert.equal(list.length, 1);
    assert.equal(list[0].ref.sessionId, sessionId);
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('registry 注册 Kimi', () => {
  assert.ok(listAdapters().some((a) => a.id === 'kimi'));
  assert.equal(getAdapter('kimi')?.displayName, 'Kimi');
  assert.equal(
    getAdapter('kimi')?.resumeCommand({ provider: 'kimi', sessionId: 'abc', filePath: '/tmp/wire.jsonl', cwd: '/tmp' }),
    'kimi -r abc',
  );
});

test('importTurns：同源时间戳相同时，wire 时间仍严格递增', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const sameTs = '2026-08-21T05:00:00.000Z';
    const turns: UnifiedTurn[] = [
      { role: 'user', text: '问题一', timestamp: sameTs },
      { role: 'assistant', text: '回答一', timestamp: sameTs },
      { role: 'user', text: '问题二', timestamp: sameTs },
      { role: 'assistant', text: '回答二', timestamp: sameTs },
    ];
    const workspaceId = encodeKimiWorkspaceDir(cwd);
    const sessionId = 'session_same_ts';
    const filePath = path.join(kimiSessionsRoot(), workspaceId, sessionId, 'agents', 'main', 'wire.jsonl');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, headerLines().join('\n') + '\n');

    const ref = await importTurnsToKimi(
      turns,
      cwd,
      { provider: 'kimi', sessionId, filePath, cwd },
      { replace: true },
    );
    const raw = await readFile(ref.filePath, 'utf8');
    const records = raw.trim().split('\n').map((l) => JSON.parse(l));
    const turnPromptTimes = records.filter((r) => r.type === 'turn.prompt').map((r) => r.time);
    assert.equal(turnPromptTimes.length, 2);
    assert.ok(turnPromptTimes[1]! > turnPromptTimes[0]!, 'turn 时间戳必须递增');
    const back = await parseKimiSession(ref);
    assert.deepEqual(back.map((t) => t.text), ['问题一', '回答一', '问题二', '回答二']);
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('importTurns：拒绝非绝对路径 cwd', async () => {
  await assert.rejects(() => importTurnsToKimi([], 'relative/path'), /绝对路径/);
});

test('sessionUsage：累加 usage.record（含 cache）', async () => {
  const { kimiSessionUsage } = await import('../src/providers/kimi/index.js');
  await withTempFile(
    [
      JSON.stringify({ type: 'usage.record', usage: { inputOther: 100, output: 50 }, time: 1 }),
      JSON.stringify({
        type: 'usage.record',
        usage: { inputOther: 30, inputCacheRead: 200, inputCacheCreation: 10, output: 20 },
        time: 2,
      }),
      JSON.stringify({ type: 'turn.prompt', input: [], origin: { kind: 'user' }, time: 3 }),
    ],
    async (ref) => {
      const usage = await kimiSessionUsage(ref);
      assert.deepEqual(usage, { inputTokens: 340, outputTokens: 70 });
    },
  );
});

test('sessionUsage：无 usage.record 返回 null', async () => {
  const { kimiSessionUsage } = await import('../src/providers/kimi/index.js');
  await withTempFile([headerLines().join('\n'), JSON.stringify({ type: 'turn.prompt', input: [], origin: { kind: 'user' }, time: 5 })],
    async (ref) => {
      assert.equal(await kimiSessionUsage(ref), null);
    },
  );
});

test('kimiAdapter 挂载 sessionUsage', () => {
  const a = getAdapter('kimi');
  assert.equal(typeof a.sessionUsage, 'function');
});

test('parse：usage.record 事件归入最后一条 assistant 轮', async () => {
  await withTempFile(
    [
      JSON.stringify({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'hi' }], origin: { kind: 'user' }, time: 100 }),
      JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', part: { type: 'text', text: 'hi there' } }, time: 102 }),
      JSON.stringify({ type: 'usage.record', agentId: 'main', usage: { inputOther: 100, inputCacheRead: 50, inputCacheCreation: 0, output: 30 }, time: 103 }),
      JSON.stringify({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed', time: 104 }),
    ],
    async (ref) => {
      const turns = await parseKimiSession(ref);
      assert.equal(turns.length, 2);
      assert.deepEqual(turns[1]!.usage, { inputTokens: 150, outputTokens: 30 });
    },
  );
});

test('usage round-trip：buildKimiWireLines 写入真实用量，再 parse 逐位一致', () => {
  const turns: UnifiedTurn[] = [
    { role: 'user', text: '算一下', timestamp: TS },
    {
      role: 'assistant',
      text: '结果 12',
      timestamp: TS,
      usage: { inputTokens: 900, outputTokens: 75 },
    },
  ];
  const lines = buildKimiWireLines(turns, 0).map((l) => JSON.parse(l));
  const stepEnds = lines
    .filter((l) => l.type === 'context.append_loop_event')
    .map((l) => l.event)
    .filter((e) => e?.type === 'step.end');
  assert.equal(stepEnds.length, 1);
  assert.deepEqual(stepEnds[0].usage, { inputOther: 900, output: 75, inputCacheRead: 0, inputCacheCreation: 0 });

  // 写回文件再反解：step.end.usage 读回 turn.usage
  return (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-kimi-rt-'));
    const filePath = path.join(dir, 'wire.jsonl');
    await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    try {
      const back = await parseKimiSession({ provider: 'kimi', sessionId: 's1', filePath, cwd: '/a/b' });
      assert.deepEqual(back[1]!.usage, { inputTokens: 900, outputTokens: 75 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
});
