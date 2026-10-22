import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '@/shared/types';
import { readClaudeNextPrompts } from '@/shared/utils';

/** ChatInterface displays the latest completed Claude reply's suggestions as draft-only actions. */
export function NextPromptSuggestions({ messages, busy, onInsert }: { messages: ChatMessage[]; busy: boolean; onInsert: (prompt: string) => void }) {
  const { t } = useTranslation('chat');
  if (busy) return null;
  let prompts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === 'user' || message.type === 'error') break;
    if (message.type !== 'assistant' || message.isToolUse || message.isThinking || message.isStreaming) continue;
    prompts = readClaudeNextPrompts(String(message.content || '')).prompts;
    if (prompts.length) break;
  }
  if (!prompts.length) return null;
  return <section aria-label={t('nextPrompts.title')} title={t('nextPrompts.hint')} className="next-prompt-suggestions mx-auto mb-2 w-full max-w-[54.25rem] px-4">
    <div className="scrollbar-hide flex gap-2 overflow-x-auto pb-1">{prompts.map(prompt => <button key={prompt} type="button" title={prompt} onClick={() => onInsert(prompt)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted">
      <ArrowUpRight size={13} className="shrink-0"/><span className="line-clamp-2 break-words">{prompt}</span>
    </button>)}</div>
  </section>;
}
