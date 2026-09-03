/**
 * 转换/交接处置披露（findings）：
 * 任何内容处理结果都必须归入五级处置之一并计数，杜绝静默丢弃。
 * 契约供 handoff 与各 provider parse 共用（parse-fidelity 任务复用）。
 */
export type Disposition = 'exact' | 'degraded' | 'skipped' | 'synthesized' | 'blocked';

export type Finding = { code: string; disposition: Disposition; count: number };

/** 累加一条 finding（同 code+disposition 合并计数） */
export function addFinding(list: Finding[], code: string, disposition: Disposition, count = 1): void {
  const found = list.find((f) => f.code === code && f.disposition === disposition);
  if (found) found.count += count;
  else list.push({ code, disposition, count });
}

/** 合并多组 findings：同 code+disposition 计数相加，按 code 再 disposition 排序 */
export function mergeFindings(...lists: Finding[][]): Finding[] {
  const out: Finding[] = [];
  for (const list of lists) {
    for (const f of list) addFinding(out, f.code, f.disposition, f.count);
  }
  return out.sort((a, b) => a.code.localeCompare(b.code) || a.disposition.localeCompare(b.disposition));
}

export type FindingsStatus = 'exact' | 'degraded' | 'blocked';

/** 三档归约：任一 blocked → blocked；任一非 exact → degraded；否则 exact */
export function findingsStatus(findings: Finding[]): FindingsStatus {
  if (findings.some((f) => f.disposition === 'blocked')) return 'blocked';
  if (findings.some((f) => f.disposition !== 'exact')) return 'degraded';
  return 'exact';
}
