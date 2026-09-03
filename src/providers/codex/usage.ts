import { readFile } from 'node:fs/promises';
import type { SessionRef, TokenUsage } from '../../core/types.js';

export async function codexSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  let raw: string;
  try {
    raw = await readFile(ref.filePath, 'utf8');
  } catch {
    return null;
  }
  let last: TokenUsage | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = rec.payload as Record<string, unknown> | undefined;
    const kind = payload?.type ?? rec.type;
    if (kind !== 'token_count') continue;
    const info = (payload?.info ?? rec.info) as Record<string, unknown> | undefined;
    const total = info?.total_token_usage ?? payload?.total_token_usage;
    const u = pick(total);
    if (u) last = u;
  }
  return last;
}

function pick(usage: unknown): TokenUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
