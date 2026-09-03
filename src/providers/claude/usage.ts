import { readFile } from 'node:fs/promises';
import type { SessionRef, TokenUsage } from '../../core/types.js';

export async function claudeSessionUsage(ref: SessionRef): Promise<TokenUsage | null> {
  let raw: string;
  try {
    raw = await readFile(ref.filePath, 'utf8');
  } catch {
    return null;
  }
  let input = 0;
  let output = 0;
  let hit = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const u = pick(rec.usage) ?? pick((rec.message as Record<string, unknown> | undefined)?.usage);
    if (!u) continue;
    hit = true;
    input += u.inputTokens;
    output += u.outputTokens;
  }
  return hit ? { inputTokens: input, outputTokens: output } : null;
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
