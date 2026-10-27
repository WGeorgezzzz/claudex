import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { SessionRowActions } from '@/shared/types';

const Context=createContext<SessionRowActions|null>(null);
/** SidebarContent shares navigation-safe rename/delete callbacks with pinned, section and inbox rows. */
export function SessionRowActionsProvider({actions,children}:{actions:SessionRowActions;children:ReactNode}) {
  return <Context.Provider value={actions}>{children}</Context.Provider>;
}
/** WorkspaceSessionRow uses the sidebar's action owner rather than duplicating rename state. */
export function useSessionRowActions(){return useContext(Context);}
