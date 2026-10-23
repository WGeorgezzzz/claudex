import express from 'express';
import type { RequestHandler } from 'express';

import { consumeLocalTicket, issueLocalTicket } from '@/modules/auth/local-identity.service.js';
import { remoteIdentityService } from '@/modules/auth/remote-identity.service.js';
import { authSessionEvents, generateToken } from '@/modules/auth/auth.middleware.js';
import { isLocalRequest } from '@/modules/auth/access-boundary.js';
import { exchangeAccessIdentity, isAccessSsoEnabled } from '@/modules/auth/access-sso.service.js';
import { authSessionsDb } from '@/modules/database/index.js';
import { AppError, requireAuthenticatedUserId } from '@/shared/index.js';
import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();
  const attempts=new Map<string,{count:number;until:number}>();
  // Bound password/OTP guessing independently of the external Access gate.
  router.use(['/login','/local-ticket','/local-exchange','/access-exchange'],(req,res,next)=>{
    const key=String(process.env.CLAUDEX_PRIVATE_GATE==='1'&&!isLocalRequest(req)?req.headers['cf-connecting-ip']||req.socket.remoteAddress:req.socket.remoteAddress||'unknown');
    const now=Date.now();for(const [id,row] of attempts)if(row.until<now)attempts.delete(id);
    const row=attempts.get(key)??{count:0,until:now+60000};
    if(row.count>=10||attempts.size>10000)return void res.status(429).json({error:'Too many login attempts. Wait one minute.'});
    row.count++;attempts.set(key,row);next();
  });
  router.post('/local-ticket',(req,res,next)=>{try{res.json({ticket:issueLocalTicket(req,req.headers['x-claudex-local-key'])});}catch(e){next(e);}});
  router.post('/local-exchange',(req,res,next)=>{try{const user=consumeLocalTicket(req,req.body?.ticket);res.json({success:true,user,token:generateToken({...user,authKind:'local'})});}catch(e){next(e);}});
  router.post('/access-exchange',async(req,res,next)=>{try{
    const {user,authSessionId}=await exchangeAccessIdentity(req);
    res.setHeader('Cache-Control','no-store');
    res.json({success:true,user,token:generateToken({...user,authKind:'remote',authSessionId})});
  }catch(e){next(e);}});
  router.get('/devices',authenticateToken,(req,res)=>res.json({devices:authSessionsDb.list(requireAuthenticatedUserId(req))}));
  router.delete('/devices/:id',authenticateToken,(req,res)=>{const userId=requireAuthenticatedUserId(req);const id=String(req.params.id);authSessionsDb.revoke(userId,id);authSessionEvents.emit('revoked',id);res.json({success:true});});
  router.get('/remote-account',authenticateToken,(_req,res)=>res.json(remoteIdentityService.status()));
  router.post('/remote-account',authenticateToken,async(req,res,next)=>{try{
    if(!isLocalRequest(req))throw new AppError('Configure the remote account from the local device.',{statusCode:403});
    res.json(await remoteIdentityService.configure(requireAuthenticatedUserId(req),String(req.body?.username??''),String(req.body?.password??'')));
  }catch(e){next(e);}});

  router.get('/status', (_req, res, next) => {
    try {
      res.setHeader('Cache-Control','no-store');
      res.json({...service.getStatus(),accessSso:isAccessSsoEnabled(_req),remoteLogin:process.env.CLAUDEX_PRIVATE_GATE==='1'&&!isLocalRequest(_req),localIdentity:process.env.CLAUDEX_LOCAL_IDENTITY==='1'&&isLocalRequest(_req)});
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      if(process.env.CLAUDEX_PRIVATE_GATE==='1'&&!isLocalRequest(req))throw new AppError('Initial setup is available locally only.',{statusCode:403});
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown; otp?:unknown };
      if(process.env.CLAUDEX_PRIVATE_GATE==='1'&&!isLocalRequest(req)){
        const user=await remoteIdentityService.login(body.username,body.password,body.otp);
        res.json({success:true,user,token:generateToken({...user,authKind:'remote'})});
      }else res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    const user=(_req as AuthenticatedRequest).user as {authSessionId?:string};
    if(user.authSessionId){authSessionsDb.revoke(requireAuthenticatedUserId(_req),user.authSessionId);authSessionEvents.emit('revoked',user.authSessionId);}
    res.json(service.logout());
  });

  return router;
}
