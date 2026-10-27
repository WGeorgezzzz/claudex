import { ownerPredicate } from '../ownership.js';
import { getConnection } from '@/modules/database/connection.js';

/** Session Bridge searches the same local session index exposed by the ordinary session API; transcripts are read through Providers. */
export const sessionBridgeDb = {
  resolve(id: string) {
    const db = getConnection();
    return db.prepare(`SELECT s.* FROM sessions s WHERE ${ownerPredicate('s')} AND (s.session_id=? OR s.provider_session_id=? OR s.session_id LIKE ? ESCAPE '\\' OR s.provider_session_id LIKE ? ESCAPE '\\') ORDER BY (s.session_id=?) DESC,(s.provider_session_id=?) DESC,s.updated_at DESC LIMIT 1`).get(id,id,`${id.replace(/[\\%_]/g,'\\$&')}%`,`${id.replace(/[\\%_]/g,'\\$&')}%`,id,id) as any ?? null;
  },
  search(query: string, limit: number, offset: number) {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const idPattern = pattern;
    const where = `${ownerPredicate('s')} AND (s.isArchived=0 OR s.session_id LIKE ? ESCAPE '\\' OR COALESCE(s.provider_session_id,'') LIKE ? ESCAPE '\\') AND (COALESCE(s.custom_name,'') LIKE ? ESCAPE '\\' OR COALESCE(s.project_path,'') LIKE ? ESCAPE '\\' OR s.session_id LIKE ? ESCAPE '\\' OR COALESCE(s.provider_session_id,'') LIKE ? ESCAPE '\\')`;
    const db = getConnection();
    const rows = db.prepare(`SELECT s.session_id AS sessionId,COALESCE(s.custom_name,'New conversation') AS title,
      s.provider,s.provider_session_id AS providerSessionId,s.isArchived AS archived,s.project_path AS projectPath,p.project_id AS projectId,s.updated_at AS updatedAt
      FROM sessions s LEFT JOIN projects p ON p.project_path=s.project_path WHERE ${where}
      ORDER BY s.updated_at DESC,s.session_id LIMIT ? OFFSET ?`).all(idPattern,idPattern,pattern,pattern,pattern,pattern,limit,offset) as {
        sessionId: string; providerSessionId: string | null; archived: number; title: string; provider: string; projectPath: string | null; projectId: string | null; updatedAt: string;
      }[];
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${where}`).get(idPattern,idPattern,pattern,pattern,pattern,pattern) as { total: number };
    return { sessions: rows, total, hasMore: offset + rows.length < total, offset };
  },
};
