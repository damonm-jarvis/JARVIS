import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.JARVIS_DATA_DIR || './data');
const STATE_FILE = path.join(DATA_DIR, 'agent-state.json');

const DEFAULT_STATE = {
  version: 1,
  missions: [],
  tasks: [],
  memory: [],
  notes: [],
  approvals: [],
  activity: [],
  schedules: [],
  updatedAt: null
};

async function ensureState(){
  await fs.mkdir(DATA_DIR, {recursive:true});
  try { await fs.access(STATE_FILE); }
  catch { await writeState(DEFAULT_STATE); }
}
async function readState(){
  await ensureState();
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE,'utf8'));
    return {...DEFAULT_STATE, ...parsed};
  } catch { return {...DEFAULT_STATE}; }
}
async function writeState(state){
  state.updatedAt = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state,null,2));
  await fs.rename(tmp, STATE_FILE);
}
async function mutate(fn){
  const state = await readState();
  const result = await fn(state);
  await writeState(state);
  return result;
}

function id(prefix='jv'){ return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function log(state,type,msg){
  state.activity.unshift({id:id('evt'), time:new Date().toISOString(), type, msg});
  state.activity = state.activity.slice(0,120);
}
function approvalNeeded(action){ return ['email_send','whatsapp_send','canva_create'].includes(action); }

function localPlan(goal){
  const g = goal.toLowerCase();
  const steps = [];
  if(/research|find|look up|investigate|compare|latest|news|information/.test(g)) steps.push({tool:'web_search', title:'Research the request', input:{q:goal}});
  if(/weather|forecast/.test(g)) steps.push({tool:'weather', title:'Check the requested weather', input:{city:goal}});
  if(/note|remember|save this/.test(g)) steps.push({tool:'note_add', title:'Save the useful information as a note', input:{text:goal}});
  if(/task|todo|to-do|remind me/.test(g)) steps.push({tool:'task_add', title:'Create a task', input:{title:goal}});
  if(/email|e-mail/.test(g)) steps.push({tool:'email_send', title:'Prepare the email', input:{goal}});
  if(/whatsapp|message .*business|send .*message/.test(g)) steps.push({tool:'whatsapp_send', title:'Prepare the WhatsApp message', input:{goal}});
  if(/canva|poster|design/.test(g)) steps.push({tool:'canva_create', title:'Prepare the Canva design', input:{goal}});
  if(!steps.length) steps.push({tool:'planner', title:'Break the objective into actionable steps', input:{goal}});
  return steps;
}

async function modelPlan(goal){
  const base = (process.env.AI_BASE_URL || '').replace(/\/$/,'');
  const key = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if(!base || !key || !model) return null;
  const system = `You are JARVIS, a practical task agent. Return ONLY valid JSON: {"steps":[{"tool":"...","title":"...","input":{}}]}. Allowed tools: web_search, weather, note_add, task_add, email_send, whatsapp_send, canva_create, planner. Never invent tools. External side effects (email_send, whatsapp_send, canva_create) must remain approval-gated. Keep plans concise and actionable.`;
  const r = await fetch(`${base}/chat/completions`, {
    method:'POST', headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model,temperature:0.2,messages:[{role:'system',content:system},{role:'user',content:goal}]})
  });
  if(!r.ok) return null;
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content || '';
  try {
    const parsed = JSON.parse(content.replace(/^```json\s*/,'').replace(/\s*```$/,''));
    const allowed = new Set(['web_search','weather','note_add','task_add','email_send','whatsapp_send','canva_create','planner']);
    return Array.isArray(parsed.steps) ? parsed.steps.filter(s=>allowed.has(s.tool)).slice(0,10) : null;
  } catch { return null; }
}

