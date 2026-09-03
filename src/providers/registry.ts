import type { ProviderAdapter } from './adapter.js';
import type { ProviderInfo } from '../core/types.js';
import { claudeAdapter } from './claude/index.js';
import { codexAdapter } from './codex/index.js';
import { piAdapter } from './pi/index.js';
import { kimiAdapter } from './kimi/index.js';
import { opencodeAdapter } from './opencode/index.js';
import { grokAdapter } from './grok/index.js';

/** Provider 注册表：UI 下拉从这里读；新增 Provider 只加一行 */
const adapters: ProviderAdapter[] = [
  claudeAdapter,
  codexAdapter,
  piAdapter,
  kimiAdapter,
  opencodeAdapter,
  grokAdapter,
];

export function getAdapter(id: string): ProviderAdapter | undefined {
  return adapters.find((a) => a.id === id);
}

export function listAdapters(): ProviderAdapter[] {
  return [...adapters];
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return Promise.all(
    adapters.map(async (a) => ({
      id: a.id,
      displayName: a.displayName,
      available: await a.detect(),
    })),
  );
}
