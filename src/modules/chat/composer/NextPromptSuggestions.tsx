import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';
import { readClaudeNextPrompts } from '@/shared/utils';

/** ChatInterface displays contextual suggestions, or clearly labelled quick replies, as draft-only actions. */
export function NextPromptSuggestions({ messages, busy, onInsert }: { messages: ChatMessage[]; busy: boolean; onInsert: (prompt: string) => void }) {
  const { t } = useTranslation('chat');
  if (busy) return null;
  let prompts: string[] = [];
  let latestReply = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === 'user' || message.type === 'error') break;
    if (message.type !== 'assistant' || message.isToolUse || message.isThinking || message.isStreaming) continue;
    if (!latestReply) latestReply = String(message.content || '').trim();
    prompts = readClaudeNextPrompts(String(message.content || '')).prompts;
    if (prompts.length) break;
  }
  if (!latestReply) return null;
  const contextual = prompts.length > 0;
  // Models and older transcripts can omit the optional marker. Keep the reply
  // affordance available without presenting stock replies as generated advice.
  if (!contextual) prompts = [t('nextPrompts.continue'), t('nextPrompts.explain'), t('nextPrompts.review')];
  return <section aria-label={t(contextual ? 'nextPrompts.title' : 'nextPrompts.quickTitle')} title={t('nextPrompts.hint')} className="next-prompt-suggestions mx-auto mb-2 w-full max-w-[54.25rem] px-4">
    <p className="mb-1 text-[10px] text-muted-foreground">{t(contextual ? 'nextPrompts.title' : 'nextPrompts.quickTitle')}</p>
    <div className="grid gap-2 pb-1" style={{ gridTemplateColumns: `repeat(${prompts.length}, minmax(0, 1fr))` }}>{prompts.map(prompt => <button key={prompt} type="button" title={prompt} onClick={() => onInsert(prompt)} className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted">
      <ArrowUpRight size={13} className="hidden shrink-0 sm:block"/><span className="line-clamp-2 break-words">{prompt}</span>
    </button>)}</div>
  </section>;
}
