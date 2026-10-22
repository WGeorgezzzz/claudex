import { getConnection } from '@/modules/database/connection.js';
import type { WorkspaceSectionLayout } from '@/shared/types.js';
import { AppError } from '@/shared/index.js';

const KEY = 'claudex.workspaceSections';
const empty = (): WorkspaceSectionLayout => ({ revision: 0, sections: [], assignments: [] });

/** Workspace Sections stores one revisioned layout per authenticated account in the existing preference store. */
export const workspaceSectionsDb = {
  read(userId: number): WorkspaceSectionLayout {
    const row = getConnection().prepare('SELECT preference_value FROM user_preferences WHERE user_id=? AND preference_key=?').get(userId, KEY) as { preference_value: string } | undefined;
    return row ? JSON.parse(row.preference_value) as WorkspaceSectionLayout : empty();
  },
  update(userId: number, revision: number, change: (layout: WorkspaceSectionLayout) => void): WorkspaceSectionLayout {
    const db = getConnection();
    return db.transaction(() => {
      const layout = this.read(userId);
      if (layout.revision !== revision) throw new AppError('Workspace layout changed. Refresh before trying again.', { statusCode: 409 });
      change(layout); layout.revision++;
      db.prepare(`INSERT INTO user_preferences(user_id,preference_key,preference_value) VALUES(?,?,?)
        ON CONFLICT(user_id,preference_key) DO UPDATE SET preference_value=excluded.preference_value,updated_at=CURRENT_TIMESTAMP`).run(userId, KEY, JSON.stringify(layout));
      return layout;
    }).immediate();
  },
};
