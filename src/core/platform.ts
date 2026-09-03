// 跨平台辅助：路径归一化、大小写不敏感比较。
// 模式参考 trellis-card 的 src-tauri/src/platform.rs（to_posix / path_eq_ignore_case /
// strip_device_prefix / normalize_path）。工具函数只做字符串变换/比较，不做文件系统调用。
import { platform } from 'node:os';
import { execFileSync } from 'node:child_process';

export const IS_WIN = platform() === 'win32';

/** 反斜杠统一为正斜杠，仅用于持久化键与字符串比较。 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 去掉 Windows 设备路径前缀 `\\?\`（canonicalize 返回）；非 Windows 原样返回。 */
export function stripDevicePrefix(p: string): string {
  return IS_WIN && p.startsWith('\\\\?\\') ? p.slice(4) : p;
}

/** canonicalize 语义的键归一：去设备前缀 + 正反斜杠统一。不改变磁盘路径本身。 */
export function normalizePath(p: string): string {
  return stripDevicePrefix(toPosix(p));
}

/** 剥尾部 `/`/`\` 后做大小写不敏感比较（Windows 文件系统不区分大小写），其余平台精确比较。 */
export function cwdEq(a: string, b: string): boolean {
  const na = normalizePath(a).replace(/\/+$/, '');
  const nb = normalizePath(b).replace(/\/+$/, '');
  return IS_WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
const cliCache = new Map<string, string>();

/**
 * 解析 CLI 可执行名。Windows 上 npm 全局命令是 .cmd/.ps1 shim，
 * spawn/execFile 不带 shell 不走 PATHEXT，需用 where 解析出绝对路径
 * （优先 .exe/.cmd；.ps1 无法直接执行，跳过）。其它平台返回原名交给 PATH。
 */
export function resolveCli(name: string): string {
  if (!IS_WIN) return name;
  const hit = cliCache.get(name);
  if (hit) return hit;
  let resolved = name;
  try {
    const out = execFileSync('where.exe', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    resolved = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0] ?? name;
  } catch {
    // where 失败保持原名，让调用方拿到原始 ENOENT
  }
  cliCache.set(name, resolved);
  return resolved;
}
