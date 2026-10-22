import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, authSessionsDb, userDb } from '@/modules/database/index.js';
import { initializeLocalIdentity, issueLocalTicket, consumeLocalTicket } from '@/modules/auth/local-identity.service.js';
import { validateAccessBoundary } from '@/modules/auth/access-boundary.js';
import { remoteIdentityService, totpCode } from '@/modules/auth/remote-identity.service.js';

test('local identity is capability-bound, one-use and unavailable through the remote ingress; remote MFA rejects replay',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'claudex-auth-'));const saved={...process.env};
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await writeFile(process.env.DATABASE_PATH,'');process.env.CLOUDCLI_HOME=root;process.env.CLAUDEX_LOCAL_IDENTITY='1';process.env.CLAUDEX_PRIVATE_GATE='1';await initializeDatabase();
  try{
    initializeLocalIdentity();const user=userDb.getFirstUser()!;assert.ok(user);assert.equal(userDb.hasCompletedOnboarding(user.id),true);
    const req={headers:{host:'127.0.0.1:3021'},socket:{remoteAddress:'127.0.0.1'}} as IncomingMessage;
    const key=(await readFile(path.join(root,'local-identity.key'),'utf8')).trim();
    assert.throws(()=>issueLocalTicket(req,'x'.repeat(64)),/unavailable/);
    const ticket=issueLocalTicket(req,key);assert.equal(consumeLocalTicket(req,ticket).id,user.id);
    assert.throws(()=>consumeLocalTicket(req,ticket),/expired/);
    const foreign={...req,headers:{host:'attacker.example',origin:'https://attacker.example'}} as IncomingMessage;
    assert.throws(()=>issueLocalTicket(foreign,key),/unavailable/);
    assert.equal(await validateAccessBoundary(req),true);
    assert.equal(await validateAccessBoundary(foreign),false);
    assert.equal(await validateAccessBoundary({...req,headers:{...req.headers,origin:'https://attacker.example'}} as IncomingMessage),false);
    assert.equal(await validateAccessBoundary({...req,headers:{...req.headers,'cf-connecting-ip':'203.0.113.8'}} as unknown as IncomingMessage),false);
    const sid=authSessionsDb.create(user.id,'local');assert.ok(authSessionsDb.get(sid));authSessionsDb.revoke(user.id+1,sid);assert.ok(authSessionsDb.get(sid));authSessionsDb.revoke(user.id,sid);assert.equal(authSessionsDb.get(sid),undefined);
    // RFC 6238 SHA1 vector at 59 seconds, truncated to six digits.
    assert.equal(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',1),'287082');
    const setup=await remoteIdentityService.configure(user.id,'remote-owner','Independent-test-password-123!');
    const otp=totpCode(setup.secret,Math.floor(Date.now()/30000));
    await assert.rejects(()=>remoteIdentityService.login('remote-owner','wrong password',otp),/Invalid/);
    assert.equal((await remoteIdentityService.login('remote-owner','Independent-test-password-123!',otp)).id,user.id);
    await assert.rejects(()=>remoteIdentityService.login('remote-owner','Independent-test-password-123!',otp),/Invalid/);
  }finally{closeConnection();for(const key of ['DATABASE_PATH','CLOUDCLI_HOME','CLAUDEX_LOCAL_IDENTITY','CLAUDEX_PRIVATE_GATE']){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
