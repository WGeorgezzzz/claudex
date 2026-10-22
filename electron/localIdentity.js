import fs from 'node:fs/promises';
import path from 'node:path';

/** The native main process reads the private OS capability and passes only a one-use fragment ticket to its local tab. */
export async function localIdentityUrl(baseUrl,serviceHome) {
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return baseUrl;
  try {
    const key=(await fs.readFile(path.join(serviceHome,'local-identity.key'),'utf8')).trim();
    if(!/^[a-f0-9]{64}$/.test(key))return baseUrl;
    const response=await fetch(new URL('/api/auth/local-ticket',url),{method:'POST',headers:{'X-Claudex-Local-Key':key},signal:AbortSignal.timeout(3000),redirect:'error'});
    if(!response.ok)return baseUrl;
    const {ticket}=await response.json();
    if(!/^[a-f0-9]{64}$/.test(ticket))return baseUrl;
    url.hash='local-ticket='+ticket;return url.toString();
  }catch{return baseUrl;}
}
