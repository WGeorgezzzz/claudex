/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table.
 * Roles and per-account access metadata are persisted with each user.
 */

import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  role: 'admin' | 'member';
  work_root: string | null;
  allowed_folders: string;
  access_sso_email: string | null;
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
};

type UserPublicRow = Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login' | 'role' | 'work_root' | 'allowed_folders' | 'access_sso_email'>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  role: 'admin' | 'member';
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  createUser(username: string, passwordHash: string): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, CASE WHEN EXISTS(SELECT 1 FROM users) THEN 'member' ELSE 'admin' END)")
      .run(username, passwordHash);
    return { id: result.lastInsertRowid, username, role: this.getUserById(Number(result.lastInsertRowid))!.role };
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, role, work_root, allowed_folders, access_sso_email FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /** Returns the first active user. Used for single-user mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        "SELECT id, username, created_at, last_login, role, work_root, allowed_folders, access_sso_email FROM users WHERE is_active = 1 AND role='admin' ORDER BY id LIMIT 1"
      )
      .get() as UserPublicRow | undefined;
  },

  /** User management returns public metadata only. */
  listUsers() {
    return getConnection().prepare('SELECT id, username, role, work_root, allowed_folders, access_sso_email, is_active, created_at, last_login FROM users WHERE deleted_at IS NULL ORDER BY id').all();
  },
  getUserBySsoEmail(email: string) {
    const row = getConnection().prepare('SELECT id FROM users WHERE lower(access_sso_email)=lower(?) AND is_active=1').get(email) as {id:number} | undefined;
    return row ? this.getUserById(row.id) : undefined;
  },
  getSsoBinding(email: string) {
    return getConnection().prepare('SELECT is_active FROM users WHERE lower(access_sso_email)=lower(?)').get(email) as {is_active:number} | undefined;
  },
  hasSsoUsers(): boolean {
    return Boolean(getConnection().prepare('SELECT 1 FROM users WHERE access_sso_email IS NOT NULL AND is_active=1 LIMIT 1').get());
  },
  updateAccess(userId: number, root: string, folders: string[], email: string | null, active: boolean) {
    return getConnection().prepare('UPDATE users SET work_root=?, allowed_folders=?, access_sso_email=?, is_active=? WHERE id=?').run(root, JSON.stringify(folders), email, Number(active), userId);
  },
  setRole(userId: number, role: 'admin' | 'member') {
    getConnection().prepare('UPDATE users SET role=? WHERE id=? AND deleted_at IS NULL').run(role, userId);
  },
  /** Tombstones the account: frees its username and SSO email, keeps owned rows and data folders. */
  softDelete(userId: number) {
    getConnection().prepare("UPDATE users SET is_active=0, deleted_at=CURRENT_TIMESTAMP, access_sso_email=NULL, username=username || '.deleted-' || id || '-' || strftime('%s','now') WHERE id=? AND deleted_at IS NULL").run(userId);
  },
  setPassword(userId: number, hash: string) {
    getConnection().prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, userId);
  },
  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },
};
