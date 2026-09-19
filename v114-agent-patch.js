/* JARVIS V114 — independent agent frontend bridge */
(function(){
  const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const api=async(url,options={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});const t=await r.text();let d;try{d=JSON.parse(t)}catch{d={raw:t}}if(!r.ok)throw new Error(d.error||d.message||`HTTP ${r.status}`);return d};
  const log=(msg,type='AGENT')=>{try{window.addLine?.('jarvis',msg);window.setState?.('idle')}catch{}};
  let lastMission=null, poller=null;
  function enhance(){
    const plan=document.getElementById('jv107-plan');
    const goal=document.getElementById('jv107-goal');
    if(!plan||!goal||plan.dataset.v114)return;
    plan.dataset.v114='1';
    plan.textContent='RUN AGENT';
    const fresh=plan.cloneNode(true); plan.replaceWith(fresh);
    fresh.addEventListener('click',async()=>{
      const text=goal.value.trim(); if(!text)return;
      const out=document.getElementById('jv107-planout');
      out.innerHTML='<div class="jv114-live"><span class="jv114-spinner"></span> JARVIS is planning and executing…</div>';
      log('Agent mission started: '+text,'AGENT');
      try{
        const r=await api('/api/agent/run',{method:'POST',body:JSON.stringify({goal:text})});
        lastMission=r.missionId;
        if(r.status==='WAITING_APPROVAL') out.innerHTML='<div class="jv114-live">MISSION PAUSED // APPROVAL REQUIRED</div>';
        else out.innerHTML='<div class="jv114-live">MISSION '+esc(r.status||'ACTIVE')+'</div>';
        startPolling();
      }catch(e){out.innerHTML='<div class="jv107-empty">Agent error: '+esc(e.message)+'</div>'}
    });
    enhanceApprovals();
  }
  function enhanceApprovals(){
    document.querySelectorAll('[data-approve]').forEach(b=>{
      if(b.dataset.v114)return;b.dataset.v114='1';
      const fresh=b.cloneNode(true);b.replaceWith(fresh);
      fresh.addEventListener('click',async()=>{await decide(fresh.dataset.approve,'approve')});
    });
    document.querySelectorAll('[data-deny]').forEach(b=>{
      if(b.dataset.v114)return;b.dataset.v114='1';
      const fresh=b.cloneNode(true);b.replaceWith(fresh);
      fresh.addEventListener('click',async()=>{await decide(fresh.dataset.deny,'deny')});
    });
  }
  async function decide(index,decision){
    try{
      const state=await api('/api/agent/state');
      const approval=state.approvals?.filter(x=>x.status==='PENDING')?.[Number(index)];
      if(!approval)throw new Error('Approval no longer exists.');
      await api('/api/agent/approve',{method:'POST',body:JSON.stringify({approvalId:approval.id,decision})});
      log((decision==='approve'?'Approved ':'Denied ')+approval.tool,'APPROVAL');
      enhance();
    }catch(e){log('Approval error: '+e.message,'WARN')}
  }
  async function refresh(){
    try{
      const s=await api('/api/agent/state');
      const mission=lastMission?s.missions?.find(x=>x.id===lastMission):s.missions?.[0];
      const out=document.getElementById('jv107-planout');
      if(out&&mission){
        const steps=(mission.steps||[]).map((x,i)=>`<div class="jv107-item"><strong>${i+1}. ${esc(x.title||x.tool)}</strong><small>${esc(x.tool||'agent')}</small></div>`).join('');
        out.innerHTML=`<div class="jv114-status"><span class="jv114-dot"></span>${esc(mission.status)}</div>${steps}<div class="jv114-result">${esc((mission.results||[]).map(x=>x.result?.message||x.result?.error||x.tool).join(' • '))}</div>`;
      }
      enhanceApprovals();
    }catch{}
  }
  function startPolling(){clearInterval(poller);poller=setInterval(refresh,1200);setTimeout(()=>clearInterval(poller),120000)}
  const obs=new MutationObserver(()=>enhance());
  function boot(){obs.observe(document.body,{subtree:true,childList:true});enhance()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
