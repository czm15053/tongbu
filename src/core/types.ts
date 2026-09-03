/** 统一时间线的一条消息：user + assistant 最终回复；Rich 时 assistant.events 带思考/工具 */
export type UnifiedTurn = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string; // ISO 8601
  provider?: string; // 生成该条回复的 Provider id
  events?: ProcessEvent[]; // Rich：思考 / 工具调用 / 工具返回（入账，参与交接）
  /** 本轮 token 用量（源侧 parse 提取，目标侧 build 落盘真实值；无则 undefined） */
  usage?: TokenUsage;
};

/** 指向某个 Provider 的一个原生会话 */
export type SessionRef = {
  provider: string;
  sessionId: string;
  filePath: string; // 原生会话文件绝对路径
  cwd: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ProviderInfo = {
  id: string;
  displayName: string;
  available: boolean; // detect() 结果：本机 CLI 已装已登录
};

/**
 * 过程事件。
 * 直播展示：detail 由 events.ts 截断 ≤500。
 * Rich 交接：parse 写入完整 detail/input，参与 import。
 */
export type ProcessEvent = {
  kind: 'thinking' | 'tool_call' | 'tool_result' | 'text'; // text = 中间说明/commentary
  summary: string; // 单行摘要，如 "Bash: ls -la" / "思考中…（加密）"
  detail?: string;
  timestamp: string; // ISO 8601
  provider: string;
  name?: string; // 工具名
  callId?: string;
  input?: unknown;
  /**
   * 附件（图片/文件）数据。text 事件可携带：语义上该 turn 含一段媒体内容，
   * 文本占位（summary/detail）保证可读；attachment 承载原始数据供 build 还原原生块。
   * 不落入 round-trip 校验（assertRoundTrip 只查 thinking/tool_call/tool_result）——
   * 目标 build 不支持时安全降级为丢弃，仅保留文本占位。
   */
  attachment?: {
    kind: 'image' | 'file';
    mediaType?: string;
    /** base64 数据（claude image source.data） */
    data?: string;
    /** 外部 url / data URI（opencode file.url） */
    url?: string;
    filename?: string;
  };
};
