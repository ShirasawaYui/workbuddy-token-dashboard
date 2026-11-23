/**
 * 单行 JSONL → 规范化用量记录。
 *
 * 关键事实（已对真实数据验证）：
 * 1. token 用量只挂在 providerData.rawUsage 上，出现在 type 为
 *    function_call / message 的行（即每一次真实的大模型请求）。
 * 2. providerData.messageId 在全部样本中全局唯一（404/404），
 *    是天然的"一次请求"主键；traceId 是"一轮对话"（内含多次请求），
 *    不能用来计数。
 * 3. rawUsage 是单次请求的增量值，不是累计值。
 * 4. rawUsage.credit 是平台算好的结算单位，无需自建价格表。
 */

const num = (v) => (Number.isFinite(v) ? v : 0);

/** 从一行的 providerData 中提取用量，没有则返回 null */
export function extractUsage(line) {
  const pd = line.providerData;
  if (!pd) return null;

  // 优先 rawUsage（字段最全），退化为 usage / message.usage
  const ru = pd.rawUsage;
  const fallback = pd.usage || {};
  const msgUsage = (line.message && line.message.usage) || {};

  const prompt = num(ru ? ru.prompt_tokens : fallback.inputTokens ?? msgUsage.input_tokens);
  const completion = num(ru ? ru.completion_tokens : fallback.outputTokens ?? msgUsage.output_tokens);
  const total = num(ru ? ru.total_tokens : fallback.totalTokens ?? msgUsage.total_tokens);

  if (total === 0 && prompt === 0 && completion === 0) return null;

  const cacheRead = num(
    ru
      ? ru.prompt_cache_hit_tokens ?? (ru.prompt_tokens_details || {}).cached_tokens
      : msgUsage.cache_read_input_tokens,
  );
  const cacheMiss = num(ru ? ru.prompt_cache_miss_tokens : prompt - cacheRead);
  const reasoning = num(
    ru ? ru.completion_thinking_tokens ?? (ru.completion_tokens_details || {}).reasoning_tokens : 0,
  );

  return {
    id: pd.messageId || line.messageId || line.id,
    prompt,
    completion,
    total: total || prompt + completion,
    cacheRead,
    cacheMiss,
    reasoning,
    credit: num(ru && ru.credit),
  };
}

/**
 * 把一行压成时间线上的一个"显著事件"。
 *
 * 为什么只留这三类：耗时不在任何字段里，只能靠**相邻事件的 timestamp 差**还原。
 * 而真正划分时间段的只有三种边界——
 *   - msg/user  用户发消息（上一段是"用户在想/离开"）
 *   - fc        模型带着用量完成一次响应（上一段是"模型生成"）
 *   - fcr       工具返回（上一段是"工具执行"）
 * reasoning / file-history-snapshot / session-meta 都夹在中间且时间戳几乎重合，
 * 留着只会把 127 秒的生成时间错记到某个 18 毫秒的碎行头上，所以直接丢掉。
 *
 * @param {object} o 一行 JSON
 * @returns {{t:number, ty:string, mid?:string, cid?:string, nm?:string, role?:string, u?:number}|null}
 */
function toEvent(o) {
  const t = o.timestamp;
  if (!Number.isFinite(t)) return null;
  const pd = o.providerData || {};

  // function_call 有两种：带用量的那条 = 本次请求的完成点；其余是同一响应的并行工具调用
  if (o.type === 'function_call') {
    return { t, ty: 'fc', mid: pd.messageId || '', cid: o.callId || '', nm: o.name || '', u: pd.rawUsage ? 1 : 0 };
  }
  if (o.type === 'function_call_result') {
    return { t, ty: 'fcr', cid: o.callId || '', nm: o.name || '' };
  }
  if (o.type === 'message') {
    return { t, ty: 'msg', role: o.role || '', mid: pd.messageId || '', u: pd.rawUsage ? 1 : 0 };
  }
  return null;
}

