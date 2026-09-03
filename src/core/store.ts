import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { normalizePath } from './platform.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from './types.js';

const SCHEMA_VERSION = 5;
const REQUIRED_TABLES = ['sessions', 'turns', 'switch_events', 'turn_events', 'chains', 'messages_fts'] as const;
const FTS_TEXT_LIMIT = 8192;

export type SearchHit = {
  sessionId: string;
  provider: string;
  cwd: string;
  filePath: string;
  snippet: string;
};

export type Chain = {
  id: string;
  cwd: string;
  name: string;
  status: 'active' | 'archived';
  lastUsedAt: number;
  createdAt: number;
};

export type SessionLocation = {
  provider: string;
  sessionId: string;
  cwd: string;
  filePath: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hits: number;
};

export type StoredSession = {
  id: string;
  title: string;
  cwd: string;
  provider: string | null;
  ref: SessionRef | null;
  nextSeq: number;
};

export type SwitchRecord = {
  id: string;
  sessionId: string;
  fromProvider: string | null;
  toProvider: string;
  fromRef: SessionRef | null;
  toRef: SessionRef;
  createdAt: number;
  schemaVersion?: string;
};

export const CHAIN_SESSION_TITLE = 'tui-chain';

export const defaultDbPath = (): string => join(homedir(), '.tongbu', 'tongbu.db');

/**
 * 本地单库持久化（node:sqlite 同步 API，与 router 串行队列匹配）。
 * 迁移：PRAGMA user_version 步进，每版幂等（参考 hapi hub/src/store）。
 * 写库失败由调用方（router）兜底，store 内部不吞错。
 */
export class Store {
  private readonly db: DatabaseSync;

  /** cwd 库键归一（Windows 反斜杠/`\\?\` 前缀统一），保证同一目录不同写法命中同一行 */
  private normCwd(cwd: string): string {
    return normalizePath(cwd);
  }

