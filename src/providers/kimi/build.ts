import { execFile } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../core/atomic.js';
import { verifyWrittenTurns } from '../../core/verify.js';
import { parseKimiSession } from './parse.js';
import type { ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';

const execFileAsync = promisify(execFile);

const HEADER_TYPES = new Set(['metadata', 'runtime.set_binding', 'profile.bind', 'permission.set_mode']);

export function kimiSessionsRoot(): string {
  return path.join(homedir(), '.kimi-code', 'sessions');
}

/** Kimi workspaceId：wd_<sanitized-name>_<sha256(cwd).slice(0,12)> */
export function encodeKimiWorkspaceDir(cwd: string): string {
  const base = path.basename(cwd);
  let name = base
    .replace(/[^a-zA-Z0-9.-]/g, '')
    .toLowerCase()
    .slice(0, 40);
  if (!name) name = 'workspace';
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return `wd_${name}_${hash}`;
}

export function kimidir(): string {
  return path.join(homedir(), '.kimi-code');
}

/**
 * 通过 session_index.jsonl 把 workDir 映射到 session 目录。
 * 该文件由 Kimi 维护，比扫描目录更可靠。
 */
export async function listKimiSessionsByCwd(
  cwd: string,
): Promise<{ sessionId: string; sessionDir: string; updatedAt: number }[]> {
  const indexPath = path.join(kimidir(), 'session_index.jsonl');
  const items: { sessionId: string; sessionDir: string; updatedAt: number }[] = [];
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch {
    return [];
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.workDir !== cwd) continue;
    const sessionDir = typeof rec.sessionDir === 'string' ? rec.sessionDir : '';
    const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : '';
    if (!sessionDir || !sessionId) continue;
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    try {
      const st = await stat(wirePath);
      items.push({ sessionId, sessionDir, updatedAt: st.mtimeMs });
    } catch {
      // wire.jsonl 已删，跳过
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/**
 * 新建一个真实的 Kimi 会话（用最小提示词），然后截断 wire.jsonl 到只剩头部事件。
 * 返回 sessionId 与 wire.jsonl 路径。
 */
async function createRealKimiSession(cwd: string): Promise<{ sessionId: string; filePath: string }> {
  let stdout: string;
  try {
    const out = await execFileAsync(resolveCli('kimi'), ['-p', '.', '--output-format', 'stream-json'], {
      cwd,
      timeout: 120_000,
    });
    stdout = out.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown };
    if (err.code === 'ENOENT') {
      throw new Error('找不到 kimi code：当前进程 PATH 中没有 kimi 命令');
    }
    const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const detail = (pick(err.stderr) || pick(err.stdout) || err.message || String(error)).slice(0, 500);
    throw new Error(`kimi 新建会话失败: ${detail}`);
  }

  const sessionId = extractSessionIdFromStream(stdout);
  if (!sessionId) {
    throw new Error(`kimi 输出缺少 session.resume_hint: ${stdout.slice(0, 500)}`);
  }

  const workspaceId = encodeKimiWorkspaceDir(cwd);
  const filePath = path.join(kimiSessionsRoot(), workspaceId, sessionId, 'agents', 'main', 'wire.jsonl');

  // 截断到头部事件，去掉刚才的 dummy prompt 产生的对话
  await truncateToHeader(filePath);

  return { sessionId, filePath };
}

function extractSessionIdFromStream(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.role === 'meta' && event.type === 'session.resume_hint' && typeof event.session_id === 'string') {
      return event.session_id;
    }
  }
  return null;
}

async function truncateToHeader(filePath: string): Promise<void> {
  const raw = await readFile(filePath, 'utf8');
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (HEADER_TYPES.has(typeof event.type === 'string' ? event.type : '')) {
      lines.push(line);
    }
  }
  await writeFileAtomic(filePath, lines.join('\n') + (lines.length ? '\n' : ''), { backup: true });
}

async function readHeaderLines(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (HEADER_TYPES.has(typeof event.type === 'string' ? event.type : '')) {
      lines.push(line);
    }
  }
  return lines;
}

function nextTurnId(filePath: string): number {
  let maxTurn = -1;
  try {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'turn.ended') {
        const turnId = typeof event.turnId === 'number' ? event.turnId : -1;
        if (turnId > maxTurn) maxTurn = turnId;
      }
    }
  } catch {
    // ignore
  }
  return maxTurn + 1;
}

function tsMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/** kimi step.end 的 usage 形状：有源侧真实用量时写入，否则 0 占位 */
function kimiUsage(turn: UnifiedTurn): { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number } {
  return {
    inputOther: turn.usage?.inputTokens ?? 0,
    output: turn.usage?.outputTokens ?? 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
}

/** 把 UnifiedTurn[] 写成 Kimi wire.jsonl 尾部事件 */
export function buildKimiWireLines(turns: UnifiedTurn[], startTurnId: number): string[] {
  const lines: string[] = [];
  let turnId = startTurnId;

  // 把各 turn 时间戳规整为严格递增：同源导入常把所有 turn 打成同一时刻，
  // Kimi 会把它当成同一轮，导致历史丢失。每轮至少错开 1 秒。
  let lastTurnTime = 0;
  const turnTimes: number[] = [];
  for (const turn of turns) {
    let t = tsMs(turn.timestamp);
    if (t <= lastTurnTime) t = lastTurnTime + 1000;
    turnTimes.push(t);
    lastTurnTime = t;
  }

  // 同一 step 内相邻事件的时间间隔。Kimi 原生通常为 0–2ms；这里用 100ms
  // 确保即使 Kimi 按毫秒级时间排序，最终文本也严格落在 tool/thinking 之后。
  const EVENT_DT = 100;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const t = turnTimes[i]!;

    if (turn.role === 'user') {
      const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      lines.push(
        JSON.stringify({
          type: 'turn.prompt',
          agentId: 'main',
          input: [{ type: 'text', text: turn.text }],
          origin: { kind: 'user' },
          time: t,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'context.append_message',
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: turn.text }],
            toolCalls: [],
            origin: { kind: 'user' },
            id: msgId,
          },
          time: t + 1,
        }),
      );
      continue;
    }

    const turnIdStr = String(turnId);
    const events = turn.events ?? [];
    const hasText = turn.text.trim().length > 0;
    const hasEvents = events.length > 0;

    const hasToolCalls = events.some((e) => e.kind === 'tool_call');

    // Step 1：thinking / tool.call / tool.result。
    // Kimi TUI 在同一个 step 内会把所有 content.part 排在 tool.call 之前，
    // 因此最终文本必须放在独立的 step 2，才能显示在工具调用之后。
    if (hasEvents) {
      const stepUuid1 = randomUUID();
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: { type: 'step.begin', uuid: stepUuid1, turnId: turnIdStr, step: 1 },
          time: t,
        }),
      );
      for (let i = 0; i < events.length; i++) {
        lines.push(...eventToWireLines(events[i]!, turnIdStr, stepUuid1, t + 2 + i * EVENT_DT));
      }
      const step1EndTime = t + 2 + events.length * EVENT_DT;
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: {
            type: 'step.end',
            uuid: stepUuid1,
            turnId: turnIdStr,
            step: 1,
            finishReason: hasToolCalls ? 'tool_use' : 'end_turn',
            usage: kimiUsage(turn),
          },
          time: step1EndTime,
        }),
      );
    }

    // Step 2：最终回复文本（如果有）。
    let finalEndTime = t + 2 + events.length * EVENT_DT;
    if (hasText) {
      const textStartTime = finalEndTime + EVENT_DT;
      const stepUuid2 = randomUUID();
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: { type: 'step.begin', uuid: stepUuid2, turnId: turnIdStr, step: hasEvents ? 2 : 1 },
          time: textStartTime,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: {
            type: 'content.part',
            uuid: randomUUID(),
            turnId: turnIdStr,
            step: hasEvents ? 2 : 1,
            stepUuid: stepUuid2,
            part: { type: 'text', text: turn.text },
          },
          time: textStartTime + 1,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'context.append_loop_event',
          agentId: 'main',
          event: {
            type: 'step.end',
            uuid: stepUuid2,
            turnId: turnIdStr,
            step: hasEvents ? 2 : 1,
            finishReason: 'end_turn',
            usage: kimiUsage(turn),
          },
          time: textStartTime + 2,
        }),
      );
      finalEndTime = textStartTime + 3;
    }

    lines.push(
      JSON.stringify({
        type: 'turn.ended',
        agentId: 'main',
        turnId,
        reason: 'completed',
        durationMs: 1,
        time: finalEndTime,
      }),
    );

    turnId += 1;
  }

  return lines;
}

function eventToWireLines(ev: ProcessEvent, turnId: string, stepUuid: string, time: number): string[] {
  const t = time;
  if (ev.kind === 'thinking') {
    const think = ev.detail ?? ev.summary;
    return [
      JSON.stringify({
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'content.part',
          uuid: randomUUID(),
          turnId,
          step: 1,
          stepUuid,
          part: { type: 'think', think },
        },
        time: t,
      }),
    ];
  }

  if (ev.kind === 'tool_call') {
    const callUuid = randomUUID();
    const callId = ev.callId ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return [
      JSON.stringify({
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'tool.call',
          uuid: callUuid,
          turnId,
          step: 1,
          stepUuid,
          toolCallId: callId,
          name: ev.name ?? 'tool',
          args: ev.input ?? {},
        },
        time: t,
      }),
    ];
  }

  if (ev.kind === 'tool_result') {
    return [
      JSON.stringify({
        type: 'context.append_loop_event',
        agentId: 'main',
        event: {
          type: 'tool.result',
          parentUuid: randomUUID(),
          turnId,
          step: 1,
          stepUuid,
          toolCallId: ev.callId ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          result: { output: ev.detail ?? ev.summary ?? '' },
        },
        time: t,
      }),
    ];
  }

  return [];
}

/** UnifiedTurn[] → Kimi wire.jsonl；无 into 时新建真实会话，再重写历史 */
export async function importTurnsToKimi(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }

  let filePath: string;
  let sessionId: string;

  if (into?.filePath) {
    filePath = into.filePath;
    sessionId = into.sessionId;
  } else {
    const created = await createRealKimiSession(cwd);
    filePath = created.filePath;
    sessionId = created.sessionId;
  }

  const headerLines = await readHeaderLines(filePath);
  const startTurnId = opts?.replace ? 0 : nextTurnId(filePath);

  // replace 为 true 时仍保留已有头部；历史内容用 turns 重写
  const bodyLines = buildKimiWireLines(turns, startTurnId);
  await writeFileAtomic(filePath, [...headerLines, ...bodyLines].join('\n') + '\n', {
    backup: Boolean(into?.filePath),
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parseKimiSession({ provider: 'kimi', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'kimi',
      }),
  });

  return { provider: 'kimi', sessionId, filePath, cwd };
}