async function executeTool(tool, input, ctx){
  const {state, adapters} = ctx;
  switch(tool){
    case 'planner': return {ok:true, message:'Objective decomposed. No external action required.'};
    case 'note_add': {
      const text=String(input?.text||input?.goal||'').trim();
      if(!text) return {ok:false,error:'Note text is empty.'};
      const note={id:id('note'),text,time:new Date().toISOString()};
      state.notes.unshift(note); state.memory.unshift({id:id('mem'),text:`Note: ${text}`,time:note.time}); state.memory=state.memory.slice(0,100);
      return {ok:true,note};
    }
    case 'task_add': {
      const title=String(input?.title||input?.goal||'').trim();
      const task={id:id('task'),title,status:'PLANNED',priority:'MEDIUM',createdAt:new Date().toISOString()};
      state.tasks.unshift(task); return {ok:true,task};
    }
    case 'web_search': {
      if(!adapters.webSearch) return {ok:false,error:'Web search adapter is not configured.'};
      const q=String(input?.q||input?.goal||'').trim();
      return {ok:true,results:await adapters.webSearch(q)};
    }
    case 'weather': {
      if(!adapters.weather) return {ok:false,error:'Weather adapter is not configured.'};
      const city=String(input?.city||input?.goal||'').trim();
      return {ok:true,weather:await adapters.weather(city)};
    }
    case 'email_send':
    case 'whatsapp_send':
    case 'canva_create':
      return {ok:false,approvalRequired:true,tool,input};
    default: return {ok:false,error:`Unsupported tool: ${tool}`};
  }
}