/**
 * 解析一份 JSONL 文本块，返回 { records, meta, events }。
 * @param {string} text 文本内容（必须是完整的行，末尾可以没有换行）
 * @param {object} ctx  { projectId, sessionId, cwd, isSubagent, agentId }
 *   isSubagent=true 时 ctx.sessionId 是**父会话** ID：子代理会话写在
 *   <父会话>/subagents/agent-*.jsonl 里，行内 o.sessionId 是它自己的内部
 *   会话 ID（另一个命名空间），归账一律算到父会话头上。
 */
export function parseChunk(text, ctx) {
  const records = [];
  const meta = {};
  /** 时间线事件，保持文件内的原始顺序（追加写 ⇒ 顺序即真实顺序） */
  const events = [];
  const lines = text.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 容忍截断/脏行
    }

    // 会话元信息
    if (o.type === 'ai-title' && o.aiTitle) meta.title = o.aiTitle;
    if (o.cwd) meta.cwd = o.cwd;
    if (o.sessionId && !ctx.isSubagent) meta.sessionId = o.sessionId;

    /**
     * credit-usage：团队成员（子代理）消耗的**结算镜像行**。
     * WorkBuddy 5.x 起写在父会话文件里，只有 credit 一个数字，token 明细
     * 在 subagents/ 的会话文件里（同一笔钱的两种记法，messageId 互不重叠）。
     * 这里合成一条「只有 credit」的记录，供**没有 subagent 文件**的会话兜底
     * 不丢钱；有 subagent 文件的会话由 scanner.all() 丢弃本行（防双计）。
     */
    if (o.type === 'credit-usage') {
      const pd = o.providerData || {};
      const credit = num(pd.credit);
      if (credit > 0) {
        records.push({
          // CU 行的 pd.messageId 会重复（一条请求多段结算），必须用行级 id
          id: o.id || `${pd.messageId || 'cu'}#${records.length}`,
          sessionId: ctx.isSubagent ? ctx.sessionId : (o.sessionId || ctx.sessionId),
          projectId: ctx.projectId,
          cwd: o.cwd || ctx.cwd || '',
          ts: num(o.timestamp),
          kind: 'credit-usage',
          toolName: null,
          model: 'unknown',
          modelName: '',
          traceId: pd.traceId || '',
          requestId: pd.conversationRequestId || '',
          prompt: 0,
          completion: 0,
          total: 0,
          cacheRead: 0,
          cacheMiss: 0,
          reasoning: 0,
          credit,
          /** 标记镜像行：subagent 文件已给全量明细的会话里丢弃它 */
          creditOnly: true,
          isSubAgent: true,
          agent: pd.source === 'team_member' ? 'team-member' : (pd.source || ''),
        });
      }
      continue;
    }

    const ev = toEvent(o);
    if (ev) events.push(ev);

    const usage = extractUsage(o);
    if (!usage) continue;

    const pd = o.providerData || {};
    const isSub = ctx.isSubagent === true || pd.isSubAgent === true;
    records.push({
      id: usage.id,
      // 子代理文件的行内 sessionId 是子代理自己的内部 ID，归账必须落到父会话
      sessionId: ctx.isSubagent ? ctx.sessionId : (o.sessionId || ctx.sessionId),
      projectId: ctx.projectId,
      cwd: o.cwd || ctx.cwd || '',
      ts: num(o.timestamp),
      kind: o.type || 'unknown', // function_call / message
      toolName: o.name || null,
      model: pd.model || 'unknown',
      modelName: pd.requestModelName || '',
      traceId: pd.traceId || '',
      requestId: pd.conversationRequestId || '',
      /** 子代理标记：文件在 subagents/ 下，或行内 isSubAgent=true */
      isSubAgent: isSub,
      agent: isSub ? (pd.agent || ctx.agentId || '') : '',
      ...usage,
    });
  }

  return { records, meta, events };
}
