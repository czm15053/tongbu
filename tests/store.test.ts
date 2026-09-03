import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHAIN_SESSION_TITLE, Store } from '../src/core/store.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../src/core/types.js';

const ref = (provider: string, id = 's1'): SessionRef => ({
  provider,
  sessionId: id,
  filePath: `/tmp/${provider}-${id}.jsonl`,
  cwd: '/a/b',
});

const turn = (role: 'user' | 'assistant', text: string, provider?: string, seq = 0): UnifiedTurn => ({
  role,
  text,
  timestamp: `2026-08-21T06:00:0${seq}.000Z`,
  ...(provider ? { provider } : {}),
});

const evt = (summary: string): ProcessEvent => ({
  kind: 'tool_call',
  summary,
  timestamp: '2026-08-21T06:00:01.000Z',
  provider: 'claude',
});

test('store: createSession + loadLatestSession 按 cwd 过滤取最新', () => {
  const store = new Store(':memory:');
  store.createSession('/a/b', 'claude', ref('claude'), [turn('user', '第一问'), turn('assistant', '第一答', 'claude')]);
  const other = store.createSession('/x/y', 'codex', ref('codex', 's2'), [turn('user', '别的项目'), turn('assistant', '答', 'codex')]);
  assert.equal(store.loadLatestSession('/x/y')?.id, other);
  const s = store.loadLatestSession('/a/b');
  assert.ok(s);
  assert.equal(s.provider, 'claude');
  assert.equal(s.title, '第一问');
  assert.deepEqual(s.ref, ref('claude'));
  assert.equal(s.nextSeq, 2);
  assert.equal(store.loadLatestSession('/none'), null);
});

test('store: appendTurns 推进 seq，loadTurns 保序，事件按 turn_seq 分组', () => {
  const store = new Store(':memory:');
  const id = store.createSession('/a/b', 'claude', ref('claude'), [turn('user', '问1'), turn('assistant', '答1', 'claude')], [evt('Bash: ls')]);
  store.appendTurns(id, [turn('user', '问2', undefined, 2), turn('assistant', '答2', 'claude', 3)], [evt('Read: a.ts'), evt('Grep: foo')]);
  const turns = store.loadTurns(id);
  assert.deepEqual(turns.map((t) => t.text), ['问1', '答1', '问2', '答2']);
  const events = store.loadEventsByTurn(id);
  assert.deepEqual(Object.keys(events).sort(), ['1', '3']);
  assert.equal(events[1][0].summary, 'Bash: ls');
  assert.equal(events[3].length, 2);
  assert.equal(store.loadLatestSession('/a/b')?.nextSeq, 4);
});

test('store: recordSwitch 记审计并更新当前指向', () => {
  const store = new Store(':memory:');
  const id = store.createSession('/a/b', 'claude', ref('claude'), [turn('user', '问'), turn('assistant', '答', 'claude')]);
  store.recordSwitch(id, 'claude', ref('claude'), 'codex', ref('codex', 'imported'));
  const s = store.loadLatestSession('/a/b');
  assert.equal(s?.provider, 'codex');
  assert.deepEqual(s?.ref, ref('codex', 'imported'));
});

test('store: 迁移幂等——同库重开不报错、数据保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tongbu-store-'));
  const dbPath = join(dir, 't.db');
  try {
    const s1 = new Store(dbPath);
    s1.createSession('/a/b', 'claude', ref('claude'), [turn('user', '问'), turn('assistant', '答', 'claude')]);
    const s2 = new Store(dbPath); // 重开同一文件，迁移应幂等
    assert.equal(s2.loadLatestSession('/a/b')?.title, '问');
    assert.equal(s2.loadTurns(s2.loadLatestSession('/a/b')!.id).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store v2: 同 cwd 多链、重名拒绝、禁止归档最后一条', () => {
  const store = new Store(':memory:');
  const a = store.createChain('/proj', '修 bug');
  const b = store.createChain('/proj', '写新功能');
  assert.notEqual(a.id, b.id);
  assert.equal(store.listChains('/proj').length, 2);
  assert.equal(store.findActiveChain('/proj', '修 bug')?.id, a.id);
  store.touchChain(b.id);
  assert.equal(store.findActiveChain('/proj')?.id, b.id);
  assert.throws(() => store.createChain('/proj', '修 bug'), /链名已存在/);
  store.archiveChain(a.id);
  assert.equal(store.findActiveChain('/proj')?.id, b.id);
  assert.equal(store.listChains('/proj').filter((c) => c.status === 'active').length, 1);
  assert.throws(() => store.archiveChain(b.id), /最后一条/);
  assert.throws(() => store.getOrCreateChainSession('/proj', a.id), /已归档/);
});

test('store v2: 旧 tui-chain 迁为默认链且 switch_events 仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tongbu-v1-'));
  const dbPath = join(dir, 't.db');
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL,
        provider TEXT, ref_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, provider TEXT, ts TEXT NOT NULL,
        meta_json TEXT, UNIQUE (session_id, seq)
      );
      CREATE TABLE switch_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_provider TEXT, to_provider TEXT NOT NULL, from_ref TEXT, to_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE turn_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, ts TEXT NOT NULL
      );
    `);
    const chainId = 'chain-old';
    raw.prepare(
      'INSERT INTO sessions (id, title, cwd, provider, ref_json, created_at, updated_at, next_seq) VALUES (?,?,?,?,NULL,?,?,0)',
    ).run(chainId, CHAIN_SESSION_TITLE, '/old', null, 1, 2);
    raw.prepare(
      'INSERT INTO switch_events (id, session_id, from_provider, to_provider, from_ref, to_ref, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      'ev1',
      chainId,
      'claude',
      'codex',
      JSON.stringify(ref('claude')),
      JSON.stringify(ref('codex', 'imported')),
      3,
    );
    raw.close();

    const store = new Store(dbPath);
    const chain = store.findActiveChain('/old');
    assert.ok(chain);
    assert.equal(chain.name, '默认');
    assert.equal(chain.id, chainId);
    assert.equal(store.listSwitchEvents(chainId).length, 1);
    assert.equal(store.listSwitchEvents(chainId)[0].toProvider, 'codex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store v3: FTS 中文与代码片段按 cwd 隔离', () => {
  const store = new Store(':memory:');
  store.reindexSession({
    cwd: '/proj/a',
    sessionId: 's1',
    provider: 'claude',
    filePath: '/tmp/s1.jsonl',
    texts: ['修一下登录态过期', 'const token = refresh()'],
  });
  store.reindexSession({
    cwd: '/proj/b',
    sessionId: 's2',
    provider: 'codex',
    filePath: '/tmp/s2.jsonl',
    texts: ['修一下登录态过期'],
  });
  const zh = store.searchMessages('登录态', '/proj/a');
  assert.equal(zh.length, 1);
  assert.equal(zh[0].sessionId, 's1');
  const code = store.searchMessages('refresh()', '/proj/a');
  assert.ok(code.length >= 1);
  const other = store.searchMessages('登录态', '/proj/b');
  assert.equal(other[0].sessionId, 's2');
  assert.equal(store.searchMessages('登录态', '/none').length, 0);
});
