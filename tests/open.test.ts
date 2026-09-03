import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePiProjectDir, findPiSessionById } from '../src/providers/pi/index.js';
import { encodeClaudeProjectDir } from '../src/providers/claude/build.js';
import { findClaudeSessionById } from '../src/providers/claude/index.js';
import { findCodexSessionById } from '../src/providers/codex/index.js';
import { findGrokSessionById } from '../src/providers/grok/index.js';
import { findKimiSessionById } from '../src/providers/kimi/index.js';
import { findOpencodeSessionById } from '../src/providers/opencode/build.js';
import { Store } from '../src/core/store.js';
import { buildCdFor, buildCommandFor, resolveById } from '../src/open.js';
import type { ProviderAdapter } from '../src/providers/adapter.js';

const UUID = '461fa5e9-71f1-4bf1-972d-8a41b479905c';

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tongbu-open-'));
  process.on('exit', () => tryRm(dir));
  return dir;
}
function tryRm(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test('claude findById: 跨 cwd 全局反查，cwd 从文件内容读取', async () => {
  const root = tmp();
  const cwd = '/proj/app dir';
  const dir = join(root, encodeClaudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${UUID}.jsonl`), `{"type":"user","cwd":"${cwd}"}\n{"type":"assistant"}\n`);

  const found = await findClaudeSessionById(UUID, root);
  assert.ok(found, '应命中');
  assert.equal(found!.ref.cwd, cwd);
  assert.equal(found!.ref.sessionId, UUID);
  assert.equal(found!.ref.filePath, join(dir, `${UUID}.jsonl`));

  // 不存在的 uuid → null
  assert.equal(await findClaudeSessionById('00000000-0000-4000-8000-000000000000', root), null);
  // 非 uuid 直接拒绝，避免扫盘
  assert.equal(await findClaudeSessionById('bogus-id', root), null);
});

test('codex findById: 按 rollout 文件名匹配并读 metadata cwd', async () => {
  const root = tmp();
  const cwd = '/proj/codex-a';
  const day = join(root, '2026', '08', '23');
  mkdirSync(day, { recursive: true });
  const filePath = join(day, `rollout-2026-08-23T00-00-00-000Z-${UUID}.jsonl`);
  writeFileSync(
    filePath,
    `{"type":"session_meta","payload":{"cwd":"${cwd}"}}\n{"type":"response_item","payload":{"type":"message","role":"user"}}\n`,
  );

  const found = await findCodexSessionById(UUID, root);
  assert.ok(found, '应命中');
  assert.equal(found!.ref.cwd, cwd);
  assert.equal(found!.ref.filePath, filePath);
});

test('codex findById: 首行超过 4KB（长 base_instructions）也能读出 cwd', async () => {
  const root = tmp();
  const cwd = '/proj/codex-long';
  const day = join(root, '2026', '08', '24');
  mkdirSync(day, { recursive: true });
  const filePath = join(day, `rollout-2026-08-24T00-00-00-000Z-${UUID}.jsonl`);
  // session_meta 首行故意带上 6KB 的 base_instructions，验证不再按 4096 字节截断解析
  const longText = 'x'.repeat(6000);
  writeFileSync(
    filePath,
    `{"type":"session_meta","payload":{"cwd":"${cwd}","base_instructions":{"text":"${longText}"}}}\n{"type":"response_item","payload":{"type":"message","role":"user"}}\n`,
  );

  const found = await findCodexSessionById(UUID, root);
  assert.ok(found, '应命中');
  assert.equal(found!.ref.cwd, cwd);
});

test('grok findById: 目录名 URL 解码得 cwd；summary 无 cwd 时兜底目录解码', async () => {
  const root = tmp();
  const cwd = '/proj/grok dir';
  const enc = encodeURIComponent(cwd);
  const sid = 'a01acad2-40ac-4b05-b200-fb7756e6399f';
  const sessionDir = join(root, enc, sid);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'chat_history.jsonl'), '{"type":"system","content":"hi"}\n');

  const found = await findGrokSessionById(sid, root);
  assert.ok(found, '应命中');
  assert.equal(found!.ref.cwd, cwd);

  // summary.json 声明了 cwd 时以文件为准
  const cwd2 = '/proj/grok-real';
  writeFileSync(
    join(sessionDir, 'summary.json'),
    JSON.stringify({ info: { id: sid, cwd: cwd2 }, updated_at: '2026-08-23T00:00:00Z' }),
  );
  const found2 = await findGrokSessionById(sid, root);
  assert.equal(found2!.ref.cwd, cwd2);
});

test('pi findById: 按 <ts>_<id>.jsonl 文件名匹配，cwd 从文件头读取', async () => {
  const root = tmp();
  const cwd = '/proj/pi dir';
  const dir = join(root, encodePiProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-08-23T04-11-38-834Z_${UUID}.jsonl`), `{"type":"session","id":"${UUID}","cwd":"${cwd}"}\n`);

  const found = await findPiSessionById(UUID, root);
  assert.ok(found);
  assert.equal(found!.ref.cwd, cwd);
});

