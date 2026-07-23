import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatRunEvent, ChatRunProjection } from '@geneway/contracts';
import { api, type Conversation } from './api.js';

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MODEL_ROUTE_UNAVAILABLE: '真实模型通道未配置或不可用。请完成本机凭据与通道校验后重试。',
  MODEL_AUTH_FAILED: '真实模型通道鉴权失败，请检查本机订阅凭据。',
  MODEL_QUOTA: '真实模型通道当前已达到额度限制，请稍后再试。',
  MODEL_TIMEOUT: '本次回答超时，请重新发送。',
  MODEL_STREAM_INTERRUPTED: '回答在传输中断开，请重新发送。',
  MODEL_PROTOCOL_VIOLATION: '模型返回了不允许的内容类型，本次回答已安全终止。',
  CHAT_BUSY: '真实模型通道正在处理另一条消息，请稍后再试。',
};

function publicError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = message.split(':', 1)[0] ?? '';
  return ERROR_MESSAGES[code] ?? '消息发送失败，请稍后重试。';
}

export function FastChatExperience({ conversationId: explicitConversationId }: Readonly<{ conversationId?: string }>) {
  const [conversation, setConversation] = useState<Conversation>();
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState<ChatRunProjection>();
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<Conversation> => {
    if (explicitConversationId !== undefined) return api.getConversation(explicitConversationId);
    const created = await api.createConversation();
    window.history.replaceState({}, '', `/conversations/${created.id}`);
    return api.getConversation(created.id);
  }, [explicitConversationId]);

  const follow = useCallback(async (conversationId: string, invocation: ChatRunProjection) => {
    let cursor = invocation.eventCursor;
    let reconnectFailures = 0;
    for (let attempt = 0; attempt < 600 && mounted.current; attempt += 1) {
      let events: readonly ChatRunEvent[];
      try {
        events = (await api.chatEvents(conversationId, invocation.modelInvocationId, cursor))
          .filter((event) => event.cursor > cursor);
        reconnectFailures = 0;
      } catch (cause) {
        reconnectFailures += 1;
        try {
          const snapshot = await api.getConversation(conversationId);
          setConversation(snapshot);
          if (snapshot.latestModelInvocation === null
            || ['completed', 'failed', 'canceled'].includes(snapshot.latestModelInvocation.status)) break;
          cursor = Math.max(cursor, snapshot.eventWatermark);
        } catch {
          // The same network fault can affect both SSE and its recovery snapshot.
          // Retain the committed cursor and retry after bounded backoff.
        }
        if (reconnectFailures >= 6) throw cause;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_500, reconnectFailures * 250)));
        continue;
      }
      if (events.length > 0) {
        cursor = Math.max(cursor, ...events.map((event) => event.cursor));
        const latest = events.at(-1);
        setConversation((current) => current === undefined ? current : {
          ...current,
          eventWatermark: cursor,
          messages: current.messages.map((message) => message.id !== invocation.assistantMessageId ? message : {
            ...message,
            body: latest !== undefined && 'checkpoint' in latest ? latest.checkpoint : message.body,
            status: latest?.eventType === 'message.completed' ? 'completed'
              : latest?.eventType === 'run.failed' ? 'failed'
              : latest?.eventType === 'run.canceled' ? 'canceled' : 'streaming',
          }),
        });
        if (events.some((event) => ['message.completed', 'run.failed', 'run.canceled'].includes(event.eventType))) break;
      }
      const snapshot = await api.getConversation(conversationId);
      setConversation(snapshot);
      if (snapshot.latestModelInvocation === null || ['completed', 'failed', 'canceled'].includes(snapshot.latestModelInvocation.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (mounted.current) {
      setConversation(await api.getConversation(conversationId));
      setRunning(undefined);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load().then((snapshot) => {
      setConversation(snapshot);
      const invocation = snapshot.latestModelInvocation;
      if (invocation !== null && ['pending', 'running', 'cancel_requested'].includes(invocation.status)) {
        const projection: ChatRunProjection = {
          conversationId: snapshot.id,
          userMessageId: snapshot.messages.filter((message) => message.author === 'user').at(-1)?.id ?? '',
          assistantMessageId: invocation.assistantMessageId,
          modelInvocationId: invocation.id,
          eventCursor: invocation.lastEventCursor,
          status: invocation.status,
        };
        setRunning(projection);
        void follow(snapshot.id, projection).catch((cause: unknown) => setError(publicError(cause)));
      }
    }).catch((cause: unknown) => setError(publicError(cause)));
    return () => { mounted.current = false; };
  }, [follow, load]);

  const send = async () => {
    const content = draft.normalize('NFC').trim();
    if (conversation === undefined || content.length === 0 || running !== undefined) return;
    setDraft('');
    setError(undefined);
    try {
      const invocation = await api.createChatRun(conversation.id, content);
      setRunning(invocation);
      setConversation(await api.getConversation(conversation.id));
      await follow(conversation.id, invocation);
    } catch (cause) {
      setError(publicError(cause));
      const snapshot = await api.getConversation(conversation.id).catch(() => conversation);
      setConversation(snapshot);
      if (snapshot.latestModelInvocation === null
        || ['completed', 'failed', 'canceled'].includes(snapshot.latestModelInvocation.status)) setRunning(undefined);
    }
  };

  const cancel = async () => {
    if (conversation === undefined || running === undefined || canceling) return;
    setCanceling(true);
    setError(undefined);
    try {
      await api.cancelChatRun(conversation.id, running.modelInvocationId);
      setConversation(await api.getConversation(conversation.id));
    } catch (cause) {
      setError(publicError(cause));
    } finally {
      setCanceling(false);
    }
  };

  return <main className="fast-chat-shell" data-testid="geneway-fast-chat" data-conversation-id={conversation?.id ?? ''}
    data-model-invocation-id={running?.modelInvocationId ?? conversation?.latestModelInvocation?.id ?? ''}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">纬</span><div><strong>geneway</strong><small>制造业数字员工</small></div></div>
      <a className="new-task" href="/conversations/new">＋ 新建会话</a>
      <nav><b>工作区</b><a className="nav-active" href="/conversations/new">小纬</a><a href="/tasks">我的任务</a><a href="/workflows">Workflow</a></nav>
      <a className="material-analysis-link" data-testid="material-analysis-link" href="/conversations/new?capability=solution.analysis.v1">分析材料</a>
    </aside>
    <section className="fast-chat-pane">
      <header className="topbar"><div><h1>小纬</h1><p>普通聊天 · 真实模型 · 无工具</p></div><span className="live-boundary">trusted-local</span></header>
      <div className="thread" data-testid="message-thread">
        {(conversation?.messages.length ?? 0) === 0 && <section className="welcome-empty" data-testid="welcome-empty">
          <div className="avatar">纬</div><div><b>你好，我是小纬</b><p>直接输入普通文本即可开始，无需上传材料。我不会在此模式访问联网搜索、企业知识或生产系统。</p></div>
        </section>}
        {conversation?.messages.map((message) => <article className={`message ${message.author}`} key={message.id}
          data-author={message.author} data-message-id={message.id} data-message-status={message.status}>
          <div className="avatar">{message.author === 'xiaowei' ? '纬' : '你'}</div>
          <div><b>{message.author === 'xiaowei' ? '小纬' : '你'}</b><p>{message.body || (message.status === 'streaming' ? '正在生成…' : '')}</p>
            {message.status !== 'completed' && <small>{message.status === 'streaming' ? '实时生成中' : '本次回答未完成'}</small>}
          </div>
        </article>)}
        {error !== undefined && <div className="error" role="alert">{error}</div>}
      </div>
      <form className="fast-chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea aria-label="给小纬发消息" value={draft} maxLength={16 * 1024} disabled={conversation === undefined || running !== undefined}
          placeholder="给小纬发消息…" onChange={(event) => setDraft(event.target.value)} />
        {running === undefined
          ? <button className="send" type="submit" disabled={conversation === undefined || draft.trim().length === 0}>发送</button>
          : <button className="secondary" type="button" data-testid="stop-generation" disabled={canceling}
            onClick={() => void cancel()}>{canceling ? '正在停止…' : '停止生成'}</button>}
      </form>
      <footer className="chat-safety-note">回答可能有误，请核对重要信息。普通聊天不会创建 BusinessTask、Workflow、Evidence 或 Artifact。</footer>
    </section>
  </main>;
}
