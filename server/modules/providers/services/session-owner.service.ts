import { readFileSync } from 'node:fs';
import { AppError } from '@/shared/index.js';

// A side-by-side upgrade may inspect imported history, but it must not take over
// a turn still owned by the previous service. Only this explicit deployment file
// enables the guard; normal installations keep their existing behavior.
let cachedPath: string | undefined;
let protectedSessions = new Set<string>();

/** SessionsService uses this before a new run or rewind; it never stops or contacts the other process. */
export function assertSessionOwnerAvailable(sessionId: string): void {
  const filename=process.env.CLOUDCLI_PROTECTED_SESSIONS_FILE;
  if (!filename) return;
  if (filename!==cachedPath) {
    const data=JSON.parse(readFileSync(filename,'utf8').replace(/^\uFEFF/,'')) as {sessionIds?:unknown};
    if (!Array.isArray(data.sessionIds) || !data.sessionIds.every(id=>typeof id==='string')) throw new Error('Invalid protected-session deployment file.');
    protectedSessions=new Set(data.sessionIds);
    cachedPath=filename;
  }
  if (protectedSessions.has(sessionId)) throw new AppError('This conversation is still owned by the original AgentHub service. Continue it in the original window, or fork a completed reply into a new conversation.',{code:'SESSION_OWNED_ELSEWHERE',statusCode:409});
}
