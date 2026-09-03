import type { FileDigest } from '../core/atomic.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../core/types.js';

export type ImportTurnsOpts = { replace?: boolean };

/**
 * Provider 适配器：每家 CLI 一个实现。
 * 新增 Provider = 新增 providers/<name>/ 目录 + registry 注册一行。
 */
export interface ProviderAdapter {
  readonly id: string; // 'claude' | 'codex' | ...
  readonly displayName: string;

  /** 本机 CLI 已安装且已登录？ */
  detect(): Promise<boolean>;

  /** 原生会话 → 统一时间线（Rich：user + assistant 最终回复 + thinking/tools） */
  parse(ref: SessionRef): Promise<UnifiedTurn[]>;

  /**
   * 统一时间线 → 原生会话。
   * `into` 有且文件在：把 turns 追加进该会话（不新建）；否则 create-if-absent。
   * `opts.replace`：按同一 sessionId 整文件重写（补过程事件，避免工具排在最终回复之后）。
   */
  importTurns(turns: UnifiedTurn[], cwd: string, into?: SessionRef, opts?: ImportTurnsOpts): Promise<SessionRef>;

  /** 可选：会话内容指纹（写回 TOCTOU 检测用）；不实现 = 跳过检测（如 opencode 共享 db） */
  contentFingerprint?(ref: SessionRef): Promise<FileDigest | null>;

  /** 从零开聊：CLI 起新会话发首条消息，返回新会话引用与 agent 最终回复。onEvent 接收过程事件（仅展示） */
  start(cwd: string, text: string, onEvent?: (e: ProcessEvent) => void): Promise<{ ref: SessionRef; turn: UnifiedTurn }>;

  /** 在当前会话中发送一条用户消息，返回 agent 最终回复。onEvent 接收过程事件（仅展示） */
  send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn>;

  /**
   * 可选：创建一个可直接被原生 CLI `resume` 的空会话（无 exec 发首条消息）。
   * 桌面端按 nezha 方式交互启动时，空链不再调用 start，而是走这里拿到 ref 后
   * 直接 `codex resume <id>` / `pi --session <id>` 进 PTY。
   */
  createEmptySession?(cwd: string): Promise<SessionRef>;

  /** 可选：写入该 Provider 前的环境检查（如 Codex Desktop 互斥），不通过则抛错 */
  preflight?(): Promise<void>;

  /** 可选（TUI 交接用）：找 cwd 下本 provider 最新的原生会话；没有返回 null */
  findLatestSession?(cwd: string): Promise<{ ref: SessionRef; updatedAt: number } | null>;

  /** 可选（桌面壳用）：列 cwd 下本 provider 的原生会话，mtime 降序 */
  listSessions?(cwd: string): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]>;

  /** 展示用：回到原生 CLI 继续的命令，如 `claude --resume <id>` */
  resumeCommand(ref: SessionRef): string;

  /** 可选（`tongbu open` 用）：按原生 session id 全局反查会话（不限 cwd）；找不到返回 null */
  findById?(sessionId: string): Promise<{ ref: SessionRef; updatedAt: number } | null>;

  /** 可选：扫描原生文件的 token 用量（不全量 parse 时间线） */
  sessionUsage?(ref: SessionRef): Promise<TokenUsage | null>;
}
