import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLatestClaudeSession } from '../src/providers/claude/index.js';
import { findLatestCodexRollout } from '../src/providers/codex/index.js';
import { chainStatus, chainUsage, diffTurns, handoff, pairedRef } from '../src/core/handoff.js';
import { Store } from '../src/core/store.js';
import type { ProviderAdapter } from '../src/providers/adapter.js';
import type { SessionRef, UnifiedTurn } from '../src/core/types.js';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';

function touch(filePath: string, mtimeSec: number): void {
  utimesSync(filePath, mtimeSec, mtimeSec);
}

test('findLatestClaudeSession: mtime 最新 uuid 胜出，非法名忽略，空目录 null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tongbu-claude-'));
  const cwd = '/proj/demo';
  const projectDir = join(root, '-proj-demo');
  mkdirSync(projectDir, { recursive: true });
  try {
    assert.equal(await findLatestClaudeSession(cwd, root), null);

    const older = join(projectDir, `${UUID_A}.jsonl`);
    const newer = join(projectDir, `${UUID_B}.jsonl`);
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    writeFileSync(join(projectDir, 'agent-not-a-session.jsonl'), '{}\n');
    touch(older, 1_700_000_000);
    touch(newer, 1_700_000_100);
    touch(join(projectDir, 'agent-not-a-session.jsonl'), 1_700_000_999);

    const found = await findLatestClaudeSession(cwd, root);
    assert.ok(found);
    assert.equal(found.ref.sessionId, UUID_B);
    assert.equal(found.ref.provider, 'claude');
    assert.equal(found.ref.cwd, cwd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLatestCodexRollout: 其它 cwd 的更新文件不得胜出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tongbu-codex-'));
  const cwd = '/proj/demo';
  const other = '/proj/other';
  const day = join(root, '2026', '08', '21');
  mkdirSync(day, { recursive: true });
  try {
    const meta = (id: string, dir: string) =>
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: dir, id, session_id: id },
      }) + '\n';

    const ours = join(day, `rollout-2026-08-21T10-00-00-${UUID_A}.jsonl`);
    const theirsNewer = join(day, `rollout-2026-08-21T12-00-00-${UUID_B}.jsonl`);
    const oursNewer = join(day, `rollout-2026-08-21T11-00-00-${UUID_C}.jsonl`);
    writeFileSync(ours, meta(UUID_A, cwd));
    writeFileSync(theirsNewer, meta(UUID_B, other));
    writeFileSync(oursNewer, meta(UUID_C, cwd));
    touch(ours, 1_700_000_000);
    touch(theirsNewer, 1_700_000_300); // 全局最新但 cwd 不对
    touch(oursNewer, 1_700_000_200);

    const found = await findLatestCodexRollout(cwd, root);
    assert.ok(found);
    assert.equal(found.ref.sessionId, UUID_C);
    assert.equal(found.ref.provider, 'codex');
    assert.equal(found.ref.cwd, cwd);

    assert.equal(await findLatestCodexRollout('/none', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLatestCodexRollout: 只读首行 cwd，旧日期目录仍能命中', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tongbu-codex-old-'));
  const cwd = '/proj/demo';
  const oldDay = join(root, '2024', '01', '02');
  mkdirSync(oldDay, { recursive: true });
  try {
    const id = UUID_A;
    const file = join(oldDay, `rollout-2024-01-02T10-00-00-${id}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({ type: 'session_meta', payload: { cwd, id, session_id: id } }) +
        '\n' +
        '{"type":"event","payload":{"huge":"' +
        'x'.repeat(8000) +
        '"}}\n',
    );
    const found = await findLatestCodexRollout(cwd, root);
    assert.ok(found);
    assert.equal(found.ref.sessionId, id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stubAdapter(id: string, tip: { ref: SessionRef; updatedAt: number } | null, turns?: UnifiedTurn[]): ProviderAdapter {
  return {
    id,
    displayName: id,
    async detect() {
      return true;
    },
    async parse() {
      return turns ?? [
        { role: 'user', text: 'u', timestamp: '2026-08-21T00:00:00.000Z' },
        { role: 'assistant', text: 'a', timestamp: '2026-08-21T00:00:01.000Z', provider: id },
      ];
    },
    async importTurns(_t, cwd, into) {
      if (into) return into;
      return { provider: id, sessionId: `${id}-new`, filePath: `/tmp/${id}-new.jsonl`, cwd };
    },
    async start() {
      throw new Error('unused');
    },
    async send() {
      throw new Error('unused');
    },
    async findLatestSession() {
      return tip;
    },
    resumeCommand(r) {
      return `${id} resume ${r.sessionId}`;
    },
  };
}

test('handoff: 链尾判定、无需切换、recordSwitch', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const claudeRef: SessionRef = {
    provider: 'claude',
    sessionId: 'c1',
    filePath: '/tmp/c1.jsonl',
    cwd,
  };
  const codexRef: SessionRef = {
    provider: 'codex',
    sessionId: 'x1',
    filePath: '/tmp/x1.jsonl',
    cwd,
  };
  const adapters = [
    stubAdapter('claude', { ref: claudeRef, updatedAt: 100 }),
    stubAdapter('codex', { ref: codexRef, updatedAt: 50 }),
  ];
  const resolve = (id: string) => adapters.find((a) => a.id === id);

  // 无历史时 chainTip 为空，游离会话不参与链尾判定
  let status = await chainStatus(cwd, adapters, store);
  assert.equal(status.chainTip, null);
  assert.equal(status.tips.length, 2);
  assert.ok(status.tips.every((t) => !t.onChain));

  // 先手动建立链：claude 为起点
  const chainId = store.getOrCreateChainSession(cwd);
  store.recordSwitch(chainId, null, null, 'claude', claudeRef);

  status = await chainStatus(cwd, adapters, store);
  assert.equal(status.chainTip?.provider, 'claude');

  const already = await handoff('claude', cwd, adapters, resolve, store);
  // 目标 session 已是最新，无需追加增量，但用户主动切回仍会记录 switch 并 rewrite 目标 session
  assert.equal(already.fromProvider, 'codex');
  assert.equal(already.turnCount, 0);
  assert.equal(already.newRef.sessionId, 'c1');

  // 切回 codex：codex 已在链上且内容与 claude 相同，无需追加增量，复用原 ref 并 rewrite
  const result = await handoff('codex', cwd, adapters, resolve, store);
  assert.equal(result.fromProvider, 'claude');
  assert.equal(result.newRef.sessionId, 'x1');
  assert.equal(result.turnCount, 0);
  assert.match(result.resumeCommand, /codex resume/);

  const hist = store.listSwitchEvents(chainId);
  // 手动 null→claude + 自动 codex→claude（already） + 自动 claude→codex（already）
  assert.equal(hist.length, 3);
  assert.equal(hist[1].fromProvider, 'codex');
  assert.equal(hist[1].toProvider, 'claude');
  assert.equal(hist[2].fromProvider, 'claude');
  assert.equal(hist[2].toProvider, 'codex');
});

test('diffTurns: 去掉 dest 已有子序列，只留增量', () => {
  const u = (text: string): UnifiedTurn => ({ role: 'user', text, timestamp: '' });
  const a = (text: string): UnifiedTurn => ({ role: 'assistant', text, timestamp: '' });
  assert.deepEqual(
    diffTurns([u('1'), a('2'), u('3'), a('4')], [u('1'), a('2')]).map((t) => t.text),
    ['3', '4'],
  );
  assert.deepEqual(diffTurns([u('1'), a('2')], [u('1'), a('2')]), []);
  assert.deepEqual(diffTurns([u('1')], []).map((t) => t.text), ['1']);
});

test('handoff: 第二次切回追加配对会话，不新建', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const claudeRef: SessionRef = { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd };
  const codexRef: SessionRef = { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd };
  const base: UnifiedTurn[] = [
    { role: 'user', text: 'u1', timestamp: '2026-08-21T00:00:00.000Z' },
    { role: 'assistant', text: 'a1', timestamp: '2026-08-21T00:00:01.000Z', provider: 'claude' },
  ];
  const grown: UnifiedTurn[] = [
    ...base,
    { role: 'user', text: 'u2', timestamp: '2026-08-21T00:00:02.000Z' },
    { role: 'assistant', text: 'a2', timestamp: '2026-08-21T00:00:03.000Z', provider: 'codex' },
  ];
  const imported: { id: string; turns: UnifiedTurn[]; into?: SessionRef }[] = [];
  const mk = (
    id: string,
    tip: { ref: SessionRef; updatedAt: number },
    parseTurns: UnifiedTurn[],
  ): ProviderAdapter => ({
    id,
    displayName: id,
    async detect() {
      return true;
    },
    async parse(ref) {
      if (ref.sessionId === claudeRef.sessionId) return base;
      if (ref.sessionId === 'codex-new' || ref.sessionId === codexRef.sessionId) return parseTurns;
      return parseTurns;
    },
    async importTurns(turns, dir, into) {
      imported.push({ id, turns, into });
      if (into) return into;
      return { provider: id, sessionId: `${id}-new`, filePath: `/tmp/${id}-new.jsonl`, cwd: dir };
    },
    async start() {
      throw new Error('unused');
    },
    async send() {
      throw new Error('unused');
    },
    async findLatestSession() {
      return tip;
    },
    resumeCommand(r) {
      return `${id} resume ${r.sessionId}`;
    },
  });

  const first = [mk('claude', { ref: claudeRef, updatedAt: 200 }, base), mk('codex', { ref: codexRef, updatedAt: 50 }, base)];
  const resolve = (id: string) => first.find((a) => a.id === id);
  const created = await handoff('codex', cwd, first, resolve, store);
  assert.equal(created.newRef.sessionId, 'codex-new');
  assert.ok(!imported[0]?.into);

  const hist0 = store.listSwitchEvents(store.getOrCreateChainSession(cwd));
  assert.equal(pairedRef(hist0, 'claude')?.sessionId, 'c1');
  assert.equal(pairedRef(hist0, 'codex')?.sessionId, 'codex-new');

  const second = [
    mk('claude', { ref: claudeRef, updatedAt: 100 }, base),
    mk('codex', { ref: created.newRef, updatedAt: 300 }, grown),
  ];
  const resolve2 = (id: string) => second.find((a) => a.id === id);
  const back = await handoff('claude', cwd, second, resolve2, store);
  assert.equal(back.newRef.sessionId, 'c1');
  assert.equal(back.turnCount, 2);
  const appendCall = imported[1];
  assert.ok(appendCall);
  assert.equal(appendCall.into?.sessionId, 'c1');
  assert.deepEqual(
    appendCall.turns.map((t) => t.text),
    ['u2', 'a2'],
  );
});

test('handoff: 链尾已在目标但对方有增量时仍追加', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const claudeRef: SessionRef = { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd };
  const codexRef: SessionRef = { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd };
  const base: UnifiedTurn[] = [
    { role: 'user', text: 'u1', timestamp: '2026-08-21T00:00:00.000Z' },
    { role: 'assistant', text: 'a1', timestamp: '2026-08-21T00:00:01.000Z', provider: 'claude' },
  ];
  const grown: UnifiedTurn[] = [
    ...base,
    { role: 'assistant', text: '探查结果', timestamp: '2026-08-21T00:00:04.000Z', provider: 'codex' },
  ];
  const imported: { turns: UnifiedTurn[]; into?: SessionRef }[] = [];
  const adapters: ProviderAdapter[] = [
    {
      id: 'claude',
      displayName: 'claude',
      async detect() {
        return true;
      },
      async parse() {
        return base;
      },
      async importTurns(turns, dir, into) {
        imported.push({ turns, into });
        return into ?? { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd: dir };
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return { ref: claudeRef, updatedAt: 300 };
      },
      resumeCommand(r) {
        return `claude resume ${r.sessionId}`;
      },
    },
    {
      id: 'codex',
      displayName: 'codex',
      async detect() {
        return true;
      },
      async parse() {
        return grown;
      },
      async importTurns(_t, dir) {
        return { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd: dir };
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return { ref: codexRef, updatedAt: 100 };
      },
      resumeCommand(r) {
        return `codex resume ${r.sessionId}`;
      },
    },
  ];
  const resolve = (id: string) => adapters.find((a) => a.id === id);
  const result = await handoff('claude', cwd, adapters, resolve, store);
  assert.equal(result.fromProvider, 'codex');
  assert.equal(result.newRef.sessionId, 'c1');
  assert.deepEqual(imported[0]?.turns.map((t) => t.text), ['探查结果']);
});

test('handoff: dest 文本相同但缺过程事件时 replace 同一会话', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const claudeRef: SessionRef = { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd };
  const codexRef: SessionRef = { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd };
  const simple: UnifiedTurn[] = [
    { role: 'user', text: '跑一下', timestamp: '2026-08-21T00:00:00.000Z' },
    { role: 'assistant', text: '调用完成', timestamp: '2026-08-21T00:00:01.000Z', provider: 'codex' },
  ];
  const rich: UnifiedTurn[] = [
    simple[0],
    {
      ...simple[1],
      provider: 'claude',
      events: [
        {
          kind: 'tool_call',
          summary: 'Bash: pwd',
          detail: '{"command":"pwd"}',
          timestamp: '2026-08-21T00:00:01.000Z',
          provider: 'claude',
          name: 'Bash',
          callId: 'c1',
          input: { command: 'pwd' },
        },
      ],
    },
  ];
  const imported: { turns: UnifiedTurn[]; into?: SessionRef; opts?: { replace?: boolean } }[] = [];
  store.recordSwitch(store.getOrCreateChainSession(cwd), 'claude', claudeRef, 'codex', codexRef);
  const adapters: ProviderAdapter[] = [
    {
      id: 'claude',
      displayName: 'claude',
      async detect() {
        return true;
      },
      async parse() {
        return rich;
      },
      async importTurns() {
        throw new Error('unused');
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return { ref: claudeRef, updatedAt: 200 };
      },
      resumeCommand(r) {
        return `claude resume ${r.sessionId}`;
      },
    },
    {
      id: 'codex',
      displayName: 'codex',
      async detect() {
        return true;
      },
      async parse() {
        return simple;
      },
      async importTurns(turns, dir, into, opts) {
        imported.push({ turns, into, opts });
        return into ?? { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd: dir };
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return { ref: codexRef, updatedAt: 50 };
      },
      resumeCommand(r) {
        return `codex resume ${r.sessionId}`;
      },
    },
  ];
  const resolve = (id: string) => adapters.find((a) => a.id === id);
  const result = await handoff('codex', cwd, adapters, resolve, store);
  assert.equal(result.newRef.sessionId, 'x1');
  assert.equal(imported[0]?.into?.sessionId, 'x1');
  assert.equal(imported[0]?.opts?.replace, true);
  assert.equal(imported[0]?.turns[1]?.events?.[0].kind, 'tool_call');
});

test('handoff: dest 中间多一轮仍能把最后一轮过程事件叠回去', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const claudeRef: SessionRef = { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd };
  const codexRef: SessionRef = { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd };
  const extra: UnifiedTurn = {
    role: 'assistant',
    text: '探查结果',
    timestamp: '2026-08-21T00:00:01.500Z',
    provider: 'codex',
    events: [
      {
        kind: 'tool_call',
        summary: 'exec: pwd',
        detail: 'pwd',
        timestamp: '2026-08-21T00:00:01.500Z',
        provider: 'codex',
        name: 'exec',
        callId: 'x',
      },
    ],
  };
  const dest: UnifiedTurn[] = [
    { role: 'user', text: '跑一下', timestamp: '2026-08-21T00:00:00.000Z' },
    extra,
    { role: 'assistant', text: '调用完成', timestamp: '2026-08-21T00:00:02.000Z', provider: 'codex' },
  ];
  const source: UnifiedTurn[] = [
    dest[0],
    {
      role: 'assistant',
      text: '调用完成',
      timestamp: '2026-08-21T00:00:02.000Z',
      provider: 'claude',
      events: [
        {
          kind: 'tool_call',
          summary: 'Bash: ls',
          detail: '{"command":"ls"}',
          timestamp: '2026-08-21T00:00:02.000Z',
          provider: 'claude',
          name: 'Bash',
          callId: 'c1',
          input: { command: 'ls' },
        },
      ],
    },
  ];
  const imported: { turns: UnifiedTurn[]; opts?: { replace?: boolean } }[] = [];
  store.recordSwitch(store.getOrCreateChainSession(cwd), 'claude', claudeRef, 'codex', codexRef);
  const adapters: ProviderAdapter[] = [
    {
      id: 'claude',
      displayName: 'claude',
      async detect() {
        return true;
      },
      async parse() {
        return source;
      },
      async importTurns() {
        throw new Error('unused');
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return { ref: claudeRef, updatedAt: 200 };
      },
      resumeCommand(r) {
        return `claude resume ${r.sessionId}`;
      },
    },
    {
      id: 'codex',
      displayName: 'codex',
      async detect() {
        return true;
      },
      async parse() {
        return dest;
      },
      async importTurns(turns, dir, into, opts) {
        imported.push({ turns, opts });
        return into ?? { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd: dir };
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return { ref: codexRef, updatedAt: 50 };
      },
      resumeCommand(r) {
        return `codex resume ${r.sessionId}`;
      },
    },
  ];
  const resolve = (id: string) => adapters.find((a) => a.id === id);
  await handoff('codex', cwd, adapters, resolve, store);
  assert.equal(imported[0]?.opts?.replace, true);
  assert.deepEqual(
    imported[0]?.turns.map((t) => t.text),
    ['跑一下', '探查结果', '调用完成'],
  );
  assert.equal(imported[0]?.turns[1]?.events?.[0].name, 'exec');
  assert.equal(imported[0]?.turns[2]?.events?.[0].name, 'Bash');
});

test('cli --json status 形状可用（子进程）', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    'npx',
    ['tsx', 'src/cli.ts', 'status', '--json', '--cwd', process.cwd()],
    { encoding: 'utf8', cwd: process.cwd() },
  );
  const line = (r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  assert.ok(line, `stdout 无 JSON: ${r.stdout} / ${r.stderr}`);
  const data = JSON.parse(line) as { tips: unknown[]; history: unknown[]; chains: unknown[] };
  assert.ok(Array.isArray(data.tips));
  assert.ok(Array.isArray(data.history));
  assert.ok(Array.isArray(data.chains));
});

test('cli chain new/list --json 走独立 TONG_DB', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'tongbu-cli-chain-'));
  const db = join(dir, 't.db');
  const env = { ...process.env, TONG_DB: db };
  try {
    const created = spawnSync(
      'npx',
      ['tsx', 'src/cli.ts', 'chain', 'new', '修 bug', '--json', '--cwd', '/proj'],
      { encoding: 'utf8', cwd: process.cwd(), env },
    );
    const createdLine = (created.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    assert.ok(createdLine, created.stderr);
    const createdJson = JSON.parse(createdLine) as { ok: boolean; chain: { name: string } };
    assert.equal(createdJson.ok, true);
    assert.equal(createdJson.chain.name, '修 bug');

    const listed = spawnSync(
      'npx',
      ['tsx', 'src/cli.ts', 'chain', 'list', '--json', '--cwd', '/proj'],
      { encoding: 'utf8', cwd: process.cwd(), env },
    );
    const listedLine = (listed.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    assert.ok(listedLine);
    const listedJson = JSON.parse(listedLine) as { chains: { name: string }[] };
    assert.equal(listedJson.chains.length, 1);
    assert.equal(listedJson.chains[0].name, '修 bug');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff: 同 cwd 两条链 switch 互不串线', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const claudeRef: SessionRef = { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd };
  const codexRef: SessionRef = { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd };
  const adapters = [
    stubAdapter('claude', { ref: claudeRef, updatedAt: 100 }),
    stubAdapter('codex', { ref: codexRef, updatedAt: 50 }),
  ];
  const resolve = (id: string) => adapters.find((a) => a.id === id);
  const bug = store.createChain(cwd, '修 bug');
  const feat = store.createChain(cwd, '写新功能');
  await handoff('codex', cwd, adapters, resolve, store, { chainId: bug.id });
  await handoff('codex', cwd, adapters, resolve, store, { chainId: feat.id });
  assert.equal(store.listSwitchEvents(bug.id).length, 1);
  assert.equal(store.listSwitchEvents(feat.id).length, 1);
  assert.notEqual(store.listSwitchEvents(bug.id)[0].id, store.listSwitchEvents(feat.id)[0].id);
  const stBug = await chainStatus(cwd, adapters, store, bug.id);
  const stFeat = await chainStatus(cwd, adapters, store, feat.id);
  assert.equal(stBug.chain?.name, '修 bug');
  assert.equal(stFeat.chain?.name, '写新功能');
  assert.equal(stBug.history.length, 1);
  assert.equal(stFeat.history.length, 1);
});

test('store: getOrCreateChainSession 幂等；loadLatestSession 排除 tui-chain', () => {
  const store = new Store(':memory:');
  const a = store.getOrCreateChainSession('/a/b');
  const b = store.getOrCreateChainSession('/a/b');
  assert.equal(a, b);
  assert.equal(store.loadLatestSession('/a/b'), null);

  const web = store.createSession(
    '/a/b',
    'claude',
    { provider: 'claude', sessionId: 's', filePath: '/tmp/s.jsonl', cwd: '/a/b' },
    [
      { role: 'user', text: '问', timestamp: '2026-08-21T00:00:00.000Z' },
      { role: 'assistant', text: '答', timestamp: '2026-08-21T00:00:01.000Z', provider: 'claude' },
    ],
  );
  // 再碰一下 chain，updated_at 更新后仍不应盖过 web 会话的筛选
  store.getOrCreateChainSession('/a/b');
  assert.equal(store.loadLatestSession('/a/b')?.id, web);
});

test('diffTurns: 空 text 的 tool 回合按 callId 对齐，不误配导致重复导入', () => {
  const tool = (callId: string): UnifiedTurn => ({
    role: 'assistant',
    text: '',
    timestamp: '',
    events: [
      { kind: 'tool_call', summary: 'Bash: pwd', detail: 'pwd', timestamp: '', provider: 'claude', name: 'Bash', callId },
    ],
  });
  const source = [tool('c1'), tool('c2'), tool('c3')];
  const dest = [tool('c1'), tool('c3')];
  assert.deepEqual(diffTurns(source, dest).map((t) => t.events?.[0].callId), ['c2']);
});

test('chainUsage：两条链用量互不串', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const bug = store.createChain(cwd, '修 bug');
  const feat = store.createChain(cwd, '写新功能');

  const claudeBugRef: SessionRef = { provider: 'claude', sessionId: 'c-bug', filePath: '/tmp/c-bug.jsonl', cwd };
  const claudeFeatRef: SessionRef = { provider: 'claude', sessionId: 'c-feat', filePath: '/tmp/c-feat.jsonl', cwd };
  const codexBugRef: SessionRef = { provider: 'codex', sessionId: 'x-bug', filePath: '/tmp/x-bug.jsonl', cwd };
  const codexFeatRef: SessionRef = { provider: 'codex', sessionId: 'x-feat', filePath: '/tmp/x-feat.jsonl', cwd };

  // 直接构造 switch_events，不依赖 handoff 的增量逻辑
  store.recordSwitch(bug.id, null, { provider: 'claude', sessionId: 'init', filePath: '/tmp/init.jsonl', cwd }, 'codex', codexBugRef);
  store.recordSwitch(bug.id, 'codex', codexBugRef, 'claude', claudeBugRef);
  store.recordSwitch(feat.id, null, { provider: 'claude', sessionId: 'init', filePath: '/tmp/init.jsonl', cwd }, 'codex', codexFeatRef);
  store.recordSwitch(feat.id, 'codex', codexFeatRef, 'claude', claudeFeatRef);

  const mk = (id: string, usageBySession: Record<string, { input: number; output: number } | null>): ProviderAdapter => ({
    id,
    displayName: id,
    async detect() {
      return true;
    },
    async parse() {
      return [];
    },
    async importTurns(_t, dir, into) {
      return into ?? { provider: id, sessionId: `${id}-new`, filePath: `/tmp/${id}-new.jsonl`, cwd: dir };
    },
    async start() {
      throw new Error('unused');
    },
    async send() {
      throw new Error('unused');
    },
    async findLatestSession() {
      return null;
    },
    async sessionUsage(ref) {
      const u = usageBySession[ref.sessionId];
      if (u === null || u === undefined) return null;
      return { inputTokens: u.input, outputTokens: u.output };
    },
    resumeCommand(r) {
      return `${id} resume ${r.sessionId}`;
    },
  });

  const bugAdapters = [
    mk('claude', { 'c-bug': { input: 10, output: 5 } }),
    mk('codex', { 'x-bug': { input: 20, output: 8 } }),
  ];
  const featAdapters = [
    mk('claude', { 'c-feat': { input: 1, output: 1 } }),
    mk('codex', { 'x-feat': { input: 20, output: 8 } }),
  ];

  const bugUsage = await chainUsage(cwd, bugAdapters, store, bug.id);
  const featUsage = await chainUsage(cwd, featAdapters, store, feat.id);

  assert.deepEqual(bugUsage.total, { inputTokens: 30, outputTokens: 13 });
  assert.deepEqual(featUsage.total, { inputTokens: 21, outputTokens: 9 });
});

test('chainUsage：无 usage 字段总量为 0 且不报错', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const chain = store.createChain(cwd, 'default');
  const claudeRef: SessionRef = { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd };
  const codexRef: SessionRef = { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd };
  store.recordSwitch(chain.id, null, { provider: 'claude', sessionId: 'init', filePath: '/tmp/init.jsonl', cwd }, 'codex', codexRef);
  store.recordSwitch(chain.id, 'codex', codexRef, 'claude', claudeRef);

  const adapters: ProviderAdapter[] = [
    {
      id: 'claude',
      displayName: 'claude',
      async detect() {
        return true;
      },
      async parse() {
        return [];
      },
      async importTurns(_t, dir, into) {
        return into ?? { provider: 'claude', sessionId: 'c-new', filePath: '/tmp/c-new.jsonl', cwd: dir };
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return null;
      },
      async sessionUsage() {
        return null;
      },
      resumeCommand(r) {
        return `claude resume ${r.sessionId}`;
      },
    },
    {
      id: 'codex',
      displayName: 'codex',
      async detect() {
        return true;
      },
      async parse() {
        return [];
      },
      async importTurns(_t, dir, into) {
        return into ?? { provider: 'codex', sessionId: 'x-new', filePath: '/tmp/x-new.jsonl', cwd: dir };
      },
      async start() {
        throw new Error('unused');
      },
      async send() {
        throw new Error('unused');
      },
      async findLatestSession() {
        return null;
      },
      async sessionUsage() {
        return null;
      },
      resumeCommand(r) {
        return `codex resume ${r.sessionId}`;
      },
    },
  ];

  const result = await chainUsage(cwd, adapters, store, chain.id);
  assert.deepEqual(result.total, { inputTokens: 0, outputTokens: 0 });
  assert.equal(result.byProvider.length, 2);
  assert.ok(result.byProvider.every((p) => p.usage === null));
});

test('handoff 链绑定：同目录游离的新会话不参与切换', async () => {
  const store = new Store(':memory:');
  const cwd = '/a/b';
  const boundClaude: SessionRef = { provider: 'claude', sessionId: 'c1', filePath: '/tmp/c1.jsonl', cwd };
  const strayClaude: SessionRef = { provider: 'claude', sessionId: 'c2-stray', filePath: '/tmp/c2.jsonl', cwd };
  const codexRef: SessionRef = { provider: 'codex', sessionId: 'x1', filePath: '/tmp/x1.jsonl', cwd };

  const mk = (
    id: string,
    tip: { ref: SessionRef; updatedAt: number },
    turnsBySession: Record<string, UnifiedTurn[]>,
  ): ProviderAdapter => ({
    id,
    displayName: id,
    async detect() {
      return true;
    },
    async parse(ref) {
      return turnsBySession[ref.sessionId] ?? [];
    },
    async importTurns(turns, dir, into) {
      imported.push({ turns, into });
      if (into) return into;
      return { provider: id, sessionId: `${id}-new`, filePath: `/tmp/${id}-new.jsonl`, cwd: dir };
    },
    async start() {
      throw new Error('unused');
    },
    async send() {
      throw new Error('unused');
    },
    async findLatestSession() {
      return tip;
    },
    resumeCommand(r) {
      return `${id} resume ${r.sessionId}`;
    },
  });
  const imported: { turns: UnifiedTurn[]; into?: SessionRef }[] = [];

  const boundTurns: UnifiedTurn[] = [
    { role: 'user', text: 'bound-u1', timestamp: '2026-08-21T00:00:00.000Z' },
  ];
  const adapters = [
    // 游离会话 mtime 更新，但不在链上，不得成为 source
    mk('claude', { ref: strayClaude, updatedAt: 999 }, { c1: boundTurns, 'c2-stray': [{ role: 'user', text: 'stray', timestamp: '' }] }),
    mk('codex', { ref: { ...codexRef, sessionId: 'codex-new' }, updatedAt: 100 }, { 'codex-new': [] }),
  ];
  const resolve = (id: string) => adapters.find((a) => a.id === id);

  // 先建立链：c1 → x1
  const claudeOnly = [
    mk('claude', { ref: boundClaude, updatedAt: 100 }, { c1: boundTurns }),
    mk('codex', { ref: codexRef, updatedAt: 50 }, {}),
  ];
  await handoff('codex', cwd, claudeOnly, (id) => claudeOnly.find((a) => a.id === id), store);

  // 游离会话出现后再 switch：source 必须仍是绑定的 c1
  const result = await handoff('codex', cwd, adapters, resolve, store);
  assert.equal(result.fromProvider, 'claude');
  assert.deepEqual(result.turnCount >= 0, true);
  const lastImport = imported.at(-1)!;
  assert.equal(lastImport.into?.sessionId, 'codex-new');
  assert.ok(lastImport.turns.every((t) => t.text !== 'stray'));

  // status 标记链上/游离
  const status = await chainStatus(cwd, adapters, store);
  const flags = Object.fromEntries(status.tips.map((t) => [t.ref.sessionId, t.onChain]));
  assert.equal(flags['codex-new'], true);
  assert.equal(flags['c2-stray'], false);
});
