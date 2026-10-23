import { ArrowUpRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';
import { readClaudeNextPrompts } from '@/shared/utils';
import { api } from '@/shared/api';

/** ChatInterface displays only conversation-grounded model output; clicking fills the draft without sending. */
export function NextPromptSuggestions({ messages, busy, onInsert, sessionId, provider }: {
  messages: ChatMessage[]; busy: boolean; onInsert: (prompt: string) => void; sessionId?: string | null; provider?: string;
}) {
  const { t } = useTranslation('chat');
  const latest = useMemo(() => {
    let reply = '';
    let id = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.type === 'user' || message.type === 'error' || message.isStreaming) break;
      if (message.type !== 'assistant' || message.isToolUse || message.isThinking) continue;
      if (!reply) { reply = String(message.content || '').trim(); id = String(message.id ?? ''); }
      const prompts = readClaudeNextPrompts(String(message.content || '')).prompts;
      if (prompts.length) return { reply, id, prompts };
    }
    return { reply, id, prompts: [] as string[] };
  }, [messages]);
  const key = `${sessionId ?? ''}:${latest.id}:${latest.reply}`;
  // Bind async results to the exact displayed reply so navigation cannot show stale choices.
  const [generated, setGenerated] = useState<{ key: string; status: 'loading' | 'error' | 'ready'; prompts: string[] } | null>(null);
  // Only an explicit retry starts another request after a generation failure.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (busy || !sessionId || provider !== 'claude' || !latest.reply || latest.prompts.length) return;
    const controller = new AbortController();
    setGenerated({ key, status: 'loading', prompts: [] });
    void (async () => {
      try {
        let data;
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await api.providers.replySuggestions(sessionId, latest.reply.slice(-2000), { signal: controller.signal });
          if (!response.ok) throw new Error('Generation failed');
          const payload = await response.json();
          data = payload.data ?? payload;
          if (data.status !== 'stale') break;
          if (attempt === 2) throw new Error('Reply changed before generation');
          // Completion can arrive just before the provider flushes its transcript.
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 700);
            controller.signal.addEventListener('abort', finish, { once: true });
          });
          if (controller.signal.aborted) return;
        }
        const prompts: unknown = data.replies;
        if (!Array.isArray(prompts) || prompts.length > 3 || !prompts.every(prompt => typeof prompt === 'string' && prompt.trim() && prompt.length <= 300)) throw new Error('Invalid suggestions');
        if (!controller.signal.aborted) setGenerated({ key, status: 'ready', prompts });
      } catch {
        if (!controller.signal.aborted) setGenerated({ key, status: 'error', prompts: [] });
      }
    })();
    return () => controller.abort();
  }, [key, sessionId, provider, busy, latest.reply, latest.prompts.length, retry]);
  if (busy || !latest.reply) return null;
  const current = generated?.key === key ? generated : null;
  const prompts = latest.prompts.length ? latest.prompts : current?.status === 'ready' ? current.prompts : [];
  if (!prompts.length) {
    if (!current || current.status === 'ready') return null;
    return <div role="status" className="next-prompt-suggestions mx-auto mb-2 w-full max-w-[54.25rem] px-4 text-xs text-muted-foreground">
      {t(current.status === 'loading' ? 'nextPrompts.generating' : 'nextPrompts.failed')}
      {current.status === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)} className="ml-2 underline">{t('nextPrompts.retry')}</button>}
    </div>;
  }
  return <section aria-label={t('nextPrompts.title')} title={t('nextPrompts.hint')} className="next-prompt-suggestions mx-auto mb-2 w-full max-w-[54.25rem] px-4">
    <p className="mb-1 text-[10px] text-muted-foreground">{t('nextPrompts.title')}</p>
    <div className="grid gap-2 pb-1" style={{ gridTemplateColumns: `repeat(${prompts.length}, minmax(0, 1fr))` }}>{prompts.map(prompt => <button key={prompt} type="button" title={prompt} onClick={() => onInsert(prompt)} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted">
      <ArrowUpRight size={13} className="hidden shrink-0 sm:block"/><span className="line-clamp-2 break-words">{prompt}</span>
    </button>)}</div>
  </section>;
}
