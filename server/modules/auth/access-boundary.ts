import { createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { RequestHandler } from 'express';

import { userDb } from '@/modules/database/index.js';
import { isManagedTunnelRequest } from './managed-tunnel-ingress.js';

let cachedKeys:{expires:number;keys:Array<{kid:string;kty:string;[key:string]:unknown}>}|undefined;
let keyFetch:Promise<void>|undefined;
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);

/** Auth and websocket ingress distinguish actual local access from a loopback tunnel connection. */
export function isLocalRequest(req:IncomingMessage):boolean {
  try {
    const host = new URL('http://' + req.headers.host);
    const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
      'cf-access-jwt-assertion', 'cf-connecting-ip', 'tailscale-user-login', 'tailscale-user-name',
      'x-tunnel-id', 'x-tunnel-authorization', 'x-tunnel-skip-antiphishing-page', 'x-devtunnel-id', 'x-ms-proxy', 'x-original-host', 'x-nexagent-managed-tunnel'];
    return loopback.has(req.socket.remoteAddress ?? '') && ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)
      && !forwarded.some(key => req.headers[key] !== undefined);
  } catch { return false; }
}

/** HTTP/auth and WebSocket consumers require password/MFA sessions for every remote entry. */
export function requiresRemoteLogin(req: IncomingMessage): boolean { return !isLocalRequest(req); }

/** HTTP and websocket composition share host/origin checks and signed Cloudflare Access identity validation. */
export async function validateAccessBoundary(req:IncomingMessage):Promise<boolean> {
  if (isManagedTunnelRequest(req)) {
    if (!req.headers.origin) return true;
    try { const origin = new URL(req.headers.origin); return origin.protocol === 'https:' && origin.host === req.headers.host; } catch { return false; }
  }
  if(process.env.CLAUDEX_PRIVATE_GATE!=='1')return true;
  const host=req.headers.host??'',origin=req.headers.origin;
  if(isLocalRequest(req)) {
    if(!origin)return true;
    try {const url=new URL(origin);return url.protocol==='http:'&&url.host===host;}catch{return false;}
  }
  const publicHost=process.env.CLAUDEX_PUBLIC_HOST;
  const team=process.env.CLAUDEX_ACCESS_TEAM;
  const audience=process.env.CLAUDEX_ACCESS_AUD;
  if(!publicHost||host!==publicHost||!team||!audience||!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))return false;
  if(origin&&origin!==`https://${publicHost}`)return false;
  const token=req.headers['cf-access-jwt-assertion'];
  if(typeof token!=='string'||token.length>16000)return false;
  try {
    const parts=token.split('.');if(parts.length!==3)return false;
    const header=JSON.parse(Buffer.from(parts[0],'base64url').toString());
    const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
    const now=Math.floor(Date.now()/1000);
    if(header.alg!=='RS256'||typeof header.kid!=='string'||claims.iss!==team||!Array.isArray(claims.aud)||!claims.aud.includes(audience)||typeof claims.exp!=='number'||claims.exp<=now||typeof claims.iat!=='number'||claims.iat>now+60||(claims.nbf&&claims.nbf>now+60)||typeof claims.email!=='string')return false;
    const allowed=(process.env.CLAUDEX_ACCESS_EMAILS??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    const email=claims.email.trim().toLowerCase();
    const binding=userDb.getSsoBinding(email);
    // Explicit disabled bindings override the legacy environment allowlist too.
    if(binding ? !binding.is_active : !allowed.includes(email)&&email!==process.env.CLAUDEX_ACCESS_SSO_EMAIL?.trim().toLowerCase())return false;
    if(!cachedKeys||cachedKeys.expires<Date.now()){
      if(!keyFetch)keyFetch=(async()=>{const response=await fetch(`${team}/cdn-cgi/access/certs`,{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw Error('Access certificates unavailable');const data=await response.json() as {keys:Array<{kid:string;kty:string;[key:string]:unknown}>};if(!Array.isArray(data.keys)||data.keys.length>20)throw Error('Invalid Access keys');cachedKeys={keys:data.keys,expires:Date.now()+300000};})().finally(()=>{keyFetch=undefined;});
      await keyFetch;
    }
    const key=cachedKeys?.keys.find(k=>k.kid===header.kid&&k.kty==='RSA');if(!key)return false;
    return verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),createPublicKey({key:key as never,format:'jwk'}),Buffer.from(parts[2],'base64url'));
  }catch{return false;}
}

/** Server installs this before every HTTP route, including static assets and auxiliary APIs. */
export const accessBoundaryMiddleware:RequestHandler=(req,res,next)=>{void validateAccessBoundary(req).then(ok=>{if(ok)next();else res.status(403).json({error:'This entry requires the configured private access identity.'});}).catch(next);};
