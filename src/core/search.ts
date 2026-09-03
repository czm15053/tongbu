import type { Store } from './store.js';
import type { ProviderAdapter } from '../providers/adapter.js';

export async function reindexCwd(cwd: string, adapters: ProviderAdapter[], store: Store): Promise<number> {
  let n = 0;
  for (const adapter of adapters) {
    if (!adapter.listSessions) continue;
    const list = await adapter.listSessions(cwd);
    for (const s of list) {
      try {
        const turns = await adapter.parse(s.ref);
        store.reindexSession({
          cwd,
          sessionId: s.ref.sessionId,
          provider: adapter.id,
          filePath: s.ref.filePath,
          texts: turns.map((t) => t.text),
        });
        n += 1;
      } catch {
        /* 单文件失败不阻断 */
      }
    }
  }
  return n;
}