export function registerAgent(app, adapters={}){
  app.get('/api/agent/state', async (req,res)=>res.json(await readState()));

  app.get('/api/agent/memory', async (req,res)=>{
    const s=await readState(); res.json({memory:s.memory,notes:s.notes});
  });

  app.post('/api/agent/memory', async (req,res)=>{
    const text=String(req.body?.text||'').trim();
    if(!text)return res.status(400).json({error:'text required'});
    const result=await mutate(s=>{const item={id:id('mem'),text,time:new Date().toISOString()};s.memory.unshift(item);s.memory=s.memory.slice(0,100);log(s,'MEMORY',`Stored memory: ${text}`);return item;});
    res.json({ok:true,item:result});
  });

  app.get('/api/tasks', async (req,res)=>res.json({tasks:(await readState()).tasks}));
  app.post('/api/tasks', async (req,res)=>{
    const title=String(req.body?.title||'').trim(); if(!title)return res.status(400).json({error:'title required'});
    const task=await mutate(s=>{const t={id:id('task'),title,status:'PLANNED',priority:req.body?.priority||'MEDIUM',createdAt:new Date().toISOString()};s.tasks.unshift(t);log(s,'TASK',`Task created: ${title}`);return t;});
    res.json({ok:true,task});
  });

  app.post('/api/agent/plan', async (req,res)=>{
    const goal=String(req.body?.goal||'').trim(); if(!goal)return res.status(400).json({error:'goal required'});
    let steps=null;
    try { steps=await modelPlan(goal); } catch {}
    steps=steps||localPlan(goal);
    const requiresApproval=steps.some(s=>approvalNeeded(s.tool));
    const mission={id:id('mission'),goal,status:'PLANNED',steps,requiresApproval,createdAt:new Date().toISOString()};
    await mutate(s=>{s.missions.unshift(mission);s.missions=s.missions.slice(0,40);log(s,'PLANNER',`Mission planned: ${goal}`);});
    res.json({goal,missionId:mission.id,requiresApproval,approvalAction:requiresApproval?'External action':'No external side effect detected.',approvalReason:requiresApproval?'JARVIS will pause before sending, publishing or changing an external service.':'Safe local/research actions can run automatically.',steps});
  });

  app.post('/api/agent/run', async (req,res)=>{
    const goal=String(req.body?.goal||'').trim(); if(!goal)return res.status(400).json({error:'goal required'});
    let steps=null; try {steps=await modelPlan(goal);} catch {}
    steps=steps||localPlan(goal);
    const mission={id:id('mission'),goal,status:'RUNNING',steps,results:[],createdAt:new Date().toISOString()};
    await mutate(s=>{s.missions.unshift(mission);log(s,'AGENT',`Mission started: ${goal}`);});
    const state=await readState();
    for(let i=0;i<steps.length;i++){
      const step=steps[i];
      if(approvalNeeded(step.tool)){
        await mutate(s=>{
          const m=s.missions.find(x=>x.id===mission.id); if(m){m.status='WAITING_APPROVAL';m.currentStep=i;}
          s.approvals.unshift({id:id('approval'),missionId:mission.id,tool:step.tool,action:step.title,reason:'This step can affect an external account or publish/send content.',input:step.input,status:'PENDING',createdAt:new Date().toISOString()});
          log(s,'APPROVAL',`Approval required for ${step.tool}.`);
        });
        return res.json({ok:true,missionId:mission.id,status:'WAITING_APPROVAL',message:'Mission paused for approval.',results:[]});
      }
      const result=await executeTool(step.tool,step.input,{state,adapters});
      await mutate(s=>{const m=s.missions.find(x=>x.id===mission.id);if(m)m.results.push({step:i+1,tool:step.tool,result});log(s,result.ok?'TOOL':'WARN',`${step.title}: ${result.ok?'complete':'blocked'}`);});
    }
    await mutate(s=>{const m=s.missions.find(x=>x.id===mission.id);if(m)m.status='COMPLETE';log(s,'SUCCESS',`Mission complete: ${goal}`);});
    const final=await readState();
    const done=final.missions.find(x=>x.id===mission.id);
    res.json({ok:true,missionId:mission.id,status:done?.status||'COMPLETE',results:done?.results||[]});
  });

  app.post('/api/agent/approve', async (req,res)=>{
    const approvalId=String(req.body?.approvalId||''); if(!approvalId)return res.status(400).json({error:'approvalId required'});
    const decision=req.body?.decision==='deny'?'deny':'approve';
    const state=await readState(); const approval=state.approvals.find(a=>a.id===approvalId);
    if(!approval)return res.status(404).json({error:'approval not found'});
    await mutate(s=>{const a=s.approvals.find(x=>x.id===approvalId);if(a)a.status=decision==='approve'?'APPROVED':'DENIED';log(s,'APPROVAL',`${decision.toUpperCase()}: ${approval.tool}`);});
    if(decision==='deny'){
      await mutate(s=>{const m=s.missions.find(x=>x.id===approval.missionId);if(m)m.status='DENIED';});
      return res.json({ok:true,status:'DENIED'});
    }
    const mstate=await readState(); const m=mstate.missions.find(x=>x.id===approval.missionId);
    const step=m?.steps?.[m.currentStep||0];
    if(!m||!step)return res.status(404).json({error:'mission step not found'});
    let result={ok:true,approved:true};
    try {
      if(step.tool==='email_send' && adapters.emailSend) result=await adapters.emailSend(step.input, req);
      else if(step.tool==='whatsapp_send' && adapters.whatsappSend) result=await adapters.whatsappSend(step.input, req);
      else if(step.tool==='canva_create' && adapters.canvaCreate) result=await adapters.canvaCreate(step.input, req);
      else result={ok:true,approved:true,message:'Approval recorded. Configure the integration adapter to execute the external action.'};
    } catch(e){ result={ok:false,error:e.message}; }
    await mutate(s=>{const mm=s.missions.find(x=>x.id===approval.missionId);if(mm){mm.results=mm.results||[];mm.results.push({step:(mm.currentStep||0)+1,tool:step.tool,result});mm.status=result.ok?'COMPLETE':'BLOCKED';}log(s,result.ok?'SUCCESS':'WARN',`Approved step ${step.tool} ${result.ok?'completed':'failed'}.`);});
    res.json({ok:true,status:result.ok?'COMPLETE':'BLOCKED',result});
  });

  app.post('/api/schedules', async (req,res)=>{
    const title=String(req.body?.title||'').trim(); const goal=String(req.body?.goal||title).trim(); const runAt=String(req.body?.runAt||'').trim();
    if(!title||!runAt)return res.status(400).json({error:'title and runAt required'});
    const item=await mutate(s=>{const x={id:id('sch'),title,goal,runAt,enabled:true,createdAt:new Date().toISOString()};s.schedules.push(x);return x;});
    res.json({ok:true,schedule:item});
  });
  app.get('/api/schedules', async (req,res)=>res.json({schedules:(await readState()).schedules}));

  return {readState,mutate};
}
