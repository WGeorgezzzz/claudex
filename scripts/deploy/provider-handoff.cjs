'use strict';
const crypto=require('node:crypto');
// Transport is injected so failure/cancellation is testable without operating a service.
function createProviderHandoff(request,{renewMs=15000,onError=()=>{}}={}){
 const handoffId=crypto.randomUUID();let timer,attempted=false,closed=false;
 return {
  async prepare(allowIdleLegacy=false){
   attempted=true;
   try{
    const result=await request('prepare',{handoffId});
    if(result===null&&allowIdleLegacy){attempted=false;return;}
    if(!result?.ready||result.handoffId!==handoffId)throw Error('Provider handoff not confirmed');
    timer=setInterval(()=>{request('renew',{handoffId}).catch(onError);},renewMs);timer.unref();return result;
   }catch(error){await this.cancel();throw error;}
  },
  async cancel(){
   if(closed)return;closed=true;clearInterval(timer);
   if(attempted)try{await request('cancel',{handoffId});}catch(error){onError(error);}
  },
  async confirm(){
   if(!attempted)return;
   const renewed=await request('renew',{handoffId});
   if(renewed?.handoffId!==handoffId||renewed.expiresAt<=Date.now())throw Error('Provider handoff lease expired before stop');
  },
 };
}
module.exports={createProviderHandoff};
