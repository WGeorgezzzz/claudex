import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';

/** Sidebar desktop menus and mobile sheets share title request progress and errors. */
export function useSessionTitleGeneration(sessionId: string) {
  const { t } = useTranslation('sidebar');
  // Keep the action disabled until the owner-scoped generation request settles.
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const regenerateTitle = async () => {
    if (generatingTitle) return;
    setGeneratingTitle(true);
    try {
      const response = await api.regenerateSessionTitle(sessionId);
      const body = await response.json();
      if (!response.ok || body.data?.status !== 'ready') throw new Error('Title unavailable');
    } catch { alert(t('aiTitle.failed', { defaultValue: 'Could not generate a title. Try again later.' })); }
    finally { setGeneratingTitle(false); }
  };
  return { generatingTitle, regenerateTitle, titleActionLabel: t(generatingTitle ? 'aiTitle.generating' : 'aiTitle.regenerate', { defaultValue: generatingTitle ? 'Generating title…' : 'Regenerate title' }) };
}
