import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

import { authSessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

const bcrypt=createRequire(import.meta.url)('bcrypt') as {hash(p:string,n:number):Promise<string>;compare(p:string,h:string):Promise<boolean>};
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function encode(bytes:Buffer){let bits=0,value=0,out='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode(text:string){let bits=0,value=0;const out=[];for(const c of text){const n=alphabet.indexOf(c);if(n<0)throw Error('Invalid OTP secret');value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}

/** Remote identity and RFC-vector tests use six-digit time-based one-time passwords. */
export function totpCode(secret:string,step:number):string {const count=Buffer.alloc(8);count.writeBigUInt64BE(BigInt(step));const hash=createHmac('sha1',decode(secret)).update(count).digest();const offset=hash[19]&15;return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}

/** Local setup and remote login share an independent credential mapped to the existing owner's data. */
export const remoteIdentityService={
  status(){const row=authSessionsDb.remote();return {configured:Boolean(row),username:row?.username};},
  async configure(userId:number,username:string,password:string){
    if(authSessionsDb.remote())throw new AppError('A remote account is already configured.',{statusCode:409});
    if(!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)||password.length<16||Buffer.byteLength(password,'utf8')>72)throw new AppError('Use a valid username and a password of at least 16 characters, up to 72 UTF-8 bytes.',{statusCode:400});
    const secret=encode(randomBytes(20));const hash=await bcrypt.hash(password,12);
    authSessionsDb.configure(userId,username,hash,secret);
    return {username,secret,otpAuthUrl:`otpauth://totp/Claudex:${encodeURIComponent(username)}?secret=${secret}&issuer=Claudex&algorithm=SHA1&digits=6&period=30`};
  },
  async login(username:unknown,password:unknown,otp:unknown){
    const row=authSessionsDb.remote();
    const reject=()=>new AppError('Invalid remote username, password or verification code.',{statusCode:401});
    if(!row||username!==row.username||typeof password!=='string'||Buffer.byteLength(password,'utf8')>72||typeof otp!=='string'||!/^\d{6}$/.test(otp))throw reject();
    if(!await bcrypt.compare(password,row.password_hash))throw reject();
    const step=Math.floor(Date.now()/30000);
    const matched=[step,step-1,step+1].find(s=>s>row.last_totp_step&&totpCode(row.totp_secret,s)===otp);
    if(matched===undefined||!authSessionsDb.acceptOtp(row.user_id,matched))throw reject();
    const user=userDb.getUserById(row.user_id);if(!user)throw reject();return user;
  },
};
