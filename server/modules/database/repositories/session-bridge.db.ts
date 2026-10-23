import { ownerPredicate } from '../ownership.js';
import { getConnection } from '@/modules/database/connection.js';

/** Session Bridge searches the same local session index exposed by the ordinary session API; transcripts are read through Providers. */
export const sessionBridgeDb = {
  search(query: string, limit: number, offset: number) {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const where = `${ownerPredicate('s')} AND s.isArchived=0 AND (COALESCE(s.custom_name,'') LIKE ? ESCAPE '\\' OR COALESCE(s.project_path,'') LIKE ? ESCAPE '\\')`;
    const db = getConnection();
    const rows = db.prepare(`SELECT s.session_id AS sessionId,COALESCE(s.custom_name,'New conversation') AS title,
      s.provider,s.project_path AS projectPath,p.project_id AS projectId,s.updated_at AS updatedAt
      FROM sessions s LEFT JOIN projects p ON p.project_path=s.project_path WHERE ${where}
      ORDER BY s.updated_at DESC,s.session_id LIMIT ? OFFSET ?`).all(pattern, pattern, limit, offset) as {
        sessionId: string; title: string; provider: string; projectPath: string | null; projectId: string | null; updatedAt: string;
      }[];
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${where}`).get(pattern, pattern) as { total: number };
    return { sessions: rows, total, hasMore: offset + rows.length < total, offset };
  },
};
