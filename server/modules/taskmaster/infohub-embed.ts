/** Served by Nexagent after its own authentication; the upstream repository stays untouched. */
export const infohubEmbedScript=String.raw`(()=>{
  const original=window.unitCard;
  if(typeof original==='function')window.unitCard=function(unit,...args){
    const box=original(unit,...args);box.dataset.infohubUnit=String(unit.id);
    if(unit.kind==='todo'&&(unit.for_me||(unit.tags||[]).includes('type:deadline'))){
      const a=document.createElement('a');a.className='b';a.textContent='在任务中执行';a.href='/infohub/nexagent/task/'+unit.id;a.target='_top';a.style.cssText='display:inline-flex;align-items:center;min-height:40px;text-decoration:none';
      (box.querySelector('.acts')||box).append(a);
    }
    return box;
  };
  const id=new URL(location.href).searchParams.get('unit');
  if(id&&/^\d+$/.test(id)&&typeof window.unitCard==='function'){
    fetch('/infohub/api/unit/'+id+'?depth=2').then(r=>r.ok?r.json():Promise.reject()).then(unit=>{const main=document.getElementById('main');if(main){let section=document.getElementById('nexagent-source-unit');if(!section){section=document.createElement('section');section.id='nexagent-source-unit';main.before(section);}section.replaceChildren(window.unitCard(unit));document.title=unit.title+' · 信息看板';}}).catch(()=>{});
  }
  const renew=()=>{if(window.parent!==window){window.parent.postMessage({type:'nexagent-infohub-renew'},location.origin);return;}
    const token=localStorage.getItem('auth-token');if(token)fetch('/api/infohub/session',{method:'POST',headers:{Authorization:'Bearer '+token}}).catch(()=>{});
  };
  setInterval(renew,5*60*1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)renew();});
})();`;
