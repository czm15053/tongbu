import { spawn } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import type { ProviderAdapter } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import { parseOpencodeSession } from './parse.js';
import {
  createEmptyOpencodeSession,
  findLatestOpencodeSession,
  findOpencodeSessionById,
  importTurnsToOpencode,
  listOpencodeSessions,
  opencodeDbPath,
} from './build.js';

function refFromSessionId(sessionId: string, cwd: string): SessionRef {
  return { provider: 'opencode', sessionId, filePath: opencodeDbPath(), cwd };
}

function replyTurn(text: string): UnifiedTurn {
  return {
    role: 'assistant',
    text,
    timestamp: new Date().toISOString(),
    provider: 'opencode',
  };
}

/** 从 opencode run 的 stdout 里提取 assistant 回复文本 */
function parseRunOutput(stdout: string): string {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
    if (line && !line.startsWith('>') && !line.startsWith('█') && !line.includes('opencode')) {
      return line;
    }
  }
  return '';
}

async function runOpencode(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCli('opencode'), args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      // opencode CLI 在 stdin 被关闭时会自我终止，因此继承 stdin；stdout/stderr 捕获。
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('opencode CLI 调用超时'));
    }, 120_000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`opencode CLI 启动失败: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = stderr.slice(0, 500) || `exit ${code} signal ${signal}`;
        reject(new Error(`opencode CLI 调用失败: ${detail}`));
        return;
      }
      resolve(parseRunOutput(stdout));
    });
  });
}

export {
  findLatestOpencodeSession,
  listOpencodeSessions,
  opencodeDbPath,
};

export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',

  async detect(): Promise<boolean> {
    return new Promise((resolve) => {
      // 二进制存在但不可执行（如 bun postinstall 未跑的 shim 无 shebang）时 spawn 会同步抛 ENOEXEC
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(resolveCli('opencode'), ['--version'], { timeout: 10_000 });
      } catch {
        resolve(false);
        return;
      }
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  },

  parse: parseOpencodeSession,
  importTurns: importTurnsToOpencode,
  findLatestSession: findLatestOpencodeSession,
  listSessions: listOpencodeSessions,
  findById: findOpencodeSessionById,

  async createEmptySession(cwd: string): Promise<SessionRef> {
    return createEmptyOpencodeSession(cwd);
  },

  async start(
    cwd: string,
    text: string,
    onEvent?: (e: ProcessEvent) => void,
  ): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    // opencode run --auto <msg> 在当前服务端版本会报 UnknownError，因此先建空会话再 send。
    const ref = await createEmptyOpencodeSession(cwd);
    const turn = await this.send(ref, text, onEvent);
    return { ref, turn };
  },

  async send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn> {
    const replyText = await runOpencode(['run', '--session', ref.sessionId, '--auto', text], ref.cwd);
    if (onEvent) {
      // opencode run 不输出细粒度事件；后续可扩展
    }
    return replyTurn(replyText);
  },

  resumeCommand(ref: SessionRef): string {
    return `opencode -s ${ref.sessionId}`;
  },
};
