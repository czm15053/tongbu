import { spawn } from 'node:child_process';

export type StreamResult = { stdout: string; stderr: string };

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * spawn 命令并逐行回调 stdout（流式）；返回完整 stdout/stderr。
 * 非零退出 reject，error 上挂 code/stdout/stderr（对齐 execFile 的错误形态）。
 */
export function streamCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
  onLine?: (line: string) => void,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    // stdin 置 ignore：codex exec 会探测 stdin 等待追加输入，pipe 不关会永远挂起
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let overflow = false;

    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill();
          reject(Object.assign(new Error(`${cmd} 超时（${opts.timeout}ms）`), { code: -1, stdout, stderr }));
        }, opts.timeout)
      : null;

    const feed = (chunk: string): void => {
      if (stdout.length < MAX_BUFFER) stdout += chunk;
      else overflow = true;
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.trim()) onLine?.(line);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', feed);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk;
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (pending.trim()) onLine?.(pending);
      if (overflow) stderr += '\n[stdout 超过 64MB 被截断]';
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(Object.assign(new Error(`${cmd} 退出码 ${code}`), { code, stdout, stderr }));
      }
    });
  });
}
