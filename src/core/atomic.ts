import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export type FileDigest = { sha256: string; sizeBytes: number };

/** 文件内容指纹；文件不存在返回 null（TOCTOU 检测用） */
export async function digestFile(filePath: string): Promise<FileDigest | null> {
  let raw: Buffer;
  let info;
  try {
    [raw, info] = await Promise.all([readFile(filePath), stat(filePath)]);
  } catch {
    return null;
  }
  return { sha256: createHash('sha256').update(raw).digest('hex'), sizeBytes: info.size };
}

/**
 * 原子写文件：写同目录 tmp → fsync → verify 回调 → 可选 backup → rename。
 * 任一步失败都会清理 tmp 并重抛，原文件从未被触碰。
 * - `backup`：rename 前把原文件复制为 `<file>.bak`（单代，覆盖上一代）
 * - `verify`：tmp 落盘后、rename 前回调（round-trip 自校验）；抛错则零写盘
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  opts?: { backup?: boolean; verify?: (tmpPath: string) => Promise<void> },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tongbu-tmp-${randomUUID()}`;
  let mode: number | undefined;
  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch {
    mode = undefined; // 新文件
  }
  const handle = await open(tmpPath, 'w', mode ?? 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (opts?.verify) await opts.verify(tmpPath);
    if (opts?.backup) {
      try {
        await copyFile(filePath, `${filePath}.bak`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
