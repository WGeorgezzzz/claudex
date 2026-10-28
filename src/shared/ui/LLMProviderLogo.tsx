import type { LLMProvider } from '@/shared/types';
import ClaudeLogo from '@/shared/ui/ClaudeLogo';
import CodexLogo from '@/shared/ui/CodexLogo';
import CursorLogo from '@/shared/ui/CursorLogo';
import OpenCodeLogo from '@/shared/ui/OpenCodeLogo';

type LLMProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

/** Used by the chat, onboarding, project-workspace, settings and sidebar modules to show which coding agent a session or project belongs to. */
export function LLMProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: LLMProviderLogoProps) {
  if (provider === 'gemini') return <img src="/model-logos/gemini-color.svg" alt="Gemini" className={`${className} object-contain`} />;
  if (provider === 'deepseek-harness') return <img src="/model-logos/deepseek-color.svg" alt="DeepSeek Harness" className={`${className} object-contain`} />;
  if (provider === 'workbuddy') {
    // Use the official WorkBuddy brand asset, shared by every provider selector.
    return <img src="/workbuddy-logo.svg" alt="WorkBuddy" className={className} />;
  }

  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
