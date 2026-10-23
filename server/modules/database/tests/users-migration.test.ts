import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { INIT_SCHEMA_SQL } from '../schema.js';
import { runMigrations } from '../migrations.js';

test('legacy users migrate the smallest id once and preserve existing data on reruns',()=>{
  const db=new Database(':memory:');
  try {
    db.exec(INIT_SCHEMA_SQL);
    db.prepare('INSERT INTO users(id,username,password_hash,is_active) VALUES (?,?,?,?)').run(7,'first','original-hash',1);
    db.prepare('INSERT INTO users(id,username,password_hash,is_active) VALUES (?,?,?,?)').run(19,'second','second-hash',0);
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT id,role,password_hash,is_active FROM users ORDER BY id').all(),[
      {id:7,role:'admin',password_hash:'original-hash',is_active:1},
      {id:19,role:'member',password_hash:'second-hash',is_active:0},
    ]);
    db.prepare("UPDATE users SET work_root=?,allowed_folders=?,access_sso_email=? WHERE id=19").run('D:/work','["D:/shared"]','second@example.com');
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT role,work_root,allowed_folders,access_sso_email FROM users WHERE id=19').get(),{role:'member',work_root:'D:/work',allowed_folders:'["D:/shared"]',access_sso_email:'second@example.com'});
    assert.equal((db.prepare('SELECT role FROM users WHERE id=7').get() as {role:string}).role,'admin');
  } finally {db.close();}
});