test('kimi findById: 遍历 session_index.jsonl 匹配 sessionId', async () => {
  const root = tmp();
  const cwd = '/proj/kimi-a';
  const sid = 'ses_b835ee1a-63f3-4931-9fc2-0321ebefed44';
  const sessionDir = join(root, 'wd_x', sid);
  const wireDir = join(sessionDir, 'agents', 'main');
  mkdirSync(wireDir, { recursive: true });
  writeFileSync(join(wireDir, 'wire.jsonl'), '{"type":"turn.prompt","input":[{"type":"text","text":"hi"}]}\n');
  const indexPath = join(root, 'out', 'session_index.jsonl');
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(
    indexPath,
    `${JSON.stringify({ sessionId: 'ses_other', sessionDir: '/nope', workDir: '/nope' })}\n` +
      `${JSON.stringify({ sessionId: sid, sessionDir, workDir: cwd })}\n`,
  );

  const found = await findKimiSessionById(sid, indexPath);
  assert.ok(found);
  assert.equal(found!.ref.cwd, cwd);
  assert.equal(found!.ref.filePath, join(wireDir, 'wire.jsonl'));
});

test('resolveById 映射持久化：命中写回 → 快返免扫描 → 文件失效自动降级', async () => {
  const dir = tmp();
  const file = join(dir, 'known.jsonl');
  const fileOk = (): boolean => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  let calls = 0;
  const adapter = {
    id: 'claude',
    displayName: 'Claude',
    findById: async (sessionId: string) => {
      calls += 1;
      if (sessionId !== 'known' || !fileOk()) return null;
      return { ref: { provider: 'claude', sessionId, filePath: file, cwd: '/proj/from-fake' }, updatedAt: 1 };
    },
  } as unknown as ProviderAdapter;

  writeFileSync(file, 'hi\n');
  const store = new Store(':memory:');

  // 首次：无映射 → 全扫一次，命中后写回
  const r1 = await resolveById('known', undefined, store, [adapter]);
  assert.ok(r1);
  assert.equal(r1!.found.ref.cwd, '/proj/from-fake');
  assert.equal(calls, 1, '首次应全扫一次');
  const loc = store.getSessionLocation('claude', 'known');
  assert.ok(loc);
  assert.equal(loc!.cwd, '/proj/from-fake');
  assert.equal(loc!.filePath, file);

  // 二次：映射命中且文件仍在 → 快返，不再全扫（并刷新 last_seen_at/hits）
  const r2 = await resolveById('known', undefined, store, [adapter]);
  assert.ok(r2);
  assert.equal(r2!.found.ref.cwd, '/proj/from-fake');
  assert.equal(calls, 1, '二次应快返免扫描');
  assert.equal(store.getSessionLocation('claude', 'known')!.hits, 2);

  // 会话文件删除 → 快返失效，全扫也不命中 → null
  unlinkSync(file);
  assert.equal(await resolveById('known', undefined, store, [adapter]), null);
  assert.equal(calls, 2, '降级后应重新全扫一次');

  // 文件恢复 → 再次快返
  writeFileSync(file, 'hi\n');
  const r4 = await resolveById('known', undefined, store, [adapter]);
  assert.ok(r4);
  assert.equal(calls, 2, '文件恢复后应再次快返免扫描');
});

test('opencode findById: SQLite 按 id 查 session.directory', async () => {
  const root = tmp();
  const dbPath = join(root, 'opencode.db');
  const old = process.env.TONG_OPENCODE_DB;
  process.env.TONG_OPENCODE_DB = dbPath;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT,
      title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT)`);
    db.prepare(
      'INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, agent, model) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'ses_462e8215fffeIhESti7Joud4w5',
      'p1',
      'x',
      '/proj/opencode-a',
      't',
      '1.1.0',
      1_800_000_000_000,
      1_800_000_000_000,
      'build',
      '{}',
    );
    db.close();

    const found = await findOpencodeSessionById('ses_462e8215fffeIhESti7Joud4w5');
    assert.ok(found);
    assert.equal(found!.ref.cwd, '/proj/opencode-a');
    assert.equal(await findOpencodeSessionById('ses_missing'), null);
  } finally {
    if (old === undefined) delete process.env.TONG_OPENCODE_DB;
    else process.env.TONG_OPENCODE_DB = old;
  }
});

// ---------- 跨平台可复制命令拼装 ----------

test('跨平台: 命令拼装两平台输出不同（Windows PowerShell / POSIX），单引号转义各自正确', () => {
  const cwd = "/Users/czm/O'Brien Proj";
  const resume = 'codex resume ses_123';

  // POSIX：单引号内单引号转义成 '\''
  const posixCd = buildCdFor(cwd, false);
  assert.equal(posixCd, `cd '/Users/czm/O'\\''Brien Proj'`);
  assert.equal(buildCommandFor(posixCd, resume, false), `cd '/Users/czm/O'\\''Brien Proj' && codex resume ses_123`);

  // Windows：PowerShell 单引号双写，`;` 分隔
  const winCd = buildCdFor(cwd, true);
  assert.equal(winCd, `Set-Location -LiteralPath '/Users/czm/O''Brien Proj'`);
  assert.equal(
    buildCommandFor(winCd, resume, true),
    `Set-Location -LiteralPath '/Users/czm/O''Brien Proj'; codex resume ses_123`,
  );
});