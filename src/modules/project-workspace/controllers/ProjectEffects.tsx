import { useEffect } from 'react';
import { useLocation, useNavigationType, useParams } from 'react-router-dom';

import { usePaletteOpsRegister } from '@/modules/command-palette';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useProjectEffectsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { LLMProvider, ProjectWorkspaceShellProps } from '@/shared/types';

/** Headless controller rendered by ProjectWorkspaceShell to register palette operations and handle service-worker navigation messages. */
export default function ProjectEffects({
  navigate,
  isMobile,
}: Pick<ProjectWorkspaceShellProps, 'navigate' | 'isMobile'>) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { sessionId } = useParams();
  const {
    openSettings,
    refreshProjectsSilently,
    setActiveTab,
    setSidebarOpen,
  } = useProjectEffectsState();

  useEffect(() => {
    if (isMobile) {
      // A browser edge-swipe back to the list should land on the drawer, not
      // leave the previous conversation visible underneath a closed sidebar.
      setSidebarOpen(navigationType === 'POP' && !sessionId);
    }
  }, [isMobile, location.key, navigationType, sessionId, setSidebarOpen]);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        writeSelectedProvider(message.provider as LLMProvider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  return null;
}