  constructor(dbPath: string = defaultDbPath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
    if (dbPath !== ':memory:') {
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          chmodSync(p, 0o600);
        } catch {
          // wal/shm 可能尚未生成
        }
      }
    }
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    let version = row.user_version;
    const steps: Record<number, () => void> = {
      0: () => this.createV1(),
      1: () => this.migrateV2(),
      2: () => this.migrateV3(),
      3: () => this.migrateV4(),
      4: () => this.migrateV5(),
    };
    while (version < SCHEMA_VERSION) {
      const step = steps[version];
      if (!step) throw new Error(`tongbu.db schema 版本 ${version} 无迁移路径`);
      step();
      version += 1;
      this.db.prepare(`PRAGMA user_version = ${version}`).run();
    }
    for (const t of REQUIRED_TABLES) {
      const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!found) throw new Error(`tongbu.db 缺少必需表: ${t}`);
    }
  }

  private createV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL,
        provider TEXT,
        ref_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL,
        provider TEXT,
        ts TEXT NOT NULL,
        meta_json TEXT,
        UNIQUE (session_id, seq)
      );

      CREATE TABLE IF NOT EXISTS switch_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_provider TEXT,
        to_provider TEXT NOT NULL,
        from_ref TEXT,
        to_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_switch_session ON switch_events(session_id, created_at);

      CREATE TABLE IF NOT EXISTS turn_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('thinking','tool_call','tool_result','text')),
        summary TEXT NOT NULL,
        detail TEXT,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_events ON turn_events(session_id, turn_seq);
    `);
  }

  private migrateV2(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chains (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','archived')),
        last_used_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (cwd, name)
      );
      CREATE INDEX IF NOT EXISTS idx_chains_cwd ON chains(cwd, status);
    `);
    this.db.exec(`
      INSERT INTO chains (id, cwd, name, status, last_used_at, created_at)
      SELECT id, cwd, '默认', 'active', updated_at, created_at
      FROM sessions
      WHERE title = '${CHAIN_SESSION_TITLE}'
        AND id NOT IN (SELECT id FROM chains)
    `);
  }

  private migrateV4(): void {
    // v4: switch_events 标记 tongbu 写出版本（对原生工具零副作用，仅存 tongbu 侧）
    this.db.exec("ALTER TABLE switch_events ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'v1'");
  }

  private migrateV5(): void {
    // v5: 启动器持久化的 session id ↔ cwd 映射。`tongbu open <id>` 反查命中即 upsert，
    // 下次同 id 直接快返（file_path 仍在时），不再全盘扫描各 provider 原生库。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_locations (
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        file_path TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_locations_cwd ON session_locations(cwd, last_seen_at);
    `);
  }

  private migrateV3(): void {
    const ddl = (tokenizer: string) => `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        session_id UNINDEXED,
        provider UNINDEXED,
        cwd UNINDEXED,
        file_path UNINDEXED,
        tokenize = '${tokenizer}'
      );
    `;
    try {
      this.db.exec(ddl('trigram'));
    } catch {
      this.db.exec(ddl('unicode61 remove_diacritics 2'));
    }
  }

  /** 启动器反查成功后写入/刷新 id ↔ cwd 映射。命中已存在记录时 hits+1，first_seen_at 保留 */
  rememberSessionLocation(provider: string, ref: SessionRef, seenAt: number = Date.now()): void {
    ref = { ...ref, cwd: normalizePath(ref.cwd) };
    this.db
      .prepare(
        `INSERT INTO session_locations (provider, session_id, cwd, file_path, first_seen_at, last_seen_at, hits)
         VALUES (?,?,?,?,?,?,1)
         ON CONFLICT(provider, session_id) DO UPDATE SET
           cwd = excluded.cwd,
           file_path = excluded.file_path,
           last_seen_at = excluded.last_seen_at,
           hits = hits + 1`,
      )
      .run(provider, ref.sessionId, ref.cwd, ref.filePath, seenAt, seenAt);
  }

  getSessionLocation(provider: string, sessionId: string): SessionLocation | null {
    const row = this.db
      .prepare('SELECT * FROM session_locations WHERE provider=? AND session_id=?')
      .get(provider, sessionId) as SessionLocationRow | undefined;
    return row ? rowToSessionLocation(row) : null;
  }

  listSessionLocations(opts?: { cwd?: string; limit?: number }): SessionLocation[] {
    const { cwd: rawCwd, limit = 50 } = opts ?? {};
    const cwd = rawCwd ? this.normCwd(rawCwd) : undefined;
    const rows = cwd
      ? (this.db
          .prepare('SELECT * FROM session_locations WHERE cwd=? ORDER BY last_seen_at DESC LIMIT ?')
          .all(cwd, limit) as SessionLocationRow[])
      : (this.db.prepare('SELECT * FROM session_locations ORDER BY last_seen_at DESC LIMIT ?').all(limit) as SessionLocationRow[]);
    return rows.map(rowToSessionLocation);
  }

  reindexSession(opts: {
    cwd: string;
    sessionId: string;
    provider: string;
    filePath: string;
    texts: string[];
  }): void {
    opts = { ...opts, cwd: normalizePath(opts.cwd) };
    this.db.prepare('DELETE FROM messages_fts WHERE session_id=? AND cwd=?').run(opts.sessionId, opts.cwd);
    const ins = this.db.prepare(
      'INSERT INTO messages_fts (text, session_id, provider, cwd, file_path) VALUES (?,?,?,?,?)',
    );
    for (const raw of opts.texts) {
      const text = raw.replace(/\s+/g, ' ').trim().slice(0, FTS_TEXT_LIMIT);
      if (text.length < 2) continue;
      ins.run(text, opts.sessionId, opts.provider, opts.cwd, opts.filePath);
    }
  }

  searchMessages(query: string, cwd?: string): SearchHit[] {
    cwd = cwd ? this.normCwd(cwd) : undefined;
    const q = query.trim();
    if (!q) return [];
    const match = `"${q.replace(/"/g, ' ')}"`;
    const sql = cwd
      ? `SELECT session_id, provider, cwd, file_path, snippet(messages_fts, 0, '[', ']', '…', 10) AS snippet
         FROM messages_fts WHERE messages_fts MATCH ? AND cwd=? LIMIT 40`
      : `SELECT session_id, provider, cwd, file_path, snippet(messages_fts, 0, '[', ']', '…', 10) AS snippet
         FROM messages_fts WHERE messages_fts MATCH ? LIMIT 40`;
    const rows = (
      cwd ? this.db.prepare(sql).all(match, cwd) : this.db.prepare(sql).all(match)
    ) as {
      session_id: string;
      provider: string;
      cwd: string;
      file_path: string;
      snippet: string;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      provider: r.provider,
      cwd: r.cwd,
      filePath: r.file_path,
      snippet: r.snippet,
    }));
  }

  /** 首开聊：建 session 行 + 首轮 user/assistant + 首轮过程事件，返回 session id */
  createSession(cwd: string, provider: string, ref: SessionRef, turns: [UnifiedTurn, UnifiedTurn], events: ProcessEvent[] = []): string {
    cwd = this.normCwd(cwd);
    const id = randomUUID();
    const now = Date.now();
    const title = turns[0].text.replace(/\s+/g, ' ').slice(0, 50);
    this.db.prepare(
      'INSERT INTO sessions (id, title, cwd, provider, ref_json, created_at, updated_at, next_seq) VALUES (?,?,?,?,?,?,?,0)',
    ).run(id, title, cwd, provider, JSON.stringify(ref), now, now);
    this.appendTurns(id, turns, events);
    return id;
  }

  /**
   * 追加一轮消息（send 成功路径）：user+assistant 两条 turns + 本轮过程事件，更新 updated_at。
   * 单事务保证成对完整；seq 取 sessions.next_seq 并推进。
   */
  appendTurns(sessionId: string, turns: UnifiedTurn[], events: ProcessEvent[]): void {
    this.db.exec('BEGIN');
    try {
      const row = this.db.prepare('SELECT next_seq FROM sessions WHERE id=?').get(sessionId) as
        | { next_seq: number }
        | undefined;
      if (!row) throw new Error(`session 不存在: ${sessionId}`);
      let seq = row.next_seq;
      const insTurn = this.db.prepare(
        'INSERT INTO turns (id, session_id, seq, role, text, provider, ts) VALUES (?,?,?,?,?,?,?)',
      );
      let assistantSeq = -1;
      for (const t of turns) {
        insTurn.run(randomUUID(), sessionId, seq, t.role, t.text, t.provider ?? null, t.timestamp);
        if (t.role === 'assistant') assistantSeq = seq;
        seq += 1;
      }
      if (events.length && assistantSeq >= 0) {
        const insEvent = this.db.prepare(
          'INSERT INTO turn_events (id, session_id, turn_seq, kind, summary, detail, ts) VALUES (?,?,?,?,?,?,?)',
        );
        for (const e of events) {
          insEvent.run(randomUUID(), sessionId, assistantSeq, e.kind, e.summary, e.detail ?? null, e.timestamp);
        }
      }
      this.db.prepare('UPDATE sessions SET next_seq=?, updated_at=? WHERE id=?').run(seq, Date.now(), sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 切换成功：记审计 + 更新当前指向；连续完全相同的记录不重复落库 */
  recordSwitch(sessionId: string, fromProvider: string | null, fromRef: SessionRef | null, toProvider: string, toRef: SessionRef | null): void {
    this.db.exec('BEGIN');
    try {
      const last = this.db
        .prepare(
          'SELECT from_provider, from_ref, to_provider, to_ref FROM switch_events WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        )
        .get(sessionId) as
        | { from_provider: string | null; from_ref: string | null; to_provider: string; to_ref: string }
        | undefined;
      const fromJson = fromRef ? JSON.stringify(fromRef) : null;
      const toJson = toRef ? JSON.stringify(toRef) : null;
      if (
        last &&
        last.from_provider === fromProvider &&
        last.from_ref === fromJson &&
        last.to_provider === toProvider &&
        last.to_ref === toJson
      ) {
        this.db.exec('ROLLBACK');
        return;
      }
      this.db.prepare(
        'INSERT INTO switch_events (id, session_id, from_provider, to_provider, from_ref, to_ref, created_at, schema_version) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        randomUUID(),
        sessionId,
        fromProvider,
        toProvider,
        fromJson,
        toJson,
        Date.now(),
        'v1',
      );
      this.db.prepare('UPDATE sessions SET provider=?, ref_json=?, updated_at=? WHERE id=?').run(
        toProvider,
        toRef ? JSON.stringify(toRef) : null,
        Date.now(),
        sessionId,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** start 后回写 ref（createSession 已带 ref；此方法留给未来 ref 变更场景） */
  updateRef(sessionId: string, provider: string, ref: SessionRef): void {
    this.db.prepare('UPDATE sessions SET provider=?, ref_json=?, updated_at=? WHERE id=?').run(
      provider,
      JSON.stringify(ref),
      Date.now(),
      sessionId,
    );
  }

  /** server 启动恢复：同 cwd 最近更新的 session（排除 CLI 链会话行） */
  loadLatestSession(cwd: string): StoredSession | null {
    cwd = this.normCwd(cwd);
    const row = this.db
      .prepare(
        "SELECT id, title, cwd, provider, ref_json, next_seq FROM sessions WHERE cwd=? AND title != ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(cwd, CHAIN_SESSION_TITLE) as
      | { id: string; title: string; cwd: string; provider: string | null; ref_json: string | null; next_seq: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      provider: row.provider,
      ref: row.ref_json ? (JSON.parse(row.ref_json) as SessionRef) : null,
      nextSeq: row.next_seq,
    };
  }

  /** 已有 CLI 链会话则返回 id，否则 null（status 只读，不创建） */
  findChainSession(cwd: string): string | null {
    return this.findActiveChain(cwd)?.id ?? null;
  }

  findActiveChain(cwd: string, chainId?: string): Chain | null {
    cwd = this.normCwd(cwd);
    if (chainId) {
      const byId = this.db.prepare('SELECT * FROM chains WHERE id=?').get(chainId) as ChainRow | undefined;
      if (byId && byId.cwd === cwd) return rowToChain(byId);
      const byName = this.db
        .prepare('SELECT * FROM chains WHERE cwd=? AND name=?')
        .get(cwd, chainId) as ChainRow | undefined;
      return byName ? rowToChain(byName) : null;
    }
    const row = this.db
      .prepare("SELECT * FROM chains WHERE cwd=? AND status='active' ORDER BY last_used_at DESC LIMIT 1")
      .get(cwd) as ChainRow | undefined;
    return row ? rowToChain(row) : null;
  }

  listChains(cwd: string): Chain[] {
    cwd = this.normCwd(cwd);
    const rows = this.db
      .prepare(
        `SELECT * FROM chains WHERE cwd=? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, last_used_at DESC`,
      )
      .all(cwd) as ChainRow[];
    return rows.map(rowToChain);
  }

  createChain(cwd: string, name: string): Chain {
    cwd = this.normCwd(cwd);
    const trimmed = name.trim();
    if (!trimmed) throw new Error('链名不能为空');
    const id = randomUUID();
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO sessions (id, title, cwd, provider, ref_json, created_at, updated_at, next_seq) VALUES (?,?,?,?,NULL,?,?,0)',
        )
        .run(id, CHAIN_SESSION_TITLE, cwd, null, now, now);
      this.db
        .prepare('INSERT INTO chains (id, cwd, name, status, last_used_at, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, cwd, trimmed, 'active', now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw uniqueChainName(error, trimmed);
    }
    return this.mustChain(id);
  }

  renameChain(id: string, name: string): Chain {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('链名不能为空');
    const existing = this.mustChain(id);
    try {
      this.db.prepare('UPDATE chains SET name=? WHERE id=?').run(trimmed, id);
    } catch (error) {
      throw uniqueChainName(error, trimmed);
    }
    return { ...existing, name: trimmed };
  }

  archiveChain(id: string): void {
    const chain = this.mustChain(id);
    if (chain.status === 'archived') return;
    const active = this.db
      .prepare("SELECT COUNT(*) AS n FROM chains WHERE cwd=? AND status='active'")
      .get(chain.cwd) as { n: number };
    if (active.n <= 1) throw new Error('不能归档最后一条链');
    this.db.prepare("UPDATE chains SET status='archived' WHERE id=?").run(id);
  }

  touchChain(id: string): void {
    const chain = this.mustChain(id);
    const at = Math.max(Date.now(), chain.lastUsedAt + 1);
    this.db.prepare('UPDATE chains SET last_used_at=? WHERE id=?').run(at, id);
  }

  /** 纯 CLI 场景：选定或创建链，挂 switch_events */
  getOrCreateChainSession(cwd: string, chainId?: string): string {
    const found = this.findActiveChain(cwd, chainId);
    if (found) {
      if (found.status === 'archived') throw new Error(`链已归档: ${found.name}`);
      this.touchChain(found.id);
      return found.id;
    }
    if (chainId) throw new Error(`找不到链: ${chainId}`);
    return this.createChain(cwd, '默认').id;
  }

  private mustChain(id: string): Chain {
    const row = this.db.prepare('SELECT * FROM chains WHERE id=?').get(id) as ChainRow | undefined;
    if (!row) throw new Error(`找不到链: ${id}`);
    return rowToChain(row);
  }

  listSwitchEvents(sessionId: string): SwitchRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id, from_provider, to_provider, from_ref, to_ref, created_at, schema_version FROM switch_events WHERE session_id=? ORDER BY created_at ASC',
      )
      .all(sessionId) as unknown as {
      id: string;
      session_id: string;
      from_provider: string | null;
      to_provider: string;
      from_ref: string | null;
      to_ref: string;
      created_at: number;
      schema_version: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      fromProvider: r.from_provider,
      toProvider: r.to_provider,
      fromRef: r.from_ref ? (JSON.parse(r.from_ref) as SessionRef) : null,
      toRef: JSON.parse(r.to_ref) as SessionRef,
      schemaVersion: r.schema_version ?? undefined,
      createdAt: r.created_at,
    }));
  }

  loadTurns(sessionId: string): UnifiedTurn[] {
    const rows = this.db
      .prepare('SELECT role, text, provider, ts FROM turns WHERE session_id=? ORDER BY seq')
      .all(sessionId) as unknown as { role: 'user' | 'assistant'; text: string; provider: string | null; ts: string }[];
    return rows.map((r) => ({
      role: r.role,
      text: r.text,
      timestamp: r.ts,
      ...(r.provider ? { provider: r.provider } : {}),
    }));
  }

  /** 过程事件按 turn_seq 分组（turn_seq = assistant turn 的 seq = timeline 下标） */
  loadEventsByTurn(sessionId: string): Record<number, ProcessEvent[]> {
    const rows = this.db
      .prepare('SELECT turn_seq, kind, summary, detail, ts FROM turn_events WHERE session_id=? ORDER BY turn_seq, ts')
      .all(sessionId) as unknown as { turn_seq: number; kind: ProcessEvent['kind']; summary: string; detail: string | null; ts: string }[];
    const out: Record<number, ProcessEvent[]> = {};
    for (const r of rows) {
      (out[r.turn_seq] ??= []).push({
        kind: r.kind,
        summary: r.summary,
        ...(r.detail ? { detail: r.detail } : {}),
        timestamp: r.ts,
        provider: '',
      });
    }
    return out;
  }
}

type SessionLocationRow = {
  provider: string;
  session_id: string;
  cwd: string;
  file_path: string;
  first_seen_at: number;
  last_seen_at: number;
  hits: number;
};

function rowToSessionLocation(row: SessionLocationRow): SessionLocation {
  return {
    provider: row.provider,
    sessionId: row.session_id,
    cwd: row.cwd,
    filePath: row.file_path,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    hits: row.hits,
  };
}

type ChainRow = {
  id: string;
  cwd: string;
  name: string;
  status: 'active' | 'archived';
  last_used_at: number;
  created_at: number;
};

function rowToChain(row: ChainRow): Chain {
  return {
    id: row.id,
    cwd: row.cwd,
    name: row.name,
    status: row.status,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

function uniqueChainName(error: unknown, name: string): Error {
  const msg = error instanceof Error ? error.message : String(error);
  if (/UNIQUE|unique/i.test(msg)) return new Error(`链名已存在: ${name}`);
  return error instanceof Error ? error : new Error(msg);
}
