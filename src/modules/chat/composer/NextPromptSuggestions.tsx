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
  return <section aria-label={t('nextPrompts.title')} className="mx-4 mb-2 space-y-1">
    <p className="text-[11px] text-muted-foreground">{t('nextPrompts.hint')}</p>
    <div className="flex flex-wrap gap-2">{prompts.map(prompt => <button key={prompt} type="button" onClick={() => onInsert(prompt)} className="flex max-w-full items-start gap-1 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted">
      <ArrowUpRight size={13} className="mt-0.5 shrink-0"/><span className="break-words">{prompt}</span>
    </button>)}</div>
  </section>;
}
