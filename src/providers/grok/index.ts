import { execFile } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import { promisify } from 'node:util';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import type { ProviderAdapter, ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import {
  createEmptyGrokSession,
  findGrokSessionById,
  findLatestGrokSession,
  importTurnsToGrok,
  listGrokSessions,
} from './build.js';
import { parseGrokSession } from './parse.js';

export { findGrokSessionById };

const execFileAsync = promisify(execFile);

export const grokAdapter: ProviderAdapter = {
  id: 'grok',
  displayName: 'Grok',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('grok'), ['--version']);
      return true;
    } catch {
      return false;
    }
  },

  parse(ref: SessionRef): Promise<UnifiedTurn[]> {
    return parseGrokSession(ref);
  },

  importTurns(turns: UnifiedTurn[], cwd: string, into?: SessionRef, opts?: ImportTurnsOpts): Promise<SessionRef> {
    return importTurnsToGrok(turns, cwd, into, opts);
  },
  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },

  async createEmptySession(cwd: string): Promise<SessionRef> {
    return createEmptyGrokSession(cwd);
  },

  async start(): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    throw new Error('Grok 适配器暂不支持 headless start，请使用 TUI resume');
  },

  async send(): Promise<UnifiedTurn> {
    throw new Error('Grok 适配器暂不支持 headless send，请使用 TUI resume');
  },

  async findLatestSession(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; preview?: string } | null> {
    return findLatestGrokSession(cwd);
  },

  async listSessions(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
    return listGrokSessions(cwd);
  },

  findById: findGrokSessionById,

  resumeCommand(ref: SessionRef): string {
    return `grok -r ${ref.sessionId}`;
  },

  async sessionUsage(): Promise<TokenUsage | null> {
    return null;
  },
};
