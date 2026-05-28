const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const app     = express();

app.use(cors());
app.use(express.json({limit:'10mb'}));
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});

const GHL_KEY = process.env.GHL_KEY;
const GHL_LOC = process.env.GHL_LOC;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const OPENAI_CHAT_MODEL = process.env.VAL_CHAT_MODEL || 'gpt-5.5';
const ROCKETREACH_API_KEY = process.env.ROCKETREACH_API_KEY;
const ROCKETREACH_BASE_URL = process.env.ROCKETREACH_BASE_URL || 'https://api.rocketreach.co/api/v2';
const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY;
const OUTSCRAPER_LINKEDIN_POSTS_URL = process.env.OUTSCRAPER_LINKEDIN_POSTS_URL || '';
const OUTSCRAPER_GOOGLE_MAPS_SEARCH_URL = process.env.OUTSCRAPER_GOOGLE_MAPS_SEARCH_URL || 'https://api.app.outscraper.com/maps/search-v3';
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID || '';
const GHL_CALENDAR_IDS = String(process.env.GHL_CALENDAR_IDS || GHL_CALENDAR_ID || '').split(',').map(v=>v.trim()).filter(Boolean);
const GHL_OPPORTUNITY_PIPELINE_ID = process.env.GHL_OPPORTUNITY_PIPELINE_ID || process.env.GHL_PIPELINE_ID || '';
const GHL_OPPORTUNITY_STAGE_ID = process.env.GHL_OPPORTUNITY_STAGE_ID || process.env.GHL_PIPELINE_STAGE_ID || '';
const GHL_OPPORTUNITY_PIPELINE_NAME = process.env.GHL_OPPORTUNITY_PIPELINE_NAME || 'GOALL';
const GHL_OPPORTUNITY_STAGE_NAME = process.env.GHL_OPPORTUNITY_STAGE_NAME || 'New Lead';
const GOALL_LEAD_SEARCH_MAX = Number(process.env.GOALL_LEAD_SEARCH_MAX) || 100;
let rocketReachLimitedUntil = 0;
const GHL_LEAD_FIELD_IDS = {
  company_payload: process.env.GHL_FIELD_COMPANY_PAYLOAD || '',
  google_raw: process.env.GHL_FIELD_GOOGLE_RAW || process.env.GHL_FIELD_COMPANY_GOOGLE_RAW || '',
  company_signals: process.env.GHL_FIELD_COMPANY_SIGNALS || process.env.GHL_FIELD_COMPANY_SIGNALS_RAW || '',
  enrichment_data: process.env.GHL_FIELD_ENRICHMENT_DATA || '',
  approximat_donor_count: process.env.GHL_FIELD_APPROXIMAT_DONOR_COUNT || process.env.GHL_FIELD_APPROXIMATE_DONOR_COUNT || '',
  linkedin_personal: process.env.GHL_FIELD_LINKEDIN_PERSONAL || process.env.GHL_FIELD_LINKEDIN_PERSONAL_URL || '',
  linkedin_company: process.env.GHL_FIELD_LINKEDIN_COMPANY || process.env.GHL_FIELD_LINKEDIN_COMPANY_URL || '',
  hours_of_operation: process.env.GHL_FIELD_HOURS_OF_OPERATION || '',
  time_zone: process.env.GHL_FIELD_TIME_ZONE || ''
};
const GHL_LEAD_FIELD_KEYS = {
  company_payload:'contact.company_payload',
  google_raw:'contact.google_raw',
  company_signals:'contact.company_signals',
  enrichment_data:'contact.enrichment_data',
  approximat_donor_count:'contact.approximat_donor_count',
  linkedin_personal:'contact.linkedin_personal',
  linkedin_company:'contact.linkedin_company',
  hours_of_operation:'contact.hours_of_operation',
  time_zone:'contact.time_zone'
};
const OWNER_EMAILS = new Set(String(process.env.VAL_OWNER_EMAILS || process.env.VAL_OWNER_EMAIL || '')
  .split(',')
  .map(e=>e.trim().toLowerCase())
  .filter(Boolean));
const BASE    = 'https://services.leadconnectorhq.com';
const TASKS_FILE = process.env.TASKS_FILE || '/tmp/val_tasks.json';
const STORE_FILE = process.env.VAL_STORE_FILE || '/tmp/val_store.json';
const VAL_USER_ID = process.env.VAL_USER_ID || 'mark-goall';
const MEMORY_CHUNK_SIZE = Number(process.env.MEMORY_CHUNK_SIZE) || 1800;
const MEMORY_CHUNK_OVERLAP = Number(process.env.MEMORY_CHUNK_OVERLAP) || 250;
let pgPool = null;

function inferValOwner(obj={}){
  const ids = [
    obj.assignedTo,
    obj.assignedUserId,
    obj.userId,
    obj.ownerId,
    obj.contact?.assignedTo,
    obj.contact?.assignedUserId,
    obj.contact?.userId
  ].filter(Boolean).map(String);
  const raw = [
    obj.assignedTo,
    obj.assignedToName,
    obj.assignedUserName,
    obj.userName,
    obj.ownerName,
    obj.contactOwner,
    obj.user?.name,
    obj.assignedUser?.name,
    obj.contact?.assignedTo,
    obj.contact?.assignedToName,
    obj.contact?.assignedUserName
  ].filter(Boolean).join(' ');
  return raw ? raw.trim() : (ids.length ? 'Assigned user' : '');
}

if(process.env.DATABASE_URL){
  try{
    const {Pool} = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : {rejectUnauthorized:false}
    });
  }catch(e){
    console.error('Postgres disabled:', e.message);
  }
}

function gh(){
  return {'Authorization':`Bearer ${GHL_KEY}`,'Version':'2021-07-28','Content-Type':'application/json'};
}
async function ghl(method,path,body){
  const r=await fetch(BASE+path,{method,headers:gh(),body:body?JSON.stringify(body):undefined});
  return r.json();
}
async function ghlStrict(method,path,body){
  const r=await fetch(BASE+path,{method,headers:gh(),body:body?JSON.stringify(body):undefined});
  const data=await readJsonResponse(r);
  if(!r.ok){
    const detail=data.message||data.error||data.errorMessage||data.raw||JSON.stringify(data).slice(0,500);
    throw new Error(`GHL ${method} ${path} failed (${r.status}): ${detail}`);
  }
  return data;
}
async function readJsonResponse(response){
  const text = await response.text();
  try{ return text ? JSON.parse(text) : {}; }
  catch(e){ return {raw:text}; }
}

async function ghlTry(method,path,body){
  const r=await fetch(BASE+path,{method,headers:gh(),body:body?JSON.stringify(body):undefined});
  const data=await readJsonResponse(r);
  return {ok:r.ok,status:r.status,path,data};
}

function readJson(file,fallback){
  try{ return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e){ return fallback; }
}
function writeJson(file,value){
  try{ fs.writeFileSync(file, JSON.stringify(value,null,2)); }
  catch(e){ console.error('writeJson error:',e.message); }
}
function valStore(){
  return readJson(STORE_FILE,{conversations:[],messages:[],transcripts:[],memoryItems:[],oauthTokens:{}});
}
function saveValStore(store){ writeJson(STORE_FILE,store); }
function uuid(prefix){
  return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
}
function memoryChunks(text){
  const clean = String(text||'').replace(/\r\n/g,'\n').trim();
  if(!clean) return [];
  if(clean.length <= MEMORY_CHUNK_SIZE) return [clean];
  const chunks = [];
  let start = 0;
  while(start < clean.length){
    let end = Math.min(start + MEMORY_CHUNK_SIZE, clean.length);
    if(end < clean.length){
      const breakAt = Math.max(clean.lastIndexOf('\n\n',end), clean.lastIndexOf('. ',end), clean.lastIndexOf('\n',end));
      if(breakAt > start + MEMORY_CHUNK_SIZE * 0.55) end = breakAt + 1;
    }
    chunks.push(clean.slice(start,end).trim());
    if(end >= clean.length) break;
    start = Math.max(0,end - MEMORY_CHUNK_OVERLAP);
  }
  return chunks.filter(Boolean);
}
function queryTerms(text){
  const stop = new Set(['about','after','again','all','also','and','are','because','been','but','can','could','does','for','from','have','her','him','how','into','just','like','more','need','not','now','our','out','she','should','that','the','their','then','there','they','this','through','what','when','where','which','with','would','you','your']);
  return String(text||'').toLowerCase().match(/[a-z0-9']{3,}/g)?.filter(w=>!stop.has(w)).slice(-20) || [];
}
function isDocumentMemoryQuery(text){
  return /\b(document|documents|file|files|upload|uploaded|transcript|transcripts|summary|summarize|overview|saved|vault|about them|what are they|mgsh)\b/i.test(String(text||''));
}
function scoreMemory(item,terms){
  const hay = `${item.kind||''} ${item.summary||''} ${item.raw_text||item.rawText||''} ${JSON.stringify(item.metadata||{})}`.toLowerCase();
  return terms.reduce((score,term)=>score+(hay.includes(term)?1:0),0) + ((item.importance||1) * 0.1);
}
async function dbQuery(sql,params){
  if(!pgPool) return null;
  try{
    return await pgPool.query(sql,params);
  }catch(e){
    console.error('Postgres unavailable, falling back to file store:',e.message);
    try{ await pgPool.end(); }catch(_){}
    pgPool = null;
    return {rows:[],rowCount:0};
  }
}
async function initValDb(){
  if(!pgPool) return;
  await dbQuery(`
    create table if not exists val_tasks (
      id text primary key,
      user_id text not null default 'default',
      title text not null,
      contact_name text,
      due_date timestamptz,
      notes text,
      details jsonb not null default '[]',
      completed boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_conversations (
      id text primary key,
      user_id text not null default 'default',
      title text,
      source text not null default 'chat',
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_messages (
      id text primary key,
      conversation_id text references val_conversations(id) on delete cascade,
      role text not null,
      content text not null,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create table if not exists val_transcripts (
      id text primary key,
      user_id text not null default 'default',
      type text not null,
      title text,
      raw_text text not null,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create table if not exists val_memory_items (
      id text primary key,
      user_id text not null default 'default',
      kind text not null default 'note',
      summary text,
      raw_text text not null,
      importance integer not null default 1,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create table if not exists val_oauth_tokens (
      provider text primary key,
      user_id text not null default 'default',
      tokens jsonb not null,
      updated_at timestamptz not null default now()
    );
    create index if not exists val_tasks_user_completed_idx on val_tasks(user_id,completed,due_date);
    create index if not exists val_messages_conversation_idx on val_messages(conversation_id,created_at);
    create index if not exists val_transcripts_user_created_idx on val_transcripts(user_id,created_at desc);
    create index if not exists val_memory_user_created_idx on val_memory_items(user_id,created_at desc);
  `);
  console.log('VAL Postgres store ready');
}
const valDbReady = initValDb().catch(e=>console.error('VAL DB init error:',e.message));

// ── HEALTH ───────────────────────────────────────────────
function statusPayload(){
  return {
    status:'VAL Proxy OK',
    app:'mark-goall-val',
    time:new Date().toISOString(),
    config:{
      ghlConfigured:!!(GHL_KEY&&GHL_LOC),
      ghlMissing:['GHL_KEY','GHL_LOC'].filter(k=>!process.env[k]),
      openAiConfigured:!!OPENAI_KEY,
      databaseConfigured:!!process.env.DATABASE_URL,
      googleConfigured:!!(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET),
      ghlCalendarMode:GHL_CALENDAR_IDS.length?'selected':'all',
      ghlCalendarCount:GHL_CALENDAR_IDS.length
    }
  };
}

app.get('/',(req,res)=>res.json(statusPayload()));
app.get('/health',(req,res)=>res.json(statusPayload()));
app.get('/api/config/status',(req,res)=>res.json(statusPayload()));
function guideHtml(markdown){
  const slug = text => String(text||'').toLowerCase().replace(/<[^>]+>/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const referenceMd = String(markdown||'').slice(Math.max(0,String(markdown||'').indexOf('## 1. Core Concept')));
  const escaped = referenceMd.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const referenceHtml = escaped
    .replace(/^# (.+)$/gm,(_,t)=>`<h1 id="${slug(t)}">${t}</h1>`)
    .replace(/^## (.+)$/gm,(_,t)=>`<h2 id="${slug(t)}">${t}</h2>`)
    .replace(/^### (.+)$/gm,(_,t)=>`<h3 id="${slug(t)}">${t}</h3>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/^- (.+)$/gm,'<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm,'<li>$1</li>')
    .replace(/\n\n/g,'</p><p>')
    .replace(/\n/g,'<br>');
  const icon = {
    calendar:'<svg viewBox="0 0 24 24"><path d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
    radar:'<svg viewBox="0 0 24 24"><path d="M12 21a9 9 0 1 0-9-9"/><path d="M12 12 19 5"/><path d="M8 12a4 4 0 1 0 4-4"/></svg>',
    stack:'<svg viewBox="0 0 24 24"><path d="M7 7h10M7 12h10M7 17h6"/><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/></svg>',
    node:'<svg viewBox="0 0 24 24"><path d="M8 8h8v8H8z"/><path d="M4 4h4v4H4zM16 4h4v4h-4zM4 16h4v4H4zM16 16h4v4h-4z"/></svg>',
    voice:'<svg viewBox="0 0 24 24"><path d="M4 12v2M8 8v8M12 5v14M16 8v8M20 12v2"/></svg>'
  };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VAL Guide</title><style>
:root{--bg:#111827;--panel:#182336;--panel2:#1f2d43;--text:#f8f5ee;--muted:#b8c0cc;--gold:#d7b56d;--line:rgba(255,255,255,.1)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#1f2d43 0,#111827 48%);color:var(--text);font-family:Inter,Arial,sans-serif;line-height:1.55}a{color:inherit}.top{position:sticky;top:0;z-index:10;background:rgba(17,24,39,.82);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);padding:14px 22px}.top a{color:var(--gold);text-decoration:none;font-size:12px;text-transform:uppercase;letter-spacing:.12em}.wrap{max-width:1120px;margin:0 auto;padding:54px 22px 90px}.hero{min-height:340px;display:grid;align-items:end;padding:42px 0 36px;border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);font-weight:700}.hero h1{font-family:Georgia,serif;font-size:clamp(48px,9vw,112px);line-height:.9;margin:12px 0}.hero p{font-size:20px;color:var(--muted);max-width:620px;margin:0 0 24px}.actions{display:flex;gap:12px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 18px;border-radius:7px;border:1px solid var(--gold);background:rgba(215,181,109,.12);color:var(--gold);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;text-decoration:none}.btn.secondary{border-color:var(--line);color:var(--text);background:rgba(255,255,255,.04)}section{margin-top:42px}.section-head{display:flex;justify-content:space-between;gap:16px;align-items:end;margin-bottom:16px}.section-head h2{font-family:Georgia,serif;font-size:30px;margin:0}.section-head p{margin:0;color:var(--muted);max-width:520px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{display:flex;flex-direction:column;gap:12px;min-height:210px;padding:20px;border:1px solid var(--line);border-radius:10px;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.025));text-decoration:none;transition:.18s ease}.card:hover{transform:translateY(-2px);border-color:rgba(215,181,109,.45);background:rgba(215,181,109,.08)}.icon{width:34px;height:34px;border:1px solid rgba(215,181,109,.35);border-radius:9px;display:grid;place-items:center;color:var(--gold)}.icon svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.card h3{font-family:Georgia,serif;font-size:23px;margin:0}.card p{color:var(--muted);margin:0}.status{margin-top:auto;color:var(--gold);font-size:12px;text-transform:uppercase;letter-spacing:.1em}.modes{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.mode{padding:18px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.04)}.mode h3{margin:0 0 10px;font-size:15px;color:var(--gold);text-transform:uppercase;letter-spacing:.1em}.mode a{display:block;color:var(--text);text-decoration:none;padding:8px 0;border-top:1px solid rgba(255,255,255,.07)}.journey{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.step{padding:18px;border-left:2px solid var(--gold);background:rgba(255,255,255,.04);border-radius:8px}.step span{color:var(--gold);font-size:11px;text-transform:uppercase;letter-spacing:.14em}.step h3{margin:8px 0 8px}.activity{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.activity div{padding:16px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.035);color:var(--muted)}details{border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.035);padding:0;margin-top:12px}summary{cursor:pointer;padding:18px 20px;color:var(--gold);font-weight:700;text-transform:uppercase;letter-spacing:.1em}.reference{padding:0 22px 24px;color:#e7dcc5}.reference h1,.reference h2,.reference h3{font-family:Georgia,serif;color:var(--gold)}.reference h2{border-top:1px solid var(--line);padding-top:22px}.reference code{background:rgba(255,255,255,.08);padding:2px 5px;border-radius:5px}.reference li{margin:4px 0 4px 22px}@media(max-width:850px){.grid,.modes,.journey,.activity{grid-template-columns:1fr}.hero{min-height:280px}.card{min-height:170px}}
</style></head><body><div class="top"><a href="/dashboard">Back to VAL</a></div><main class="wrap">
<section class="hero"><div><div class="eyebrow">Velocity-Activated Leverage</div><h1>VAL</h1><p>Your executive operating layer. Never lose track of important people, promises, or opportunities again.</p><div class="actions"><a class="btn" href="/dashboard">Open Today</a><a class="btn secondary" href="/dashboard">Run Radar</a></div></div></section>
<section><div class="section-head"><div><h2>Your Priorities</h2><p>Start with the moves that create clarity fastest.</p></div></div><div class="grid">
<a class="card" href="/dashboard"><span class="icon">${icon.calendar}</span><h3>Prepare For Today</h3><p>Know who matters before your next conversation.</p><div class="status" id="meetingStatus">Loading meetings</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.radar}</span><h3>Relationship Radar</h3><p>See who needs follow-up before momentum dies.</p><div class="status" id="radarStatus">Checking signals</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.stack}</span><h3>Approval Queue</h3><p>Review drafts, promises, and pending actions.</p><div class="status" id="queueStatus">Loading drafts</div></a>
</div></section>
<section><div class="section-head"><div><h2>Your First 3 Minutes</h2><p>A short path that helps VAL understand you and start creating momentum.</p></div></div><div class="journey"><div class="step"><span>Step 1</span><h3>Personalize VAL</h3><p>Tell VAL who you are, how you work, and what relationships drive your business.</p><a class="btn secondary" href="/dashboard">Personalize VAL</a></div><div class="step"><span>Step 2</span><h3>Review Today</h3><p>See meetings, priorities, and what needs your attention before the day gets noisy.</p><a class="btn secondary" href="/dashboard">Open Today View</a></div><div class="step"><span>Step 3</span><h3>Run Radar</h3><p>Find the people and promises most likely to create value or lose trust if ignored.</p><a class="btn secondary" href="/dashboard">Run Relationship Radar</a></div></div></section>
<section><div class="section-head"><div><h2>What Do You Want To Do?</h2><p>Choose by outcome, not by feature name.</p></div></div><div class="modes"><div class="mode"><h3>Stay Ahead</h3><a href="/dashboard">Meeting Prep</a><a href="/dashboard">Daily Rhythm</a><a href="/dashboard">Calendar Intelligence</a></div><div class="mode"><h3>Protect Relationships</h3><a href="/dashboard">Relationship Radar</a><a href="/dashboard">Follow-Ups</a><a href="/dashboard">Contact Command Center</a></div><div class="mode"><h3>Clear Mental Load</h3><a href="/dashboard">Approval Queue</a><a href="/dashboard">Drafts</a><a href="/dashboard">Tasks By Relationship</a></div><div class="mode"><h3>Think Better</h3><a href="/dashboard">Voice Mode</a><a href="/dashboard">Executive Reflection</a><a href="/dashboard">Use Saved Time</a></div></div></section>
<section><div class="section-head"><div><h2>Recent Activity</h2><p>VAL should feel alive. These signals update from your workspace.</p></div></div><div class="activity"><div id="activityMeetings">Meetings loading</div><div id="activityTasks">Tasks loading</div><div id="activityFollowups">Follow-ups loading</div></div></section>
<section><div class="section-head"><div><h2>Learn VAL</h2><p>The full reference is here when you want depth. You do not need to study it first.</p></div></div><details><summary>See Full Reference</summary><div class="reference"><p>${referenceHtml}</p></div></details></section>
</main><script>
async function json(url){try{const r=await fetch(url);return r.ok?await r.json():null}catch(e){return null}}
function set(id,text){const el=document.getElementById(id);if(el)el.textContent=text}
(async()=>{
  const [tasks,cal,comms,props]=await Promise.all([json('/api/val/tasks'),json('/api/calendar'),json('/api/comms'),json('/api/proposals')]);
  const open=Array.isArray(tasks)?tasks.filter(t=>!t.completed):[];
  const overdue=open.filter(t=>t.dueDate&&new Date(t.dueDate)<new Date());
  const events=(cal&&cal.calendarEvents)||[];
  const today=events.filter(e=>{const raw=e.startTime||e.date||(e.start&&(e.start.dateTime||e.start.date));return raw&&new Date(raw).toDateString()===new Date().toDateString()});
  const unread=(comms&&comms.total)||0;
  const drafts=(props&&props.draft)||0;
  set('meetingStatus',today.length?today.length+' meetings today':'No meetings today');
  set('radarStatus',(unread+overdue.length)?(unread+overdue.length)+' signals need attention':'All clear right now');
  set('queueStatus',drafts?drafts+' drafts waiting':'No drafts waiting');
  set('activityMeetings',today.length?today.length+' meetings on deck':'Calendar is clear today');
  set('activityTasks',overdue.length?overdue.length+' overdue tasks':open.length+' open tasks');
  set('activityFollowups',unread?unread+' unread conversations':'No unread conversations');
})();
</script></body></html>`;
}
app.get('/guide',(req,res)=>{
  const file = path.join(__dirname,'VAL_USER_GUIDE.md');
  fs.readFile(file,'utf8',(err,markdown)=>{
    if(err) return res.status(404).send('VAL guide not found.');
    res.type('html').send(guideHtml(markdown));
  });
});
app.use(express.static(__dirname));
app.get('/dashboard',(req,res)=>res.sendFile(path.join(__dirname,'val-mark-goall.html')));

// ════════════════════════════════════════════════════════
// GOOGLE OAUTH
// ════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI         = process.env.REDIRECT_URI || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/callback`;
let googleTokens = {}; // hot cache; durable copy lives in Postgres or GOOGLE_REFRESH_TOKEN
let googleTokensLoaded = false;
let lastGoogleAuthError = null;

// On startup, load refresh token from env if available
if(process.env.GOOGLE_REFRESH_TOKEN){
  googleTokens.refresh_token = process.env.GOOGLE_REFRESH_TOKEN;
  googleTokens.issued_at = 0; // force refresh on first use
  console.log('Loaded Google refresh token from env var');
}

async function saveOAuthTokens(provider,tokens){
  if(!tokens||!Object.keys(tokens).length) return;
  if(pgPool){
    await valDbReady;
    await dbQuery(`
      insert into val_oauth_tokens (provider,user_id,tokens,updated_at)
      values ($1,$2,$3,now())
      on conflict (provider) do update set tokens=excluded.tokens, updated_at=now()
    `,[provider,VAL_USER_ID,JSON.stringify(tokens)]);
  }else{
    const store=valStore();
    store.oauthTokens=store.oauthTokens||{};
    store.oauthTokens[provider]=tokens;
    saveValStore(store);
  }
}

async function loadOAuthTokens(provider){
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select tokens from val_oauth_tokens where provider=$1',[provider]);
    return r.rows[0]?.tokens || null;
  }
  return (valStore().oauthTokens||{})[provider] || null;
}

async function ensureGoogleTokensLoaded(){
  if(googleTokensLoaded) return;
  const saved=await loadOAuthTokens('google');
  if(saved){
    googleTokens={...googleTokens,...saved};
    console.log('Loaded Google tokens from VAL store');
  }
  googleTokensLoaded = true;
}

// Step 1 — redirect user to Google consent screen
// ── IMAGE ANALYSIS (GPT-4o) ─────────────────────────────
app.post('/api/analyze-image',async(req,res)=>{
  try{
    const {base64,mediaType,prompt}=req.body;
    if(!base64||!mediaType) return res.status(400).json({error:'Missing base64 or mediaType'});
    if(!OPENAI_KEY) return res.status(500).json({error:'OPENAI_KEY not configured'});
    const r=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
      body:JSON.stringify({
        model:'gpt-4o',
        max_tokens:1000,
        messages:[{
          role:'user',
          content:[
            {type:'image_url',image_url:{url:`data:${mediaType};base64,${base64}`}},
            {type:'text',text:prompt||'Analyze this image and give detailed feedback. What do you see, what\'s working well, and what could be improved?'}
          ]
        }]
      })
    });
    const d=await r.json();
    if(d.error) return res.status(500).json({error:d.error.message});
    res.json({reply:d.choices?.[0]?.message?.content||'No response'});
  }catch(e){
    console.error('image analysis error:',e);
    res.status(500).json({error:e.message});
  }
});

// ── IMAGE GENERATION (DALL-E 3) ─────────────────────────
app.post('/api/generate-image',async(req,res)=>{
  try{
    const {prompt,size,quality}=req.body;
    if(!prompt) return res.status(400).json({error:'Missing prompt'});
    if(!OPENAI_KEY) return res.status(500).json({error:'OPENAI_KEY not configured'});
    const r=await fetch('https://api.openai.com/v1/images/generations',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
      body:JSON.stringify({
        model:'dall-e-3',
        prompt,
        n:1,
        size:size||'1024x1024',
        quality:quality||'standard',
        response_format:'url'
      })
    });
    const d=await r.json();
    if(d.error) return res.status(500).json({error:d.error.message});
    const url=d.data?.[0]?.url;
    const revised=d.data?.[0]?.revised_prompt;
    res.json({url,revisedPrompt:revised});
  }catch(e){
    console.error('image generation error:',e);
    res.status(500).json({error:e.message});
  }
});

app.get('/auth/google', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.readonly'
  ].join(' ');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;
  res.redirect(url);
});

// Step 2 — Google redirects back with code, exchange for tokens
app.get('/auth/callback', async (req, res) => {
  const {code} = req.query;
  if(!code) return res.status(400).send('No code received');
  try {
    const existingTokens = await loadOAuthTokens('google') || googleTokens || {};
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const exchangedTokens = await r.json();
    if(exchangedTokens.error) throw new Error(exchangedTokens.error_description || exchangedTokens.error);
    googleTokens = {
      ...existingTokens,
      ...exchangedTokens,
      refresh_token: exchangedTokens.refresh_token || existingTokens.refresh_token || process.env.GOOGLE_REFRESH_TOKEN
    };
    googleTokens.issued_at = Date.now();
    googleTokensLoaded = true;
    lastGoogleAuthError = null;
    await saveOAuthTokens('google',googleTokens);
    console.log('Google tokens stored. refresh_token present:', !!googleTokens.refresh_token);
    // Log refresh token so it can be saved as GOOGLE_REFRESH_TOKEN env var in Railway
    if(googleTokens.refresh_token){
      console.log('SAVE THIS AS GOOGLE_REFRESH_TOKEN ENV VAR:', googleTokens.refresh_token);
    }
    res.send(`<h2 style="font-family:sans-serif;padding:2rem">✅ Google Calendar & Gmail connected to VAL!<br><br>You can close this tab.</h2>`);
  } catch(e) {
    res.status(500).send('Auth failed: '+e.message);
  }
});

// Refresh access token if expired
async function getGoogleToken() {
  await ensureGoogleTokensLoaded();
  // If no access token but we have a refresh token, go get one
  if(!googleTokens.access_token && googleTokens.refresh_token) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: googleTokens.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const fresh = await r.json();
      if(fresh.error){ lastGoogleAuthError = fresh.error_description || fresh.error; console.error('Token bootstrap failed:', fresh.error, fresh.error_description); return null; }
      googleTokens = {...googleTokens, ...fresh, issued_at: Date.now()};
      googleTokensLoaded = true;
      lastGoogleAuthError = null;
      await saveOAuthTokens('google',googleTokens);
      console.log('Bootstrapped access token from refresh token');
      return googleTokens.access_token;
    } catch(e) {
      console.error('Token bootstrap error:', e);
      return null;
    }
  }
  if(!googleTokens.access_token) return null;
  // Check if expired (with 60s buffer)
  const expiresAt = (googleTokens.issued_at||0) + (googleTokens.expires_in||3600)*1000 - 60000;
  if(Date.now() < expiresAt) return googleTokens.access_token;
  // Refresh
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: googleTokens.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const fresh = await r.json();
    if(fresh.error){ lastGoogleAuthError = fresh.error_description || fresh.error; console.error('Token refresh failed:', fresh.error, fresh.error_description); return null; }
    googleTokens = {...googleTokens, ...fresh, issued_at: Date.now()};
    googleTokensLoaded = true;
    lastGoogleAuthError = null;
    await saveOAuthTokens('google',googleTokens);
    return googleTokens.access_token;
  } catch(e) {
    lastGoogleAuthError = e.message;
    console.error('Token refresh failed:', e);
    return null;
  }
}

// Auth status check
app.get('/auth/status', async (req, res) => {
  const token = await getGoogleToken();
  res.json({
    connected: !!token,
    hasRefreshToken: !!googleTokens.refresh_token,
    needsAuth: !token,
    error: token ? null : lastGoogleAuthError
  });
});

// ════════════════════════════════════════════════════════
// GOOGLE CALENDAR
// ════════════════════════════════════════════════════════

app.get('/api/google/calendar', async (req, res) => {
  try {
    const now = new Date();
    const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate()+7);
    const events = await fetchGoogleCalendarEvents(now,weekEnd,50);
    res.json({calendarEvents: events});
  } catch(e) {
    res.json({calendarEvents:[], needsAuth: /google auth/i.test(e.message), authUrl:'/auth/google', error: e.message});
  }
});

async function fetchGoogleCalendarEvents(start,end,maxResults=50){
  const token = await getGoogleToken();
  if(!token) throw new Error('Google auth required');
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=${maxResults}`;
  const r = await fetch(url, {headers:{Authorization:`Bearer ${token}`}});
  const d = await r.json();
  if(d.error) throw new Error(d.error.message || 'Google calendar error');
  return (d.items||[]).map(e=>({
    id: e.id,
    summary: e.summary||'(No title)',
    title: e.summary||'(No title)',
    startTime: e.start?.dateTime||e.start?.date,
    endTime: e.end?.dateTime||e.end?.date,
    location: e.location,
    description: e.description,
    attendees: (e.attendees||[]).map(a=>({name:a.displayName||'',email:a.email||'',responseStatus:a.responseStatus||''})),
    status: e.status,
    source: 'google',
    calendarName: 'Mark Google Calendar'
  }));
}

async function fetchGhlCalendarEvents(start,end){
  const calendarMap = new Map();
  let calendarIds = GHL_CALENDAR_IDS.slice();
  if(!calendarIds.length){
    try{
      const data = await ghl('GET',`/calendars/?locationId=${GHL_LOC}`);
      const calendars = data.calendars || [];
      calendars.forEach(c=>{ if(c.id){ calendarMap.set(String(c.id),c.name||c.title||'GHL Calendar'); calendarIds.push(String(c.id)); } });
    }catch(e){ console.error('GHL calendar list error:',e.message); }
  }
  calendarIds = Array.from(new Set(calendarIds));
  const range = `locationId=${GHL_LOC}&startTime=${start.getTime()}&endTime=${end.getTime()}`;
  const calls = calendarIds.length
    ? calendarIds.map(id=>ghl('GET',`/calendars/events?${range}&calendarId=${encodeURIComponent(id)}`).then(d=>({id,data:d})))
    : [ghl('GET',`/calendars/events?${range}`).then(d=>({id:'all',data:d}))];
  const results = await Promise.allSettled(calls);
  const seen = new Set();
  const events = [];
  results.forEach(r=>{
    if(r.status!=='fulfilled') return;
    const calendarId = r.value.id;
    const list = r.value.data.events || r.value.data.appointments || [];
    list.forEach(ev=>{
      const key = `${ev.id||ev.appointmentId||ev.startTime||ev.start}-${calendarId}`;
      if(seen.has(key)) return;
      seen.add(key);
      events.push({
        id: ev.id||ev.appointmentId,
        title: ev.title||ev.name||ev.summary,
        summary: ev.title||ev.name||ev.summary,
        contactName: ev.contactName||ev.contact?.name,
        startTime: ev.startTime||ev.start,
        endTime: ev.endTime||ev.end,
        status: ev.appointmentStatus||ev.status,
        source: 'ghl',
        owner: inferValOwner(ev),
        calendarId,
        calendarName: calendarMap.get(String(calendarId)) || ev.calendarName || 'GHL Calendar'
      });
    });
  });
  return events;
}

// ════════════════════════════════════════════════════════
// GMAIL — replies from GHL contacts only
// ════════════════════════════════════════════════════════

app.get('/api/google/gmail', async (req, res) => {
  try {
    const token = await getGoogleToken();
    if(!token) return res.json({emails:[], needsAuth: true});

    // First get GHL contacts to cross-reference
    const contactsData = await ghl('GET', `/contacts/?locationId=${GHL_LOC}&limit=100&sortBy=date_added&sortDirection=desc`);
    const contacts = contactsData.contacts||[];
    const contactEmails = new Set(contacts.map(c=>c.email).filter(Boolean).map(e=>e.toLowerCase()));

    // Search Gmail for recent unread messages
    const searchUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread newer_than:7d&maxResults=20`;
    const r = await fetch(searchUrl, {headers:{Authorization:`Bearer ${token}`}});
    const d = await r.json();
    const messages = d.messages||[];

    // Fetch each message header
    const emailDetails = await Promise.all(messages.slice(0,10).map(async m=>{
      const mr = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        {headers:{Authorization:`Bearer ${token}`}});
      const md = await mr.json();
      const headers = md.payload?.headers||[];
      const from = headers.find(h=>h.name==='From')?.value||'';
      const subject = headers.find(h=>h.name==='Subject')?.value||'';
      const date = headers.find(h=>h.name==='Date')?.value||'';
      const emailMatch = from.match(/<(.+?)>/)||[null,from];
      const fromEmail = emailMatch[1]?.toLowerCase()||'';
      const fromName = from.replace(/<.*>/,'').trim().replace(/"/g,'');
      const isGHLContact = contactEmails.has(fromEmail);
      return {id:m.id, from, fromEmail, fromName, subject, date, isGHLContact};
    }));

    const ghlEmails = emailDetails.filter(e=>e.isGHLContact);
    res.json({emails: emailDetails, ghlEmails, total: messages.length});
  } catch(e) {
    res.json({emails:[], error: e.message});
  }
});

function normalizeAttendee(attendee){
  if(!attendee) return null;
  if(typeof attendee === 'string'){
    const emailMatch = attendee.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const email = emailMatch ? emailMatch[0].toLowerCase() : '';
    const name = attendee.replace(/<.*?>/g,'').replace(email,'').trim();
    if(!email && !name) return null;
    return {name:name || email.split('@')[0] || '', email};
  }
  const email = String(attendee.email || attendee.contactEmail || '').trim().toLowerCase();
  const name = String(attendee.displayName || attendee.name || attendee.contactName || '').trim();
  if(!email && !name) return null;
  return {name:name || (email ? email.split('@')[0] : ''), email};
}

function inferAttendeesFromEvent(event){
  const seen = new Set();
  const people = [];
  const push = (item)=>{
    const attendee = normalizeAttendee(item);
    if(!attendee) return;
    if(attendee.email && OWNER_EMAILS.has(attendee.email)) return;
    const key = (attendee.email || attendee.name).toLowerCase();
    if(!key || seen.has(key)) return;
    seen.add(key);
    people.push(attendee);
  };
  (Array.isArray(event.attendees) ? event.attendees : []).forEach(push);
  if(event.organizer) push(event.organizer);
  if(event.creator) push(event.creator);
  if(event.contact || event.contactName) push({name:event.contact || event.contactName, email:event.contactEmail || ''});
  const text = [event.title,event.summary,event.description,event.desc,event.notes].filter(Boolean).join(' ');
  (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).forEach(email=>push({email}));
  if(!people.length){
    const title = String(event.title || event.summary || '').replace(/\b(call|meeting|sync|strategy|consult|session|with)\b/ig,' ');
    title.split(/\s[-|/:]\s|\swith\s/i).map(s=>s.trim()).filter(s=>/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(s)).forEach(name=>push({name}));
  }
  return people.slice(0,8);
}

function mapGoogleEvent(ev){
  return {
    id:ev.id, summary:ev.summary||'(No title)',
    startTime:ev.start?.dateTime||ev.start?.date,
    endTime:ev.end?.dateTime||ev.end?.date,
    location:ev.location||'',
    description:ev.description||'',
    attendees:(ev.attendees||[]).map(a=>({name:a.displayName||'',email:a.email||'',responseStatus:a.responseStatus||'',self:!!a.self,organizer:!!a.organizer})),
    attendeesOmitted:!!ev.attendeesOmitted,
    organizer:ev.organizer?{name:ev.organizer.displayName||'',email:ev.organizer.email||'',self:!!ev.organizer.self}:null,
    creator:ev.creator?{name:ev.creator.displayName||'',email:ev.creator.email||'',self:!!ev.creator.self}:null,
    hangoutLink:ev.hangoutLink||'',
    status:ev.status, source:'google'
  };
}

async function hydrateGoogleEventAttendees(token,ev){
  if(ev.attendees&&ev.attendees.length&&!ev.attendeesOmitted) return ev;
  try{
    const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(ev.id)}?maxAttendees=50`,{headers:{Authorization:`Bearer ${token}`}});
    const full=await r.json();
    if(!full.error) return {...ev,...full};
  }catch(e){console.log('Google event attendee hydrate failed:',e.message);}
  return ev;
}

function extractLinkedInUrl(data){
  const text = JSON.stringify(data||{});
  return (text.match(/https?:\/\/([a-z]+\.)?linkedin\.com\/in\/[^"',\s)]+/i)||[])[0] || '';
}

function extractEmailsFromValue(value){
  const text = typeof value === 'string' ? value : JSON.stringify(value||'');
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(e=>e.toLowerCase())
    .filter(e=>!/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e))
    .filter(e=>!/(example|domain|email\.com|sentry|wixpress|wordpress|schema\.org)/i.test(e)))];
}

function firstEmailFrom(...values){
  for(const value of values){
    const found = extractEmailsFromValue(value);
    if(found.length) return found[0];
  }
  return '';
}

function isLikelyPersonEmail(email){
  const local = String(email||'').split('@')[0].toLowerCase();
  if(!local) return false;
  return !/^(info|hello|contact|support|admin|office|team|media|press|help|careers|jobs|webmaster|noreply|no-reply)$/.test(local);
}

function classifyEmail(email){
  if(!email) return 'missing';
  const local=String(email).split('@')[0].toLowerCase();
  if(isLikelyPersonEmail(email)) return 'person';
  if(/^(sales|partnerships|bizdev|businessdevelopment|hr|humanresources|benefits|operations|ops|owner|founder|ceo|president|director)$/.test(local)) return 'high-value role';
  return 'general';
}

function normalizeRocketReachPerson(data){
  const person = data.person || data.profile || data.data || data;
  return {
    found: !!(person && Object.keys(person).length),
    id: person.id || person.profile_id || '',
    name: person.name || person.full_name || [person.first_name,person.last_name].filter(Boolean).join(' '),
    title: person.current_title || person.title || person.job_title || '',
    company: person.current_employer || person.current_company || person.company || '',
    location: person.location || person.city || '',
    linkedinUrl: person.linkedin_url || person.linkedin || extractLinkedInUrl(person),
    connections: person.connections || person.num_connections || person.linkedin_connections || null,
    mutualConnections: person.mutual_connections || person.shared_connections || person.common_connections || null,
    rawPreview: JSON.stringify(person).slice(0,1400)
  };
}

async function lookupRocketReach(attendee){
  if(!ROCKETREACH_API_KEY) return {configured:false, error:'ROCKETREACH_API_KEY is not set'};
  if(Date.now()<rocketReachLimitedUntil) return {configured:true, error:'RocketReach rate-limited; skipped to protect quota'};
  const params = new URLSearchParams();
  if(attendee.email) params.set('email',attendee.email);
  if(attendee.linkedinUrl) params.set('linkedin_url',attendee.linkedinUrl);
  if(attendee.name) params.set('name',attendee.name);
  if(attendee.company) params.set('current_employer',attendee.company);
  const url = `${ROCKETREACH_BASE_URL.replace(/\/$/,'')}/person/lookup?${params.toString()}`;
  const response = await fetch(url,{headers:{'Api-Key':ROCKETREACH_API_KEY}});
  const data = await readJsonResponse(response);
  if(response.status===429){
    rocketReachLimitedUntil = Date.now() + 10*60*1000;
    return {configured:true, error:'RocketReach 429 rate limit'};
  }
  if(!response.ok) return {configured:true, error:data.message || data.error || `RocketReach ${response.status}`};
  return {configured:true, data:normalizeRocketReachPerson(data)};
}

async function lookupOutscraperLinkedIn(attendee, profile){
  if(!OUTSCRAPER_API_KEY) return {configured:false, error:'OUTSCRAPER_API_KEY is not set'};
  if(!OUTSCRAPER_LINKEDIN_POSTS_URL) return {configured:false, error:'OUTSCRAPER_LINKEDIN_POSTS_URL is not set'};
  const url = new URL(OUTSCRAPER_LINKEDIN_POSTS_URL);
  const query = profile?.linkedinUrl || attendee.linkedinUrl || attendee.email || attendee.name;
  if(query) url.searchParams.set('query', query);
  url.searchParams.set('async','false');
  const response = await fetch(url.toString(),{headers:{'X-API-KEY':OUTSCRAPER_API_KEY}});
  const data = await readJsonResponse(response);
  if(!response.ok) return {configured:true, error:data.errorMessage || data.message || `Outscraper ${response.status}`};
  const posts = Array.isArray(data.data) ? data.data.flat(3).filter(Boolean) : [];
  const weekAgo = Date.now() - 7*24*60*60*1000;
  const recentPosts = posts.filter(p=>{
    const rawDate = p.date || p.posted_at || p.created_at || p.time || p.timestamp;
    const time = rawDate ? new Date(rawDate).getTime() : NaN;
    return !Number.isFinite(time) || time >= weekAgo;
  }).slice(0,6).map(p=>({
    date:p.date || p.posted_at || p.created_at || '',
    text:String(p.text || p.post_text || p.content || p.description || p.title || '').slice(0,700),
    url:p.url || p.post_url || p.link || ''
  }));
  return {configured:true, postsLastWeek:recentPosts, rawCount:posts.length};
}

app.post('/api/val/meeting-intel',async(req,res)=>{
  try{
    const event = req.body.event || req.body || {};
    const attendees = inferAttendeesFromEvent(event);
    const enriched = [];
    for(const attendee of attendees){
      const rocket = await lookupRocketReach(attendee).catch(e=>({configured:!!ROCKETREACH_API_KEY,error:e.message}));
      const profile = rocket.data || {};
      const outscraper = await lookupOutscraperLinkedIn(attendee,profile).catch(e=>({configured:!!OUTSCRAPER_API_KEY,error:e.message}));
      enriched.push({attendee, rocketReach:rocket, outscraper});
    }
    res.json({ok:true, attendees:enriched, missingConfig:{
      rocketReach:!ROCKETREACH_API_KEY
    }, optionalConfig:{
      outscraperConfigured:!!OUTSCRAPER_API_KEY && !!OUTSCRAPER_LINKEDIN_POSTS_URL
    }});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════
// DASHBOARD ENDPOINTS (called by VAL on load)
// ════════════════════════════════════════════════════════

app.get('/api/meetings',async(req,res)=>{
  try{
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setHours(23,59,59,999);

    const [ghlRes,googleRes] = await Promise.allSettled([
      fetchGhlCalendarEvents(s,e),
      fetchGoogleCalendarEvents(s,e,25)
    ]);

    const ghlEvents = ghlRes.status==='fulfilled' ? ghlRes.value : [];
    const googleEvents = googleRes.status==='fulfilled' ? googleRes.value : [];
    const allEvents=[...ghlEvents,...googleEvents];
    allEvents.sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
    res.json({meetingsToday:allEvents.length, appointments:allEvents, calendarSource:'ghl+google', calendarId:GHL_CALENDAR_ID, _debug:{ghlCount:ghlEvents.length, googleCount:googleEvents.length, googleNeedsAuth:googleRes.status==='rejected'}});
  }catch(e){
    console.error('meetings error:',e);
    res.json({meetingsToday:0,appointments:[]});
  }
});

async function fetchGhlOpportunities({status='open',limit=100}={}){
  const encodedLoc=encodeURIComponent(GHL_LOC);
  const encodedStatus=encodeURIComponent(status);
  const attempts=[
    `/opportunities/search?location_id=${encodedLoc}&status=${encodedStatus}&limit=${limit}`,
    `/opportunities/search?locationId=${encodedLoc}&status=${encodedStatus}&limit=${limit}`,
    `/opportunities/search?location_id=${encodedLoc}&limit=${limit}`,
    `/opportunities/search?locationId=${encodedLoc}&limit=${limit}`
  ];
  const results=[];
  for(const path of attempts){
    const r=await ghlTry('GET',path);
    const opportunities=(r.data&&Array.isArray(r.data.opportunities))?r.data.opportunities:[];
    results.push({path,status:r.status,ok:r.ok,count:opportunities.length,error:r.ok?'':(r.data?.message||r.data?.error||r.data?.raw||'')});
    if(r.ok&&opportunities.length){
      if(!path.includes('status=')){
        const open=opportunities.filter(o=>String(o.status||'').toLowerCase()==='open');
        if(open.length) r.data={...r.data,opportunities:open,meta:{...(r.data.meta||{}),total:open.length}};
      }
      return {path,data:r.data,attempts:results};
    }
  }
  const firstOk=results.find(r=>r.ok);
  if(firstOk){
    const r=await ghlTry('GET',firstOk.path);
    return {path:firstOk.path,data:r.data||{},attempts:results};
  }
  throw new Error('GHL opportunities search failed: '+results.map(r=>`${r.status} ${r.path}`).join(' | '));
}

app.get('/api/pipeline',async(req,res)=>{
  try{
    if(!GHL_KEY||!GHL_LOC){
      return res.json({pipelineActive:0,stalledDeals:0,opportunities:[],_debug:{configured:false,error:'Missing GHL_KEY or GHL_LOC'}});
    }
    const found=await fetchGhlOpportunities({status:'open',limit:100});
    const d=found.data||{};
    const opps=d.opportunities||[];
    const now=Date.now();
    const stalled=opps.filter(o=>(now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())>14*24*60*60*1000);

    const enriched=await mapWithConcurrency(opps,6,async o=>{
      const stage=o.pipelineStage?.name||o.stage?.name||o.stageName||o.pipelineStage||'Unknown Stage';
      const contactId=o.contact?.id||o.contactId;
      let notes=[];
      let contactEmail='';
      let contactPhone='';
      try{
        if(contactId){
          const [notes,contactData]=await Promise.all([
            fetchContactNotes(contactId,20),
            ghl('GET',`/contacts/${contactId}`)
          ]);
          contactEmail=contactData.contact?.email||'';
          contactPhone=contactData.contact?.phone||'';
        }
      }catch(e){console.log('contact enrich error:',e.message);}
      return {
        id:o.id,
        name:o.name,
        status:o.status,
        stage,
        value:o.monetaryValue,
        contactName:o.contact?.name||o.contactName||'',
        contactId,
        contactEmail,
        contactPhone,
        owner:inferValOwner(o),
        notes,
        updatedAt:o.updatedAt,
        daysInStage:Math.floor((now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())/(24*60*60*1000)),
        stalled:(now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())>14*24*60*60*1000
      };
    });

    res.json({pipelineActive:d.meta?.total||opps.length,stalledDeals:stalled.length,opportunities:enriched,_debug:{configured:true,path:found.path,attempts:found.attempts}});
  }catch(e){console.error('pipeline error:',e);res.json({pipelineActive:0,stalledDeals:0,opportunities:[],_debug:{error:e.message}});}
});

app.get('/api/debug/ghl-pipeline',async(req,res)=>{
  try{
    if(!GHL_KEY||!GHL_LOC){
      return res.json({configured:false,error:'Missing GHL_KEY or GHL_LOC'});
    }
    const found=await fetchGhlOpportunities({status:req.query.status||'open',limit:Number(req.query.limit||100)});
    res.json({
      configured:true,
      locationId:GHL_LOC,
      selectedPath:found.path,
      attempts:found.attempts,
      count:(found.data.opportunities||[]).length,
      sample:(found.data.opportunities||[]).slice(0,3).map(o=>({
        id:o.id,
        name:o.name,
        contactName:o.contact?.name||o.contactName,
        contactId:o.contact?.id||o.contactId,
        status:o.status,
        stage:o.pipelineStage?.name||o.stage?.name||o.stageName||o.pipelineStage,
        pipelineId:o.pipelineId,
        pipelineStageId:o.pipelineStageId
      }))
    });
  }catch(e){
    res.json({configured:!!(GHL_KEY&&GHL_LOC),error:e.message});
  }
});

app.get('/api/calendar',async(req,res)=>{
  try{
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setDate(e.getDate()+7);e.setHours(23,59,59,999);

    const [ghlRes,googleRes] = await Promise.allSettled([
      fetchGhlCalendarEvents(s,e),
      fetchGoogleCalendarEvents(s,e,75)
    ]);

    const ghlEvents = ghlRes.status==='fulfilled'?ghlRes.value:[];
    const googleEvents = googleRes.status==='fulfilled'?googleRes.value:[];

    console.log(`Calendar: ${ghlEvents.length} GHL events across ${GHL_CALENDAR_IDS.length||'all'} calendars; ${googleEvents.length} Google events`);

    const mapped = [...ghlEvents,...googleEvents];
    mapped.sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
    res.json({
      calendarEvents:mapped,
      calendarSource:'ghl+google',
      calendarId:GHL_CALENDAR_ID,
      _debug:{ghlCount:ghlEvents.length, googleCount:googleEvents.length, googleNeedsAuth:googleRes.status==='rejected'}
    });
  }catch(e){
    console.error('calendar error:',e);
    res.json({calendarEvents:[],_debug:{error:e.message}});
  }
});

// Debug endpoint — raw calendar responses
app.get('/api/debug/calendar',async(req,res)=>{
  try{
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setDate(e.getDate()+7);e.setHours(23,59,59,999);

    const [c1,c2,c3] = await Promise.allSettled([
      ghl('GET',`/calendars/?locationId=${GHL_LOC}`),
      ghl('GET',`/calendars/groups?locationId=${GHL_LOC}`),
      ghl('GET',`/users/search?locationId=${GHL_LOC}&limit=10`)
    ]);

    const calendars = c1.status==='fulfilled'?(c1.value.calendars||[]):[];
    const groups = c2.status==='fulfilled'?(c2.value.groups||[]):[];

    // Try fetching events for first calendar if any
    let sampleEvents=[];
    if(calendars.length){
      try{
        const d=await ghl('GET',`/calendars/events?locationId=${GHL_LOC}&calendarId=${calendars[0].id}&startTime=${s.getTime()}&endTime=${e.getTime()}`);
        sampleEvents=(d.events||d.appointments||[]).slice(0,3).map(ev=>({title:ev.title||ev.name,start:ev.startTime||ev.start}));
      }catch(err){}
    }

    const token=await getGoogleToken();
    let googleRaw={needsAuth:true};
    if(token){
      const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${s.toISOString()}&timeMax=${e.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=5`,{headers:{Authorization:`Bearer ${token}`}});
      googleRaw=await r.json();
    }

    res.json({
      timeRange:{start:s.toISOString(),end:e.toISOString()},
      calendars: calendars.map(c=>({id:c.id,name:c.name,type:c.calendarType})),
      groups: groups.map(g=>({id:g.id,name:g.name})),
      sampleEvents,
      users: c3.status==='fulfilled'?{count:(c3.value.users||[]).length,keys:Object.keys(c3.value)}:{error:c3.reason?.message},
      google:{hasToken:!!token,itemsCount:(googleRaw.items||[]).length,needsAuth:!!googleRaw.needsAuth,error:googleRaw.error?.message,items:(googleRaw.items||[]).map(i=>({summary:i.summary,start:i.start}))}
    });
  }catch(e){res.json({error:e.message});}
});

// ── TASK INGEST — Make webhook posts tasks here, interface polls them ──
let injectedTasks = [];

app.post('/api/tasks/ingest', (req, res) => {
  try {
    const body = req.body;
    const now = new Date();
    // Accept Make's task payload: {contact_id, first_name, last_name, customData:{task,details}}
    // OR an array of tasks, OR legacy {title, contactName...} shape
    const incoming = Array.isArray(body) ? body : [body];
    const normalized = incoming
      .filter(t => t && (t.customData?.task || t.title || t.name))
      .map(t => {
        const isMakeShape = !!t.customData;
        return {
          id:          t.id || ('inj_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
          title:       isMakeShape ? t.customData.task : (t.title || t.name),
          contactName: isMakeShape ? ((t.first_name||'') + ' ' + (t.last_name||'')).trim() : (t.contactName || t.contact_name || ''),
          contactId:   t.contact_id || t.contactId || '',
          dueDate:     isMakeShape ? t.customData.details : (t.dueDate || t.due_date || null),
          status:      t.status || 'open',
          source:      'make',
          injectedAt:  now.toISOString(),
          overdue:     false,
        };
      });
    normalized.forEach(inc => {
      const idx = injectedTasks.findIndex(t => t.id === inc.id);
      if (idx >= 0) injectedTasks[idx] = inc;
      else injectedTasks.push(inc);
    });
    injectedTasks = injectedTasks.filter(t => t.status !== 'completed' && t.status !== 'done');
    console.log(`tasks/ingest: received ${normalized.length}, total stored: ${injectedTasks.length}`);
    res.json({ ok: true, received: normalized.length, total: injectedTasks.length });
  } catch(e) {
    console.error('tasks/ingest error:', e);
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tasks',async(req,res)=>{
  try{
    const now=new Date();
    const allTasks=await loadTasks();
    const open=allTasks.filter(t=>!t.completed);
    const overdue=open.filter(t=>t.dueDate&&new Date(t.dueDate)<now);
    res.json({openTasks:open.length,overdueTasks:overdue.length,source:'val',tasks:open.slice(0,100).map(t=>({...t,overdue:!!(t.dueDate&&new Date(t.dueDate)<now)}))});
  }catch(e){
    console.error('tasks error:',e);
    res.json({openTasks:0,overdueTasks:0,tasks:[],error:e.message});
  }
});

// Debug endpoint — tasks
app.get('/api/debug/tasks',async(req,res)=>{
  try{
    // Test contacts fetch several ways
    const [cRes1, cRes2, cRes3] = await Promise.allSettled([
      ghl('GET',`/contacts/?locationId=${GHL_LOC}&limit=5`),
      ghl('GET',`/contacts?locationId=${GHL_LOC}&limit=5`),
      ghl('GET',`/contacts/?locationId=${GHL_LOC}&limit=5&sortBy=date_added&sortDirection=desc`),
    ]);
    const fmtC=r=>r.status==='fulfilled'?{keys:Object.keys(r.value),count:(r.value.contacts||[]).length,first:(r.value.contacts||[])[0]?.id}:{error:r.reason?.message};

    // Test known contact task fetch (VAL contact from pipeline)
    const knownContactId='c2tu9Oh6ybL2WMQ5PVJQ';
    let knownContactTasks=null;
    try{
      const ct=await ghl('GET',`/contacts/${knownContactId}/tasks`);
      knownContactTasks={keys:Object.keys(ct),raw:ct};
    }catch(e){knownContactTasks={error:e.message};}

    // Try a broader contacts search
    let allContactsTest=null;
    try{
      const ac=await ghl('GET',`/contacts/?locationId=${GHL_LOC}&limit=100`);
      allContactsTest={count:(ac.contacts||[]).length,keys:Object.keys(ac),ids:(ac.contacts||[]).slice(0,5).map(c=>c.id)};
    }catch(e){allContactsTest={error:e.message};}

    res.json({
      contactsV1:fmtC(cRes1),
      contactsV2:fmtC(cRes2),
      contactsV3:fmtC(cRes3),
      allContactsTest,
      knownContactTasks,
      knownContactId
    });
  }catch(e){res.json({error:e.message});}
});

app.get('/api/proposals',async(req,res)=>{
  try{
    // Fetch all status groups in parallel using the correct endpoint
    const statusGroups={
      draft:['draft'],
      sent:['sent'],
      viewed:['viewed'],
      signed:['completed','accepted']  // 'signed' is not valid per GHL
    };

    const results=await Promise.allSettled(
      Object.entries(statusGroups).map(async([stage,statuses])=>{
        const statusParams=statuses.map(s=>`status[]=${s}`).join('&');
        const d=await ghl('GET',`/proposals/document?locationId=${GHL_LOC}&${statusParams}&skip=0&limit=20`);
        console.log(`proposals ${stage}:`,JSON.stringify(d).substring(0,200));
        const docs=d.documents||d.proposals||d.data||d.list||[];
        return {stage, docs};
      })
    );

    const byStage={draft:[],sent:[],viewed:[],signed:[]};
    results.forEach(r=>{
      if(r.status==='fulfilled'){
        const {stage,docs}=r.value;
        byStage[stage]=docs.map(d=>({
          id:d.id||d._id,
          title:d.name||d.title||d.documentName||'Proposal',
          status:d.status,
          stage,
          contactName:d.contactName||d.contact?.name||d.recipientName||'',
          value:d.amount||d.total||d.value||0,
          viewCount:d.viewCount||d.views||d.openCount||0,
          sentAt:d.sentAt||d.updatedAt||d.createdAt,
          signedAt:d.signedAt||d.completedAt||null,
          url:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/payments/proposals-estimates`
        }));
      }
    });

    const all=[...byStage.draft,...byStage.sent,...byStage.viewed,...byStage.signed];
    const waiting=[...byStage.sent,...byStage.viewed];

    res.json({
      total:waiting.length,
      draft:byStage.draft.length,
      sent:byStage.sent.length,
      viewed:byStage.viewed.length,
      signed:byStage.signed.length,
      allCount:all.length,
      proposals:all,
      waiting
    });
  }catch(e){
    console.error('proposals error:',e);
    res.json({total:0,draft:0,sent:0,viewed:0,signed:0,proposals:[],error:e.message});
  }
});

app.get('/api/debug/proposals',async(req,res)=>{
  const results={};
  const endpoints=[
    `/proposals/document?locationId=${GHL_LOC}&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=draft&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=sent&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=completed&limit=10`,
    `/proposals/document?locationId=${GHL_LOC}&status[]=viewed&limit=10`,
  ];
  await Promise.all(endpoints.map(async ep=>{
    try{const d=await ghl('GET',ep);results[ep]={status:'ok',keys:Object.keys(d),count:(d.documents||d.data||d.list||[]).length,sample:JSON.stringify(d).substring(0,300)};}
    catch(e){results[ep]={status:'error',message:e.message};}
  }));
  res.json(results);
});

// ── DEBUG: first unread conversation messages ──────────
app.get('/api/debug/conversation',async(req,res)=>{
  try{
    const d=await ghl('GET',`/conversations/search?locationId=${GHL_LOC}&limit=10`);
    const convos=d.conversations||[];
    const unread=convos.filter(c=>c.unreadCount>0);
    if(!unread.length) return res.json({error:'No unread conversations found', total:convos.length});
    const first=unread[0];
    const msgs=await ghl('GET',`/conversations/${first.id}/messages?limit=10`);
    res.json({
      conversationId:first.id,
      contactName:first.contactName,
      unreadCount:first.unreadCount,
      rawConversation:first,
      rawMessages:msgs
    });
  }catch(e){res.status(500).json({error:e.message});}
});

// ── CONVERSATION THREAD ────────────────────────────────
app.get('/api/conversation/:id',async(req,res)=>{
  const id=req.params.id;
  let convRaw={}, msgRaw={}, convErr=null, msgErr=null;
  try{
    convRaw=await ghl('GET',`/conversations/${id}`);
  }catch(e){ convErr=e.message; }

  try{
    msgRaw=await ghl('GET',`/conversations/${id}/messages?limit=20`);
  }catch(e){ msgErr=e.message; }

  const conv=convRaw.conversation||convRaw;

  // GHL nests messages as msgRaw.messages.messages
  const msgContainer=msgRaw.messages||msgRaw;
  const rawMessages=Array.isArray(msgContainer)?msgContainer
    :(msgContainer.messages||msgRaw.data||[]);

  console.log('rawMessages type:', typeof rawMessages, Array.isArray(rawMessages), 'length:', rawMessages.length);
  if(rawMessages[0]) console.log('first msg keys:', Object.keys(rawMessages[0]));

  const messages=rawMessages
    .filter(m=>m&&typeof m==='object')
    .slice(-15)
    .map(m=>{
      // GHL email messages store body in meta.email or body or html
      var body=m.body||m.text||m.content||m.html||m.message
        ||(m.meta&&m.meta.email&&m.meta.email.body)
        ||(m.attachments&&m.attachments[0]&&m.attachments[0].url?'[Attachment]':'')
        ||'(no body)';
      // Strip HTML tags for readability
      body=body.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
      var dir=(m.direction==='outbound'||m.type===1||m.type==='outbound')?'outbound':'inbound';
      return {
        id:m.id||'',
        direction:dir,
        body:body,
        type:m.type||m.messageType||m.contentType||'unknown',
        dateAdded:m.dateAdded||m.createdAt||'',
        from:dir==='outbound'?'You':conv.contactName||'Contact'
      };
    })
    .filter(m=>m.body&&m.body!=='(no body)');

  res.json({
    id,
    contactName:conv.contactName||conv.name||'Contact',
    contactId:conv.contactId||'',
    type:conv.type||'unknown',
    unreadCount:conv.unreadCount||0,
    lastMessageBody:conv.lastMessageBody||'',
    messages,
    lastMessage:messages[messages.length-1]?.body||conv.lastMessageBody||'',
    _debug:{convErr,msgErr,rawMessageCount:rawMessages.length,firstMsgKeys:rawMessages[0]?Object.keys(rawMessages[0]):[]}
  });
});

app.get('/api/comms',async(req,res)=>{
  try{
    const d=await ghl('GET',`/conversations/search?locationId=${GHL_LOC}&limit=50`);
    const convos=d.conversations||[];
    const unread=convos.filter(c=>c.unreadCount>0);
    res.json({
      total:unread.length,
      ghlUnread:unread.length,
      items:unread.map(c=>({
        id:c.id,
        label:`${c.contactName||'Contact'} (${c.unreadCount} unread)`,
        sublabel:c.lastMessage||'',
        source:'ghl',
        type:'unread',
        actionUrl:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/conversations/${c.id}`
      }))
    });
  }catch(e){
    console.error('comms error:',e);
    res.json({total:0,ghlUnread:0,items:[],error:e.message});
  }
});

app.get('/api/feed',async(req,res)=>{
  try{
    const now=Date.now();
    const todayStart=new Date();todayStart.setHours(0,0,0,0);
    const todayEnd=new Date();todayEnd.setHours(23,59,59,999);

    const [convosRes, oppsRes, tasksRes, calRes] = await Promise.allSettled([
      ghl('GET',`/conversations/search?locationId=${GHL_LOC}&limit=30`),
      ghl('GET',`/opportunities/search?location_id=${GHL_LOC}&status=open&limit=50`),
      ghl('GET',`/tasks/search?locationId=${GHL_LOC}&limit=50`),
      (async()=>{
        let events=[];
        try{
          events.push(...await fetchGhlCalendarEvents(todayStart,todayEnd));
          events.push(...await fetchGoogleCalendarEvents(todayStart,todayEnd,25).catch(()=>[]));
        }catch(e){}
        return events;
      })()
    ]);

    const items=[];

    // Unread conversations
    const convos=convosRes.status==='fulfilled'?(convosRes.value.conversations||[]):[];
    convos.filter(c=>c.unreadCount>0).slice(0,5).forEach(c=>{
      items.push({
        id:c.id,
        text:`${c.contactName||'Contact'} — ${c.unreadCount} unread message${c.unreadCount>1?'s':''}`,
        type:'Comms',color:'green',
        time:new Date(c.dateUpdated).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),
        actionUrl:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/conversations/${c.id}`
      });
    });

    // Stalled pipeline deals
    const opps=oppsRes.status==='fulfilled'?(oppsRes.value.opportunities||[]):[];
    opps.filter(o=>(now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())>7*24*60*60*1000).slice(0,3).forEach(o=>{
      const days=Math.floor((now-new Date(o.lastStatusChangeAt||o.updatedAt).getTime())/(24*60*60*1000));
      items.push({
        text:`${o.contact?.name||o.name} — pipeline stalled ${days}d`,
        type:'Pipeline',color:'amber',
        time:o.pipelineStage?.name||'Open',
        actionUrl:`https://app.gohighlevel.com/v2/location/${GHL_LOC}/opportunities/${o.id}`
      });
    });

    // Overdue tasks
    const tasks=tasksRes.status==='fulfilled'?(tasksRes.value.tasks||tasksRes.value||[]):[];
    const taskArr=Array.isArray(tasks)?tasks:(tasks.tasks||[]);
    taskArr.filter(t=>t.dueDate&&new Date(t.dueDate)<new Date()&&!t.completed).slice(0,3).forEach(t=>{
      items.push({
        text:`Overdue: ${t.title||t.name||'Task'}`,
        type:'Task',color:'red',
        time:new Date(t.dueDate).toLocaleDateString([],{month:'short',day:'numeric'})
      });
    });

    // Today's meetings
    const events=calRes.status==='fulfilled'?(Array.isArray(calRes.value)?calRes.value:[]):[];
    events.slice(0,3).forEach(e=>{
      const start=e.startTime||e.start?.dateTime||e.start?.date;
      items.push({
        text:`Meeting: ${e.title||e.summary||'Appointment'}`,
        type:'Meeting',color:'gold',
        time:start?new Date(start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):''
      });
    });

    // Sort: comms first, then pipeline, tasks, meetings
    const order={Comms:0,Pipeline:1,Task:2,Meeting:3};
    items.sort((a,b)=>(order[a.type]||9)-(order[b.type]||9));

    // Fallback if nothing
    if(!items.length){
      items.push({text:'All clear — no urgent signals',type:'Status',color:'navy',time:new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})});
    }

    res.json({feedItems:items,followups:convos.filter(c=>c.unreadCount>0).length});
  }catch(e){
    console.error('feed error:',e);
    res.json({feedItems:[{text:'Feed unavailable',type:'Error',color:'red',time:''}],followups:0});
  }
});

// ════════════════════════════════════════════════════════
// 1-2. CALENDAR TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/calendar/events',async(req,res)=>{
  try{
    const {calendarId,userId,groupId,startTime,endTime}=req.query;
    if(!calendarId && !GHL_CALENDAR_IDS.length){
      const s=startTime?new Date(Number(startTime)):new Date();
      const e=endTime?new Date(Number(endTime)):(()=>{const d=new Date();d.setDate(d.getDate()+7);return d;})();
      return res.json({events:await fetchGhlCalendarEvents(s,e)});
    }
    let qs=`locationId=${GHL_LOC}`;
    qs+=`&calendarId=${calendarId||GHL_CALENDAR_IDS[0]||GHL_CALENDAR_ID}`;
    if(userId)qs+=`&userId=${userId}`;
    if(groupId)qs+=`&groupId=${groupId}`;
    if(startTime)qs+=`&startTime=${startTime}`;
    if(endTime)qs+=`&endTime=${endTime}`;
    res.json(await ghl('GET',`/calendars/events?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/calendar/appointments/:id/notes',async(req,res)=>{
  try{res.json(await ghl('GET',`/calendars/appointments/${req.params.id}/notes`));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 3-10. CONTACT TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/contacts',async(req,res)=>{
  try{
    const {limit=20,query,sortBy,sortDirection}=req.query;
    let qs=`locationId=${GHL_LOC}&limit=${limit}`;
    if(query)qs+=`&query=${encodeURIComponent(query)}`;
    if(sortBy)qs+=`&sortBy=${sortBy}`;
    if(sortDirection)qs+=`&sortDirection=${sortDirection}`;
    res.json(await ghl('GET',`/contacts/?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/contacts',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts`,{...req.body,locationId:GHL_LOC}));}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/contacts/create',async(req,res)=>{
  try{
    const body=req.body||{};
    const name=body.name||[body.firstName,body.lastName].filter(Boolean).join(' ')||body.email||'New contact';
    const parts=String(name).trim().split(/\s+/).filter(Boolean);
    const payload={
      locationId:GHL_LOC,
      firstName:body.firstName||parts[0]||name,
      lastName:body.lastName||parts.slice(1).join(' '),
      email:body.email||undefined,
      phone:body.phone||undefined,
      tags:['val_created_contact']
    };
    const data=await ghl('POST',`/contacts`,payload);
    res.json({ok:true,created:true,contact:data.contact||data});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/research',async(req,res)=>{
  try{
    const body=req.body||{};
    const company=String(body.company||body.companyName||body.organization||body.organizationName||'').trim();
    const location=String(body.location||body.cityState||'').trim();
    const contactId=String(body.contactId||'').trim();
    if(!company) return res.status(400).json({error:'Missing company name'});
    const user=[
      'Research this potential business lead for GOALL using the GOALL lead intelligence standard.',
      'Company name: '+company,
      location?'City/state or market: '+location:'',
      body.website?'Known website: '+body.website:'',
      '',
      'Follow the required search process. Evaluate fit as a GOALL Agency business lead, especially employee count, hiring/growth signals, operational complexity, and reachable decision-makers. Return only the strict field outputs.'
    ].filter(Boolean).join('\n');
    const content=await callOpenAIWebResearch({system:GOALL_LEADS_SYSTEM_PROMPT,user,maxTokens:2600,temperature:0.1});
    if(!String(content||'').trim()) throw new Error('Lead search returned no content. Check OPENAI_KEY, model web-search support, and the requested organization name.');
    const fields=parseLeadFieldOutputs(content);
    let ghlUpdate={updated:false};
    if(contactId){
      ghlUpdate=await updateGhlLeadFields(contactId,fields).catch(e=>({updated:false,error:e.message}));
    }
    await saveMemoryItem({
      kind:'goall_lead_intelligence',
      summary:`Lead intelligence: ${company}${location?' - '+location:''}`,
      rawText:content,
      importance:3,
      metadata:{company,location,contactId,ghlUpdate}
    }).catch(()=>{});
    res.json({ok:true,company,location,content,fields,ghlUpdate});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/discover',async(req,res)=>{
  try{
    const body=req.body||{};
    const market=String(body.market||body.location||body.cityState||'').trim()||'United States';
    const criteria=String(body.criteria||body.query||'businesses with at least 300 employees or clear operational complexity').trim();
    const limit=leadLimitValue(body.limit);
    const system=[
      GOALL_LEADS_SYSTEM_PROMPT,
      'Discovery mode: find multiple potential GOALL Agency business leads, not one named company.',
      'Prioritize companies with visible evidence of employee size, hiring, expansion, multiple locations, operational complexity, or active sales/service teams.',
      'If exact employee count is not verified, do not invent it. Use "300+ employee likelihood: strong / moderate / weak / unclear" based only on public signals.',
      'Return a concise numbered list. No preamble.'
    ].join('\n\n');
    const user=[
      `Find ${limit} business prospects for GOALL.`,
      `Market: ${market}`,
      `Criteria: ${criteria}`,
      '',
      'For each prospect return:',
      'Name:',
      'Website:',
      'Industry:',
      'Location:',
      '300+ employee likelihood:',
      'Evidence signals:',
      'Likely decision-maker title:',
      'Why this fits GOALL Agency:',
      'Next outreach angle:',
      'Confidence:'
    ].join('\n');
    const content=await callOpenAIWebResearch({system,user,maxTokens:3600,temperature:0.2});
    if(!String(content||'').trim()) throw new Error('Prospect discovery returned no content. Check OPENAI_KEY and whether the selected model supports web search.');
    await saveMemoryItem({
      kind:'goall_prospect_discovery',
      summary:`Prospect discovery: ${criteria} in ${market}`,
      rawText:content,
      importance:3,
      metadata:{market,criteria,limit}
    }).catch(()=>{});
    res.json({ok:true,market,criteria,content});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/discover-create',async(req,res)=>{
  try{
    const body=req.body||{};
    const discovered=await discoverHbsLeadProspects(body);
    const imported=await importApprovedHbsLeads(discovered);
    res.json({...discovered,...imported});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/discover-preview',async(req,res)=>{
  try{
    const discovered=await discoverHbsLeadProspects(req.body||{});
    res.json({...discovered,content:leadPreviewText(discovered)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/import-approved',async(req,res)=>{
  try{
    const body=req.body||{};
    const discovered={
      market:String(body.market||'United States'),
      criteria:String(body.criteria||'Approved GOALL lead import'),
      organizationType:String(body.organizationType||'businesses'),
      employeeMinimum:donorValue(body.employeeMinimum)||300,
      tag:normalizeLeadTag(body.tag||body.organizationType),
      scraped:body.scraped||body.outscraper||{},
      leads:Array.isArray(body.leads)?body.leads:[]
    };
    if(!discovered.leads.length) throw new Error('No approved leads were provided for import.');
    const imported=await importApprovedHbsLeads(discovered);
    res.json({...discovered,...imported});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/rocketreach-enrich',async(req,res)=>{
  try{
    const body=req.body||{};
    const leads=Array.isArray(body.leads)?body.leads:[];
    if(!leads.length) throw new Error('No leads were provided for RocketReach enrichment.');
    const enriched=await mapWithConcurrency(leads,1,p=>enrichProspect(p,{rocketReachMode:'force'}));
    const discovered={
      ok:true,
      market:String(body.market||'United States'),
      criteria:String(body.criteria||'RocketReach enrichment'),
      organizationType:String(body.organizationType||'businesses'),
      employeeMinimum:donorValue(body.employeeMinimum)||300,
      tag:normalizeLeadTag(body.tag||body.organizationType),
      scraped:body.scraped||body.outscraper||{},
      rocketReachMode:'review',
      leads:enriched
    };
    res.json({...discovered,content:leadPreviewText(discovered)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/enrich-current',async(req,res)=>{
  try{
    const body=req.body||{};
    const exclude=(Array.isArray(body.exclude)?body.exclude:['aric','jessa']).map(v=>String(v).toLowerCase());
    const limit=leadLimitValue(body.limit);
    const d=await ghl('GET',`/opportunities/search?location_id=${GHL_LOC}&status=open&limit=100`);
    const leads=(d.opportunities||[])
      .map(leadContactSnapshot)
      .filter(l=>l.name && !exclude.some(x=>String(l.name+' '+l.contactName).toLowerCase().includes(x)))
      .slice(0,limit);
    if(!leads.length) return res.status(404).json({error:'No current GHL opportunities found to enrich.'});
    const system=[
      GOALL_LEADS_SYSTEM_PROMPT,
      'Current-lead enrichment mode: verify existing GHL lead data for business lead outreach.',
      'For each existing lead, verify or flag the best public phone, email/contact route, and actual likely decision-maker. Do not invent direct emails or phone numbers. If only a general contact channel is public, say that.',
      'Return a compact audit, grouped by lead. No preamble.'
    ].join('\n\n');
    const user=[
      'Audit these current GOALL business leads.',
      'Goal: check whether phone number, email/contact route, and actual decision-maker look correct.',
      'Exclude internal test contacts when obvious. Flag unclear or weak data.',
      '',
      JSON.stringify(leads,null,2),
      '',
      'For each lead return:',
      'Lead:',
      'Current GHL phone:',
      'Verified public phone:',
      'Current GHL email:',
      'Verified public email/contact route:',
      'Likely decision-maker:',
      'Decision-maker title:',
      'Decision-maker LinkedIn if public:',
      'What needs correction:',
      'Confidence:'
    ].join('\n');
    const content=await callOpenAIWebResearch({system,user,maxTokens:5000,temperature:0.15});
    if(!String(content||'').trim()) throw new Error('Current lead enrichment returned no content. Check OPENAI_KEY and whether the selected model supports web search.');
    await saveMemoryItem({
      kind:'goall_current_lead_enrichment',
      summary:`Enriched ${leads.length} current GOALL leads`,
      rawText:content,
      importance:3,
      metadata:{leadCount:leads.length,leads}
    }).catch(()=>{});
    res.json({ok:true,count:leads.length,leads,content});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/contacts/upsert',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts/upsert`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/contacts/${req.params.id}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/:id/notes',async(req,res)=>{
  try{res.json(await ghl('GET',`/contacts/${req.params.id}/notes`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/contacts/:id',async(req,res)=>{
  try{res.json(await ghl('PUT',`/contacts/${req.params.id}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/:id/tasks',async(req,res)=>{
  try{res.json(await ghl('GET',`/contacts/${req.params.id}/tasks`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/contacts/:id/tasks',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts/${req.params.id}/tasks`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/contacts/search',async(req,res)=>{
  try{
    const q=req.query.q||'';
    const d=await ghl('GET',`/contacts/?locationId=${GHL_LOC}&query=${encodeURIComponent(q)}&limit=5`);
    res.json({contacts:(d.contacts||[]).map(c=>({id:c.id,name:c.contactName||c.name||c.firstName+' '+c.lastName,email:c.email,phone:c.phone}))});
  }catch(e){res.status(500).json({error:e.message});}
});


app.post('/api/ghl/contacts/:id/tags',async(req,res)=>{
  try{res.json(await ghl('POST',`/contacts/${req.params.id}/tags`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/ghl/contacts/:id/tags',async(req,res)=>{
  try{res.json(await ghl('DELETE',`/contacts/${req.params.id}/tags`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 11-13. CONVERSATION TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/conversations',async(req,res)=>{
  try{
    const {limit=20,query,status}=req.query;
    let qs=`locationId=${GHL_LOC}&limit=${limit}`;
    if(query)qs+=`&query=${encodeURIComponent(query)}`;
    if(status)qs+=`&status=${status}`;
    res.json(await ghl('GET',`/conversations/search?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/conversations/:id/messages',async(req,res)=>{
  try{res.json(await ghl('GET',`/conversations/${req.params.id}/messages`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/conversations/:id/messages',async(req,res)=>{
  try{res.json(await ghl('POST',`/conversations/messages`,{...req.body,conversationId:req.params.id}));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 14-15. LOCATION TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/location',async(req,res)=>{
  try{res.json(await ghl('GET',`/locations/${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/location/custom-fields',async(req,res)=>{
  try{res.json(await ghl('GET',`/locations/${GHL_LOC}/customFields`));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 16-19. OPPORTUNITY TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/opportunities',async(req,res)=>{
  try{
    const {limit=20,query,status,pipelineId,stageId}=req.query;
    let qs=`location_id=${GHL_LOC}&limit=${limit}`;
    if(query)qs+=`&query=${encodeURIComponent(query)}`;
    if(status)qs+=`&status=${status}`;
    if(pipelineId)qs+=`&pipeline_id=${pipelineId}`;
    if(stageId)qs+=`&pipeline_stage_id=${stageId}`;
    res.json(await ghl('GET',`/opportunities/search?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/pipelines',async(req,res)=>{
  try{res.json(await ghl('GET',`/opportunities/pipelines?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/opportunities/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/opportunities/${req.params.id}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/opportunities/:id',async(req,res)=>{
  try{res.json(await ghl('PUT',`/opportunities/${req.params.id}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 20-21. PAYMENT TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/payments/orders/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/payments/orders/${req.params.id}?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/payments/transactions',async(req,res)=>{
  try{
    const {limit=20,startAt,endAt}=req.query;
    let qs=`locationId=${GHL_LOC}&limit=${limit}`;
    if(startAt)qs+=`&startAt=${startAt}`;
    if(endAt)qs+=`&endAt=${endAt}`;
    res.json(await ghl('GET',`/payments/transactions?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 22-28. BLOG TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/blogs',async(req,res)=>{
  try{res.json(await ghl('GET',`/blogs/?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/check-slug',async(req,res)=>{
  try{
    const {urlSlug,blogId,postId}=req.query;
    let qs=`locationId=${GHL_LOC}&urlSlug=${encodeURIComponent(urlSlug)}&blogId=${blogId}`;
    if(postId)qs+=`&postId=${postId}`;
    res.json(await ghl('GET',`/blogs/posts/url-slug-exists?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/authors',async(req,res)=>{
  try{res.json(await ghl('GET',`/blogs/authors?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/categories',async(req,res)=>{
  try{res.json(await ghl('GET',`/blogs/categories?locationId=${GHL_LOC}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/blogs/:blogId/posts',async(req,res)=>{
  try{
    const {limit=20,skip=0}=req.query;
    res.json(await ghl('GET',`/blogs/${req.params.blogId}/posts?locationId=${GHL_LOC}&limit=${limit}&skip=${skip}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/blogs/:blogId/posts',async(req,res)=>{
  try{res.json(await ghl('POST',`/blogs/${req.params.blogId}/posts`,{...req.body,locationId:GHL_LOC}));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/blogs/:blogId/posts/:postId',async(req,res)=>{
  try{res.json(await ghl('PUT',`/blogs/${req.params.blogId}/posts/${req.params.postId}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 29-30. EMAIL TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/emails/templates',async(req,res)=>{
  try{
    const {limit=20,skip=0}=req.query;
    res.json(await ghl('GET',`/emails/builder?locationId=${GHL_LOC}&limit=${limit}&skip=${skip}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/emails/templates',async(req,res)=>{
  try{res.json(await ghl('POST',`/emails/builder`,{...req.body,locationId:GHL_LOC}));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// 31-36. SOCIAL MEDIA TOOLS
// ════════════════════════════════════════════════════════

app.get('/api/ghl/social/accounts',async(req,res)=>{
  try{res.json(await ghl('GET',`/social-media-posting/oauth/${GHL_LOC}/accounts`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/social/statistics',async(req,res)=>{
  try{
    const {startDate,endDate,accountIds}=req.query;
    let qs=`locationId=${GHL_LOC}`;
    if(startDate)qs+=`&startDate=${startDate}`;
    if(endDate)qs+=`&endDate=${endDate}`;
    if(accountIds)qs+=`&accountIds=${accountIds}`;
    res.json(await ghl('GET',`/social-media-posting/statistics?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/social/posts',async(req,res)=>{
  try{
    const {limit=20,skip=0,status}=req.query;
    let qs=`limit=${limit}&skip=${skip}`;
    if(status)qs+=`&status=${status}`;
    res.json(await ghl('GET',`/social-media-posting/${GHL_LOC}/posts?${qs}`));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/ghl/social/posts',async(req,res)=>{
  try{res.json(await ghl('POST',`/social-media-posting/${GHL_LOC}/posts`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/ghl/social/posts/:id',async(req,res)=>{
  try{res.json(await ghl('GET',`/social-media-posting/${GHL_LOC}/posts/${req.params.id}`));}
  catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/ghl/social/posts/:id',async(req,res)=>{
  try{res.json(await ghl('PUT',`/social-media-posting/${GHL_LOC}/posts/${req.params.id}`,req.body));}
  catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════════════════
// VAL DURABLE STORE — tasks, memory, transcripts, files
// ════════════════════════════════════════════════════════
function readTasks(){ return readJson(TASKS_FILE,[]); }
function writeTasks(tasks){ writeJson(TASKS_FILE,tasks); }
function rowToTask(row){
  return {id:row.id,title:row.title,contactName:row.contact_name||'',dueDate:row.due_date?row.due_date.toISOString():null,notes:row.notes||'',details:row.details||[],completed:!!row.completed,createdAt:row.created_at?row.created_at.toISOString():new Date().toISOString()};
}
async function loadTasks(){
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select * from val_tasks where user_id=$1 order by completed asc, due_date asc nulls last, created_at desc',[VAL_USER_ID]);
    return r.rows.map(rowToTask);
  }
  return readTasks();
}
async function saveTask(task){
  await valDbReady;
  task.title=String(task.title||'Untitled task').trim()||'Untitled task';
  task.contactName=task.contactName||'';
  if(pgPool){
    if(!task.completed){
      const dupe=await dbQuery('select id,details from val_tasks where user_id=$1 and completed=false and lower(title)=lower($2) and lower(coalesce(contact_name,\'\'))=lower($3) limit 1',[VAL_USER_ID,task.title,task.contactName]);
      if(dupe.rows[0]&&dupe.rows[0].id!==task.id){
        task.id=dupe.rows[0].id;
        const existingDetails=Array.isArray(dupe.rows[0].details)?dupe.rows[0].details:[];
        task.details=existingDetails.concat(task.details||[]);
      }
    }
    await dbQuery(`
      insert into val_tasks (id,user_id,title,contact_name,due_date,notes,details,completed,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz,now()),now())
      on conflict (id) do update set title=excluded.title, contact_name=excluded.contact_name, due_date=excluded.due_date, notes=excluded.notes, details=excluded.details, completed=excluded.completed, updated_at=now()
    `,[task.id,VAL_USER_ID,task.title||'Untitled task',task.contactName||'',task.dueDate||null,task.notes||'',JSON.stringify(task.details||[]),!!task.completed,task.createdAt||null]);
    return;
  }
  const tasks=readTasks();
  const idx=tasks.findIndex(t=>t.id===task.id);
  if(idx>=0)tasks[idx]=task; else tasks.push(task);
  writeTasks(tasks);
}
async function replaceTasks(tasks){
  await valDbReady;
  if(pgPool){
    for(const task of tasks) await saveTask(task);
    return;
  }
  const existing=readTasks();
  const byId={};
  existing.concat(tasks).forEach(t=>{if(t&&t.id)byId[t.id]=t;});
  writeTasks(Object.keys(byId).map(id=>byId[id]));
}
async function deleteTask(id){
  await valDbReady;
  if(pgPool){ await dbQuery('delete from val_tasks where user_id=$1 and id=$2',[VAL_USER_ID,id]); return; }
  writeTasks(readTasks().filter(t=>t.id!==id));
}
app.get('/api/val/tasks',async(req,res)=>{try{res.json(await loadTasks());}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/tasks',async(req,res)=>{try{const task=req.body;if(!task||!task.id)return res.status(400).json({error:'Missing task id'});await saveTask(task);res.json({ok:true,task});}catch(e){res.status(500).json({error:e.message});}});
app.put('/api/val/tasks',async(req,res)=>{try{if(!Array.isArray(req.body))return res.status(400).json({error:'Expected array'});await replaceTasks(req.body);res.json({ok:true,count:req.body.length});}catch(e){res.status(500).json({error:e.message});}});
app.delete('/api/val/tasks/:id',async(req,res)=>{try{await deleteTask(req.params.id);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

async function saveMemoryItem(payload){
  await valDbReady;
  const id=payload.id||uuid('mem');
  const rawText=payload.rawText||payload.transcript||payload.summary||'';
  if(pgPool){
    await dbQuery('insert into val_memory_items (id,user_id,kind,summary,raw_text,importance,metadata,created_at) values ($1,$2,$3,$4,$5,$6,$7,now())',[id,VAL_USER_ID,payload.kind||payload.type||'note',payload.summary||null,rawText,payload.importance||1,JSON.stringify(payload.metadata||{})]);
  }else{
    const store=valStore();
    store.memoryItems.unshift({id,userId:VAL_USER_ID,kind:payload.kind||payload.type||'note',summary:payload.summary||'',rawText,importance:payload.importance||1,metadata:payload.metadata||{},createdAt:new Date().toISOString()});
    saveValStore(store);
  }
  return {id};
}
async function saveTranscript(payload){
  await valDbReady;
  const id=payload.id||uuid('tr');
  const type=payload.type||'transcript';
  const rawText=payload.transcript||payload.rawText||'';
  const metadata={...payload};
  delete metadata.transcript; delete metadata.rawText;
  if(pgPool){
    await dbQuery('insert into val_transcripts (id,user_id,type,title,raw_text,metadata,created_at) values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()))',[id,VAL_USER_ID,type,payload.title||null,rawText,JSON.stringify(metadata),payload.timestamp||null]);
  }else{
    const store=valStore();
    store.transcripts.unshift({id,userId:VAL_USER_ID,type,title:payload.title||'',rawText,metadata,createdAt:payload.timestamp||new Date().toISOString()});
    saveValStore(store);
  }
  if(rawText){
    const chunks=memoryChunks(rawText);
    for(let i=0;i<chunks.length;i++){
      await saveMemoryItem({kind:type,summary:chunks.length>1?`${payload.title||type} (${i+1}/${chunks.length})`:payload.title||type,rawText:chunks[i],metadata:{...metadata,transcriptId:id,chunkIndex:i+1,chunkCount:chunks.length},importance:payload.importance||1});
    }
  }
  return {id,type};
}
async function saveConversation(payload){
  await valDbReady;
  const id=payload.id||uuid('conv');
  const messages=Array.isArray(payload.messages)?payload.messages:[];
  const title=payload.title||(messages.find(m=>m.role==='user')?.content||'Conversation').slice(0,80);
  if(pgPool){
    await dbQuery(`insert into val_conversations (id,user_id,title,source,metadata,created_at,updated_at) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),now()) on conflict (id) do update set title=excluded.title, metadata=excluded.metadata, updated_at=now()`,[id,VAL_USER_ID,title,payload.source||payload.type||'chat',JSON.stringify(payload.metadata||{}),payload.timestamp||null]);
    await dbQuery('delete from val_messages where conversation_id=$1',[id]);
    for(const m of messages) await dbQuery('insert into val_messages (id,conversation_id,role,content,metadata,created_at) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()))',[uuid('msg'),id,m.role||'user',m.content||'',JSON.stringify(m.metadata||{}),m.timestamp||null]);
  }else{
    const store=valStore();
    store.conversations=store.conversations.filter(c=>c.id!==id);
    store.messages=store.messages.filter(m=>m.conversationId!==id);
    store.conversations.unshift({id,userId:VAL_USER_ID,title,source:payload.source||payload.type||'chat',metadata:payload.metadata||{},createdAt:payload.timestamp||new Date().toISOString(),updatedAt:new Date().toISOString()});
    messages.forEach(m=>store.messages.push({id:uuid('msg'),conversationId:id,role:m.role||'user',content:m.content||'',metadata:m.metadata||{},createdAt:m.timestamp||new Date().toISOString()}));
    saveValStore(store);
  }
  if(payload.transcript){
    const transcriptPayload={...payload,conversationId:id,title,type:payload.type||'chat_memory'};
    delete transcriptPayload.id;
    await saveTranscript(transcriptPayload);
  }
  return {id,title,count:messages.length};
}
async function recentMemoryContext(query){
  await valDbReady;
  const terms=queryTerms(query);
  const documentMode=isDocumentMemoryQuery(query);
  const format=items=>items.map(m=>`- [${m.kind}] ${(m.summary||m.raw_text||m.rawText||'').slice(0,140)}${(m.raw_text||m.rawText)&&((m.raw_text||m.rawText)!==m.summary)?': '+(m.raw_text||m.rawText).slice(0,documentMode?1200:650):''}`).join('\n');
  const metaOf=m=>typeof m.metadata==='string'?(()=>{try{return JSON.parse(m.metadata);}catch(e){return {};}})():(m.metadata||{});
  const uniqueByContent=items=>{const seen=new Set();return items.filter(m=>{const key=`${m.kind||''}|${m.summary||''}|${(m.raw_text||m.rawText||'').slice(0,80)}`;if(seen.has(key))return false;seen.add(key);return true;});};
  const recentDocumentPinned=items=>{
    if(!documentMode)return [];
    return items.filter(m=>/knowledge_document|processed_transcript|transcript/i.test(m.kind||'')).sort((a,b)=>{
      const ad=new Date(a.created_at||a.createdAt||0).getTime(),bd=new Date(b.created_at||b.createdAt||0).getTime();
      const am=metaOf(a),bm=metaOf(b);
      return (bd-ad)||(Number(am.chunkIndex||0)-Number(bm.chunkIndex||0));
    }).slice(0,10);
  };
  if(pgPool){
    const r=await dbQuery('select kind,summary,raw_text,importance,metadata,created_at from val_memory_items where user_id=$1 order by created_at desc limit 1200',[VAL_USER_ID]);
    const ranked=r.rows.map(m=>({...m,_score:scoreMemory(m,terms)})).sort((a,b)=>(b._score-a._score)||((b.importance||1)-(a.importance||1))).slice(0,documentMode?18:12);
    return format(uniqueByContent(recentDocumentPinned(r.rows).concat(ranked)).slice(0,documentMode?22:12));
  }
  const storeItems=valStore().memoryItems;
  const ranked=storeItems.map(m=>({...m,_score:scoreMemory(m,terms)})).sort((a,b)=>(b._score-a._score)||((b.importance||1)-(a.importance||1))).slice(0,documentMode?18:12);
  return format(uniqueByContent(recentDocumentPinned(storeItems).concat(ranked)).slice(0,documentMode?22:12));
}

function noteBody(note){
  if(!note)return '';
  const text=String(note.body||note.note||note.text||note.content||note.message||note.description||'').replace(/\s+/g,' ').trim();
  if(!text)return '';
  const ts=note.dateAdded||note.date_added||note.createdAt||note.created_at||note.updatedAt||note.updated_at;
  if(!ts)return text;
  const d=new Date(ts);
  const stamp=isNaN(d.getTime())?'':d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  return stamp ? `${stamp}: ${text}` : text;
}
function normalizeNotesPayload(data){
  const raw=data?.notes||data?.data||data?.contactNotes||data?.contact_notes||data?.items||[];
  return Array.isArray(raw)?raw:[];
}
async function fetchContactNotes(contactId,limit=25){
  if(!contactId)return [];
  const encoded=encodeURIComponent(contactId);
  const paths=[
    `/contacts/${encoded}/notes`,
    `/contacts/${encoded}/notes?locationId=${encodeURIComponent(GHL_LOC)}`,
    `/contacts/notes?contactId=${encoded}&locationId=${encodeURIComponent(GHL_LOC)}`
  ];
  for(const path of paths){
    const r=await ghlTry('GET',path);
    const notes=normalizeNotesPayload(r.data).map(noteBody).filter(Boolean);
    if(r.ok&&notes.length)return notes.slice(0,limit);
  }
  return [];
}
function contactDisplayName(contact){
  const c=contact?.contact||contact||{};
  return c.contactName||c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')||c.email||c.phone||'Unknown contact';
}
function likelyContactQueries(text){
  const raw=String(text||'');
  const emails=raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[];
  const phones=raw.match(/\+?\d[\d\s().-]{7,}\d/g)||[];
  const quoted=[...raw.matchAll(/["']([^"']{3,80})["']/g)].map(m=>m[1]);
  const names=[...raw.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)].map(m=>m[1]).filter(v=>!/VAL|GOALL|GHL|CRM|Make|Zoom|Google|Mark Bierman/.test(v));
  return Array.from(new Set(emails.concat(phones,quoted,names,raw.slice(0,90)).map(v=>String(v).trim()).filter(v=>v.length>=3))).slice(0,6);
}
function collectContactIdsFromDashboard(dashboard){
  const ids=new Set();
  const walk=(value)=>{
    if(!value||ids.size>=8)return;
    if(Array.isArray(value)){value.forEach(walk);return;}
    if(typeof value==='object'){
      const id=value.contactId||value.contact_id||value.contact?.id;
      if(id)ids.add(String(id));
      Object.keys(value).slice(0,40).forEach(k=>walk(value[k]));
    }
  };
  walk(dashboard);
  return Array.from(ids).slice(0,8);
}
async function getContactNotesContextForId(contactId){
  try{
    const [contactData,notes]=await Promise.all([
      ghl('GET',`/contacts/${contactId}`).catch(()=>({})),
      fetchContactNotes(contactId,30)
    ]);
    const contact=contactData.contact||contactData;
    if(!notes.length)return '';
    return `Contact: ${contactDisplayName(contact)}${contact.email?' | '+contact.email:''}${contact.phone?' | '+contact.phone:''}\nGHL notes and call transcript history:\n- ${notes.join('\n- ')}`;
  }catch(e){return '';}
}
async function ghlContactNotesContext(query,dashboard){
  if(!GHL_KEY||!GHL_LOC)return '';
  const sections=[];
  const seenIds=new Set();
  for(const id of collectContactIdsFromDashboard(dashboard||{})){
    if(seenIds.has(id))continue;
    seenIds.add(id);
    const ctx=await getContactNotesContextForId(id);
    if(ctx)sections.push(ctx);
  }
  for(const q of likelyContactQueries(query)){
    if(sections.length>=8)break;
    try{
      const d=await ghl('GET',`/contacts/?locationId=${GHL_LOC}&query=${encodeURIComponent(q)}&limit=3`);
      for(const c of (d.contacts||[])){
        const id=c.id||c.contactId;
        if(!id||seenIds.has(String(id)))continue;
        seenIds.add(String(id));
        const ctx=await getContactNotesContextForId(id);
        if(ctx)sections.push(ctx);
        if(sections.length>=8)break;
      }
    }catch(e){}
  }
  return sections.length ? sections.join('\n\n') : '';
}
async function callValModel({system,user,maxTokens=1200,temperature=0.4,json=false}){
  return callOpenAIResponses({system,messages:[{role:'user',content:user}],maxTokens,temperature,json});
}
function cleanTaskTitle(title){ return String(title||'').replace(/\s+/g,' ').trim(); }
function taskFingerprint(title,contactName){ return [cleanTaskTitle(title).toLowerCase(),String(contactName||'').trim().toLowerCase()].join('|'); }
function validDueDate(value){ if(!value)return null; const d=new Date(value); return isNaN(d.getTime())?null:d.toISOString(); }
function transcriptTaskFromItem(item,title,sourceId,kind){
  const taskTitle=cleanTaskTitle(item.title||item.task||item.action||item.nextAction);
  if(!taskTitle)return null;
  const contactName=item.contactName||item.person||item.who||item.for||item.owner||'';
  const notes=[item.notes||item.context||item.reason||'',item.priority?'Priority: '+item.priority:'',item.evidence?'Evidence: '+item.evidence:''].filter(Boolean).join('\n');
  return {id:uuid('task'),title:taskTitle,contactName,dueDate:validDueDate(item.dueDate||item.due||item.deadline),notes,details:[{text:'Created from transcript: '+title,ts:new Date().toISOString()},{text:'Source: '+(sourceId||title),ts:new Date().toISOString()},{text:'Kind: '+(kind||'commitment'),ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
}

const HUMAN_VOICE_RULES = `
Voice rules for every response:
Write like a real operator talking to another real person.
Do not use em dashes.
Do not use polished AI language, corporate filler, fake enthusiasm, or motivational-speaker energy.
Avoid phrases like "it's important to note", "in conclusion", "delve", "robust", "seamless", "transformative", "utilize", "unlock", "game-changing", "next-level", "dive into", and "elevate".
Do not over-explain. Leave obvious things alone.
Use plain words. Keep some edges.
Vary rhythm. Some sentences can be short. Some can be a little uneven.
Use bullets only when they help the user scan something operational.
Never sound like customer support. Never pad the ending.
If a sentence sounds polished just to sound smart, rewrite it.
`.trim();

function responseText(payload){
  if(payload.output_text) return payload.output_text;
  const parts = [];
  for(const item of payload.output||[]){
    for(const content of item.content||[]){
      if(content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

async function callOpenAIResponses({system,messages,maxTokens=1200,temperature=0.4,json=false}){
  if(!OPENAI_KEY) throw new Error('OPENAI_KEY not configured');
  const body = {
    model:OPENAI_CHAT_MODEL,
    instructions:[system,HUMAN_VOICE_RULES].filter(Boolean).join('\n\n'),
    input:messages.map(m=>({
      role:m.role === 'assistant' ? 'assistant' : 'user',
      content:String(m.content||'')
    })),
    max_output_tokens:maxTokens,
    temperature
  };
  if(json) body.text = {format:{type:'json_object'}};
  let r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
    body:JSON.stringify(body)
  });
  let d=await r.json();
  if(d.error && /temperature/i.test(d.error.message||'')){
    delete body.temperature;
    r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
      body:JSON.stringify(body)
    });
    d=await r.json();
  }
  if(d.error) throw new Error(d.error.message);
  return responseText(d);
}

async function callOpenAIWebResearch({system,user,maxTokens=2200,temperature=0.1}){
  if(!OPENAI_KEY) throw new Error('OPENAI_KEY not configured');
  const body = {
    model: OPENAI_CHAT_MODEL,
    input: [
      {role:'system',content:system},
      {role:'user',content:user}
    ],
    tools: [{type:'web_search_preview'}],
    max_output_tokens: maxTokens,
    temperature
  };
  let r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
    body:JSON.stringify(body)
  });
  let d=await r.json();
  if(d.error && /temperature/i.test(d.error.message||'')){
    delete body.temperature;
    r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_KEY}`},
      body:JSON.stringify(body)
    });
    d=await r.json();
  }
  if(d.error) throw new Error(d.error.message);
  return responseText(d);
}

const GOALL_LEADS_SYSTEM_PROMPT = `
You are Leads MCP GOALL, a focused lead generation and growth strategy specialist for the GOALL Agency.

Help users identify target markets, define ideal customer profiles, build prospecting systems, create outreach strategies, qualify leads, improve conversion rates, and develop repeatable pipeline growth processes.

Provide practical, results-oriented support for outbound campaigns, inbound lead capture, messaging, follow-up sequences, CRM organization, lead scoring, sales funnel optimization, and performance tracking.

When advising users, prioritize clarity, efficiency, and measurable outcomes. Ask smart discovery questions when needed, recommend actionable next steps, and tailor strategies to the user's industry, offer, audience, and growth stage.

Primary lead target:
- Employers
- Businesses
- Companies with employee bases
- Organizations with operational complexity
- Businesses showing hiring, growth, expansion, or activity signals
- Decision-makers such as founders, owners, CEOs, operations leaders, HR leaders, benefits leaders, sales leaders, and partnership leaders

CORE ROLE
You are a lead intelligence scraper and data structuring agent for GOALL.

Your job:
- Search for company data across public sources
- Extract only relevant, verifiable information
- Normalize the data into structured CRM fields
- Reject or flag weak, unclear, or low-confidence data

You are not allowed to guess, fill gaps with assumptions, add commentary or opinions, or output messy/unstructured text.
If data cannot be verified, leave the field empty or mark it as "unclear".

PRIMARY OBJECTIVE
For each lead, collect and structure:
1. Company identity and operational context
2. Employee size indicators
3. Signals of hiring, growth, or activity
4. Public presence: website, LinkedIn, Google
5. Indicators of operational complexity
6. Best available decision-maker contact path

SEARCH PROCESS - follow in order:
1. Search company name + city/state
2. Identify official website
3. Extract core company data
4. Search LinkedIn company page
5. Search LinkedIn people / likely decision-makers
6. Check Google Business
7. Scan for news, hiring, activity, expansion, funding, operations, and growth signals
8. Compile structured outputs

Source priority:
1. Official website
2. LinkedIn company page
3. Google Business listing
4. News / press mentions
5. Secondary directories

Accuracy rules:
- Only include information that is directly observed, clearly stated, or strongly supported by multiple signals.
- Never invent employee counts, services, locations, contact info, decision-makers, or company descriptions.
- If exact employee count is unavailable, estimate only from supported signals such as LinkedIn employee range, job postings, team pages, or public staff count.
- Otherwise write "unclear".

Operational complexity signals:
Look for signs such as multiple locations, field teams, dispatch, service crews, employee benefits needs, hiring activity, sales teams, customer support teams, logistics, franchises, branch locations, certifications, recruiting pages, or high-volume customer operations.

Disqualifying or weak signals:
If you detect solo operator, no real business presence, broken/missing website, no employee signals, generic/fake listing, or weak public footprint, still collect data but clearly reflect weak signals.

OUTPUT FORMAT STRICT:
Return exactly these field labels and nothing else:

company_payload:
Company Name:
Industry:
Primary Service:
Business Model (if clear):
Location(s):
Website Status (active / weak / missing):

company_google_raw:
Google Business summary:
Reviews count:
Rating:
Description snippet:
If none: No Google data found

company_signals_raw:
- Hiring activity:
- Careers page:
- Team size indicators:
- Multiple locations:
- Operational indicators:
- Growth/activity signals:
- Weak-fit concerns:

company_news_raw:
[structured content]

linkedin_personal_url:
[most likely decision-maker URL or blank]

linkedin_company_url:
[company LinkedIn URL or fallback text]
`.trim();

function parseLeadFieldOutputs(text){
  const fields=['company_payload','company_google_raw','company_signals_raw','company_news_raw','linkedin_personal_url','linkedin_company_url'];
  const out={};
  fields.forEach((field,idx)=>{
    const next=fields[idx+1];
    const pattern=next
      ? new RegExp(`${field}:\\s*([\\s\\S]*?)(?=\\n${next}:)`, 'i')
      : new RegExp(`${field}:\\s*([\\s\\S]*)$`, 'i');
    const match=String(text||'').match(pattern);
    out[field]=match ? match[1].trim() : '';
  });
  return out;
}

async function updateGhlLeadFields(contactId,fields){
  const ids = await resolveLeadFieldIds().catch(()=>GHL_LEAD_FIELD_IDS);
  const customFields = Object.entries(ids)
    .filter(([key,id])=>id && Object.prototype.hasOwnProperty.call(fields,key))
    .map(([key,id])=>({id,field_value:fields[key]||''}));
  if(!contactId || !customFields.length) return {updated:false, reason:contactId?'No lead custom field IDs configured':'No contactId provided'};
  const data=await ghl('PUT',`/contacts/${contactId}`,{customFields});
  return {updated:true, contact:data.contact||data, fieldsUpdated:customFields.length};
}

let leadFieldIdCache=null;
async function resolveLeadFieldIds(){
  if(leadFieldIdCache) return leadFieldIdCache;
  const resolved={...GHL_LEAD_FIELD_IDS};
  const missing=Object.entries(resolved).filter(([,id])=>!id);
  if(missing.length){
    const data=await ghl('GET',`/locations/${GHL_LOC}/customFields`);
    const fields=data.customFields||data.fields||data.data||[];
    for(const [key] of missing){
      const wantedKey=GHL_LEAD_FIELD_KEYS[key];
      const wantedName=key.replace(/_/g,' ').toLowerCase();
      const found=fields.find(f=>{
        const fieldKey=String(f.fieldKey||f.key||f.field_key||'').toLowerCase();
        const name=String(f.name||f.fieldName||'').toLowerCase();
        return fieldKey===wantedKey || fieldKey.endsWith('.'+key) || name===wantedName;
      });
      if(found) resolved[key]=found.id||found._id||found.fieldId||'';
    }
  }
  leadFieldIdCache=resolved;
  return resolved;
}

function normalizeLeadTag(value){
  const raw=String(value||'').toLowerCase();
  if(/\broof|hvac|plumb|electric|contractor|home service\b/.test(raw)) return 'home services';
  if(/\bdental|clinic|medical|health|wellness\b/.test(raw)) return 'healthcare';
  if(/\bmanufactur|industrial|warehouse|logistics\b/.test(raw)) return 'manufacturing';
  if(/\brestaurant|hotel|hospitality|catering\b/.test(raw)) return 'hospitality';
  if(/\bfranchise|multi.location|multi location|chain\b/.test(raw)) return 'multi-location';
  if(/\bagenc|marketing|consulting|professional service\b/.test(raw)) return 'professional services';
  return raw.trim() || 'business';
}

function leadNameFromOpportunity(o={}){
  return o.contact?.companyName || o.contact?.businessName || o.companyName || o.businessName || o.contact?.name || o.contactName || o.name || '';
}

function leadContactSnapshot(o={}){
  return {
    opportunityId:o.id||'',
    contactId:o.contact?.id||o.contactId||'',
    name:leadNameFromOpportunity(o),
    contactName:o.contact?.name||o.contactName||'',
    email:o.contact?.email||o.email||'',
    phone:o.contact?.phone||o.phone||'',
    owner:inferValOwner(o),
    stage:o.pipelineStage?.name||o.stage?.name||o.stageName||o.pipelineStage||'',
    value:o.monetaryValue||o.value||''
  };
}

function extractJsonArray(text){
  const raw=String(text||'').trim();
  try{
    const parsed=JSON.parse(raw);
    if(Array.isArray(parsed)) return parsed;
    if(Array.isArray(parsed.leads)) return parsed.leads;
    if(Array.isArray(parsed.prospects)) return parsed.prospects;
  }catch(_){}
  const match=raw.match(/\[[\s\S]*\]/);
  if(!match) return [];
  try{return JSON.parse(match[0]);}catch(_){return [];}
}

function donorValue(v){
  const n=Number(String(v||'').replace(/[^0-9.]/g,''));
  if(!Number.isFinite(n)||n<=0) return 0;
  return Math.round(n);
}

function leadLimitValue(v){
  const n=Number(String(v||'').replace(/[^0-9]/g,''));
  if(!Number.isFinite(n)||n<=0) return 12;
  return Math.min(Math.round(n), GOALL_LEAD_SEARCH_MAX);
}

function normalizeCountryCode(value){
  const raw=String(value||'').trim();
  if(!raw) return undefined;
  const lower=raw.toLowerCase();
  const map={
    'united states':'US',
    'united states of america':'US',
    'usa':'US',
    'us':'US',
    'canada':'CA',
    'ca':'CA',
    'united kingdom':'GB',
    'uk':'GB',
    'great britain':'GB',
    'australia':'AU'
  };
  if(map[lower]) return map[lower];
  if(/^[A-Z]{2}$/.test(raw)) return raw;
  return undefined;
}

function leadCustomFieldsFromProspect(p){
  const name=p.organizationName||p.name||'';
  const donorCount=donorValue(p.approximateDonors||p.estimatedDonors||p.donorCount);
  const enrichment=[
    `Decision maker: ${p.decisionMakerName||'unclear'}`,
    `Title: ${p.decisionMakerTitle||'unclear'}`,
    `Email source: ${p.emailSource||'unclear'} (${p.emailQuality||classifyEmail(p.email)})`,
    `RocketReach: ${p.rocketReachStatus||p.rocketReach?.error||p.rocketReach?.data?.rawPreview||'not available'}`,
    `Employee estimate basis: ${p.donorEstimateBasis||p.employeeEstimateBasis||'unclear'}`,
    `Next outreach angle: ${p.nextOutreachAngle||'unclear'}`,
    `Confidence: ${p.confidence||'unclear'}`
  ].join('\n');
  return {
    company_payload:[
      `Company: ${name}`,
      `Type: ${p.organizationType||p.industry||'business'}`,
      `Industry: ${p.cause||p.industry||p.primaryService||'unclear'}`,
      `Fit: ${p.partnerFit||p.likelihood||'unclear'}`,
      `Employees: ${donorCount||'unclear'}`,
      `Location: ${p.location||'unclear'}`,
      `Website: ${p.website?'active':'unclear'}`
    ].join(' | '),
    google_raw:p.googleRaw||p.googleData||'No Google data found',
    company_signals:[
      `Hiring activity: ${p.hiringActivity||p.careersPage||p.donationPage||'unclear'}`,
      `Employee size indicators: ${Array.isArray(p.evidenceSignals)?p.evidenceSignals.join('; '):(p.evidenceSignals||p.donorEstimateBasis||'unclear')}`,
      `Growth activity: ${p.growthActivity||p.fundraisingActivity||'unclear'}`,
      `Operational activity: ${p.operationalActivity||p.eventsOrCampaigns||'unclear'}`,
      `Decision-maker signals: ${p.decisionMakerTitle||p.developmentStaff||'unclear'}`,
      `Public activity: ${p.socialActivity||'unclear'}`,
      `Operational indicators: ${p.operationalIndicators||'unclear'}`,
      `Weak-fit concerns: ${p.weakFitConcerns||'unclear'}`
    ].join('\n'),
    enrichment_data:enrichment,
    approximat_donor_count:donorCount?String(donorCount):'unclear',
    linkedin_personal:p.linkedinPersonalUrl||p.decisionMakerLinkedIn||'',
    linkedin_company:p.linkedinCompanyUrl||p.linkedinOrganizationUrl||'',
    hours_of_operation:p.hoursOfOperation||p.hours||'',
    time_zone:p.timeZone||p.timezone||''
  };
}

async function getOpportunityTarget(){
  if(GHL_OPPORTUNITY_PIPELINE_ID&&GHL_OPPORTUNITY_STAGE_ID) return {pipelineId:GHL_OPPORTUNITY_PIPELINE_ID,stageId:GHL_OPPORTUNITY_STAGE_ID};
  const data=await ghl('GET',`/opportunities/pipelines?locationId=${GHL_LOC}`);
  const pipelines=data.pipelines||data.data||[];
  const wantPipeline=String(GHL_OPPORTUNITY_PIPELINE_NAME||'').toLowerCase();
  const wantStage=String(GHL_OPPORTUNITY_STAGE_NAME||'').toLowerCase();
  const pipeline=pipelines.find(p=>{
    const name=String(p.name||p.title||'').toLowerCase();
    return wantPipeline && (name===wantPipeline || name.includes(wantPipeline));
  }) || pipelines[0] || {};
  const stages=pipeline.stages||pipeline.pipelineStages||[];
  const stage=stages.find(s=>{
    const name=String(s.name||s.title||'').toLowerCase();
    return wantStage && name===wantStage;
  }) || stages.find(s=>{
    const name=String(s.name||s.title||'').toLowerCase();
    return wantStage && name.includes(wantStage);
  }) || stages[0] || {};
  if(!pipeline.id||!stage.id) throw new Error(`No GHL opportunity pipeline/stage found for ${GHL_OPPORTUNITY_PIPELINE_NAME} / ${GHL_OPPORTUNITY_STAGE_NAME}. Set GHL_OPPORTUNITY_PIPELINE_ID and GHL_OPPORTUNITY_STAGE_ID in Railway.`);
  return {pipelineId:pipeline.id,stageId:stage.id,pipelineName:pipeline.name||pipeline.title||'',stageName:stage.name||stage.title||''};
}

function normalizeOutscraperPlace(row,organizationType,employeeMinimum,market){
  const name=row.name||row.title||row.business_name||row.organizationName||'';
  const city=[row.city,row.state].filter(Boolean).join(', ') || row.full_address || row.address || market || '';
  const employeeSignals=[
    row.description,
    row.category,
    row.subtypes,
    row.reviews ? `${row.reviews} Google reviews` : '',
    row.rating ? `${row.rating} rating` : '',
    row.website ? 'active website' : '',
    row.posts ? 'Google posts visible' : ''
  ].flat().filter(Boolean);
  return {
    organizationName:name,
    website:row.site||row.website||row.url||'',
    address1:row.street||row.address||row.full_address||'',
    city:row.city||'',
    state:row.state||row.us_state||'',
    country:row.country||'',
    postalCode:row.postal_code||row.zip||row.zipcode||'',
    cause:organizationType,
    location:city,
    organizationType,
    partnerFit:'unclear',
    approximateDonors:donorValue(row.approximateDonors)||employeeMinimum||0,
    donorEstimateBasis:employeeSignals.join('; ') || 'Outscraper public listing signals',
    employeeEstimateBasis:employeeSignals.join('; ') || 'Outscraper public listing signals',
    evidenceSignals:employeeSignals,
    decisionMakerName:'',
    decisionMakerTitle:'',
    email:firstEmailFrom(row.email,row.emails,row.email_1,row.email_2,row.email_3,row.contacts,row.owner,row.about,row.description,row),
    phone:row.phone||row.phone_number||row.phoneNumber||'',
    linkedinPersonalUrl:'',
    linkedinCompanyUrl:row.linkedin||row.linkedin_url||'',
    donationPage:'',
    fundraisingActivity:'',
    hiringActivity:'',
    careersPage:'',
    growthActivity:'',
    eventsOrCampaigns:'',
    socialActivity:row.facebook||row.instagram||row.twitter ? [row.facebook,row.instagram,row.twitter].filter(Boolean).join('; ') : '',
    operationalIndicators:row.category||row.type||'',
    weakFitConcerns:'',
    googleRaw:JSON.stringify(row).slice(0,2200),
    newsRaw:'No recent news found',
    hoursOfOperation:row.working_hours||row.hours||'',
    timeZone:row.timezone||'',
    nextOutreachAngle:'Invite them to explore whether GOALL Agency can support their growth, outreach, or pipeline goals.',
    confidence:name?'moderate':'weak'
  };
}

async function discoverOutscraperProspects({organizationType,employeeMinimum,market,limit}){
  if(!OUTSCRAPER_API_KEY) return {configured:false, leads:[], error:'OUTSCRAPER_API_KEY is not set'};
  const url=new URL(OUTSCRAPER_GOOGLE_MAPS_SEARCH_URL);
  url.searchParams.set('query',`${organizationType} businesses in ${market}`);
  url.searchParams.set('limit',String(limit||12));
  url.searchParams.set('async','false');
  const response=await fetch(url.toString(),{headers:{'X-API-KEY':OUTSCRAPER_API_KEY}});
  const data=await readJsonResponse(response);
  if(!response.ok) return {configured:true, leads:[], error:data.errorMessage||data.message||`Outscraper ${response.status}`};
  const rows=(Array.isArray(data.data)?data.data:[data]).flat(4).filter(v=>v&&typeof v==='object');
  const leads=rows.map(r=>normalizeOutscraperPlace(r,organizationType,employeeMinimum,market))
    .filter(p=>p.organizationName)
    .slice(0,limit||12);
  return {configured:true, leads, rawCount:rows.length};
}

async function fetchTextWithTimeout(url,timeoutMs=3500){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response = await fetch(url,{signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 VAL lead research'}});
    if(!response.ok) return '';
    const type=response.headers.get('content-type')||'';
    if(type && !/text|html|json/i.test(type)) return '';
    return (await response.text()).slice(0,250000);
  }catch(_){
    return '';
  }finally{
    clearTimeout(timer);
  }
}

function candidateContactUrls(website){
  if(!website) return [];
  try{
    const base = new URL(website);
    const origin = base.origin;
    return [...new Set([
      base.href,
      new URL('/contact',origin).href,
      new URL('/contact-us',origin).href,
      new URL('/about',origin).href,
      new URL('/about-us',origin).href,
      new URL('/team',origin).href,
      new URL('/staff',origin).href,
      new URL('/leadership',origin).href,
      new URL('/careers',origin).href,
      new URL('/jobs',origin).href,
      new URL('/services',origin).href,
      new URL('/locations',origin).href,
      new URL('/people',origin).href,
      new URL('/who-we-are',origin).href
    ])];
  }catch(_){
    return [];
  }
}

function bestEmail(candidates){
  const unique=[...new Map(candidates.filter(c=>c.email).map(c=>[c.email.toLowerCase(),{...c,email:c.email.toLowerCase(),quality:classifyEmail(c.email)}])).values()];
  const score={person:4,'high-value role':3,general:2,missing:0};
  unique.sort((a,b)=>(score[b.quality]||0)-(score[a.quality]||0));
  return unique[0]||{email:'',source:'',quality:'missing'};
}

function extractLeadership(text){
  const clean=String(text||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const titles='Chief Executive Officer|CEO|Founder|Owner|President|Operations Manager|Director of Operations|Chief Operating Officer|COO|HR Director|Human Resources Director|Benefits Manager|Sales Director|VP Sales|Partnerships Director|General Manager';
  const titleFirst=new RegExp(`\\b(${titles})\\b\\s*[:\\-–]?\\s*([A-Z][A-Za-z.'’\\-]+(?:\\s+[A-Z][A-Za-z.'’\\-]+){1,3})`,'i');
  const nameFirst=new RegExp(`\\b([A-Z][A-Za-z.'’\\-]+(?:\\s+[A-Z][A-Za-z.'’\\-]+){1,3})\\s*[,\\-–|]+\\s*(${titles})\\b`,'i');
  let m=clean.match(titleFirst);
  if(m) return {name:m[2].trim(),title:m[1].trim()};
  m=clean.match(nameFirst);
  if(m) return {name:m[1].trim(),title:m[2].trim()};
  return {name:'',title:''};
}

async function findPublicWebsiteContactData(website){
  const urls = candidateContactUrls(website);
  const emails=[];
  let leader={name:'',title:''};
  for(const url of urls){
    const text = await fetchTextWithTimeout(url);
    extractEmailsFromValue(text).forEach(email=>emails.push({email,source:url}));
    if(!leader.name){
      const found=extractLeadership(text);
      if(found.name) leader={...found,source:url};
    }
    const currentBest=bestEmail(emails);
    if(currentBest.quality==='person' && leader.name) break;
  }
  return {...bestEmail(emails),leader};
}

async function findPublicWebsiteEmail(website){
  const data=await findPublicWebsiteContactData(website);
  return {email:data.email,source:data.source,quality:data.quality};
}

async function mapWithConcurrency(items,limit,fn){
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({length:Math.min(limit,items.length)},async()=>{
    while(index<items.length){
      const current = index++;
      out[current] = await fn(items[current],current);
    }
  });
  await Promise.all(workers);
  return out;
}

async function discoverHbsLeadProspects(body={}){
  const market=String(body.market||body.location||body.cityState||'').trim()||'United States';
  const organizationType=String(body.organizationType||body.type||'businesses').trim();
  const employeeMinimum=donorValue(body.employeeMinimum||body.minimumEmployees||body.employees)||300;
  const tag=normalizeLeadTag(body.tag||organizationType);
  const criteria=String(body.criteria||body.query||`${organizationType} with at least ${employeeMinimum} employees`).trim();
  const limit=leadLimitValue(body.limit);
  const rocketReachMode=String(body.rocketReachMode||body.rocketreachMode||'').trim() || (limit<=25?'auto':'defer');
  const scraped=await discoverOutscraperProspects({organizationType,employeeMinimum,market,limit}).catch(e=>({configured:!!OUTSCRAPER_API_KEY,leads:[],error:e.message}));
  if(!scraped.configured) throw new Error(scraped.error || 'Outscraper is not configured');
  let leads=scraped.leads||[];
  if(leads.length){
    leads=await mapWithConcurrency(leads,5,p=>enrichProspect(p,{rocketReachMode}));
  }
  let raw='';
  if(!leads.length){
    const system=[
      GOALL_LEADS_SYSTEM_PROMPT,
      'Discovery mode: find potential GOALL business leads and return machine-readable JSON only.',
      'Find companies with visible evidence of employee size, hiring, growth, operational complexity, and reachable decision-makers.',
      'Do not invent exact employee counts. approximateDonors is being used as the legacy numeric field for approximate employees and must be a conservative integer estimate from public signals.',
      'Return ONLY valid JSON. No markdown. No commentary.'
    ].join('\n\n');
    const user=[
      `Find ${limit} business prospects for GOALL.`,
      `Market: ${market}`,
      `Organization type: ${organizationType}`,
      `Minimum employees: ${employeeMinimum}`,
      `Criteria: ${criteria}`,
      '',
      'Return JSON with this exact shape:',
      '{"leads":[{"organizationName":"","website":"","industry":"","primaryService":"","location":"","organizationType":"","partnerFit":"","approximateDonors":0,"donorEstimateBasis":"","evidenceSignals":[""],"decisionMakerName":"","decisionMakerTitle":"","email":"","phone":"","linkedinPersonalUrl":"","linkedinCompanyUrl":"","hiringActivity":"","careersPage":"","growthActivity":"","operationalActivity":"","socialActivity":"","operationalIndicators":"","weakFitConcerns":"","googleRaw":"","newsRaw":"","nextOutreachAngle":"","confidence":""}]}'
    ].join('\n');
    raw=await callOpenAIWebResearch({system,user,maxTokens:6000,temperature:0.15});
    leads=extractJsonArray(raw).slice(0,limit);
    leads=await mapWithConcurrency(leads,5,p=>enrichProspect({...p,organizationType:p.organizationType||organizationType,approximateDonors:p.approximateDonors||employeeMinimum},{rocketReachMode}));
  }
  if(!leads.length) throw new Error('No leads were found. Try a more specific organization type or market.');
  return {ok:true,market,criteria,organizationType,employeeMinimum,tag,leads,scraped,raw,rocketReachMode};
}

function leadPreviewText(discovered){
  const leads=discovered.leads||[];
  return [
    `Found and enriched ${leads.length} organization${leads.length===1?'':'s'}.`,
    `Search: ${discovered.organizationType} | ${discovered.employeeMinimum}+ employees | ${discovered.market}`,
    `Recommended tag: ${discovered.tag}`,
    discovered.rocketReachMode==='defer'?'RocketReach: deferred for this broad scrape. Use it after review on the leads that need person-level verification.':'',
    discovered.scraped?.error?`Outscraper note: ${discovered.scraped.error}`:'',
    '',
    leads.map((p,i)=>{
      const donorCount=donorValue(p.approximateDonors||p.estimatedDonors||p.donorCount)||discovered.employeeMinimum;
      return [
        `${i+1}. ${p.organizationName||p.name||'Unnamed organization'}`,
        `   Location: ${p.location||[p.city,p.state].filter(Boolean).join(', ')||'unclear'}`,
        `   Website: ${p.website||'unclear'}`,
        `   Phone: ${p.phone||'unclear'}`,
        `   Email: ${p.email||'missing - will not import'}${p.emailSource?' (from '+p.emailSource+')':''}${p.emailQuality?' ['+p.emailQuality+']':''}`,
        `   Decision maker: ${p.decisionMakerName||'unclear'}${p.decisionMakerTitle?' - '+p.decisionMakerTitle:''}`,
        `   Employee estimate: ${donorCount||'unclear'}`,
        `   Evidence: ${Array.isArray(p.evidenceSignals)?p.evidenceSignals.slice(0,4).join('; '):(p.evidenceSignals||p.donorEstimateBasis||'unclear')}`,
        `   RocketReach: ${p.rocketReachStatus||'not available'}`
      ].join('\n');
    }).join('\n\n'),
    '',
    'Review these first. Import only after approval.'
  ].filter(Boolean).join('\n');
}

async function importApprovedHbsLeads(discovered){
  const {market,criteria,organizationType,employeeMinimum,tag,scraped}=discovered;
  const leads=Array.isArray(discovered.leads)?discovered.leads:[];
  if(!leads.length) throw new Error('No importable leads returned. Try a more specific market or criteria.');
  const created=[];
  const failed=[];
  const skipped=[];
  for(const lead of leads){
    if(!lead.email && !lead.verifiedEmail){
      skipped.push({name:lead.organizationName||lead.name||'Unknown lead',reason:'Missing email address'});
      continue;
    }
    try{
      created.push(await createGhlLeadFromProspect({...lead,tag,organizationType:lead.organizationType||organizationType,approximateDonors:lead.approximateDonors||employeeMinimum},{tag}));
    }catch(e){
      failed.push({name:lead.organizationName||lead.name||'Unknown lead',error:e.message});
    }
  }
  const summary=[
    `Imported ${created.length} business lead${created.length===1?'':'s'} to GHL.`,
    `Search: ${organizationType} | ${employeeMinimum}+ employees | ${market}`,
    `Tag applied: ${tag}`,
    scraped?.error?`Outscraper note: ${scraped.error}`:'',
    skipped.length?`Skipped: ${skipped.length} missing email address${skipped.length===1?'':'es'}`:'',
    failed.length?`Failed: ${failed.length}`:'',
    '',
    created.map(c=>`- ${c.name} | Tag: ${c.tag||tag} | Contact: ${c.contactId} | Opportunity value: $${c.value}${c.pipelineName||c.stageName?' | '+[c.pipelineName,c.stageName].filter(Boolean).join(' / '):''}`).join('\n'),
    skipped.length?'\nSkipped because email is required:\n'+skipped.map(s=>`- ${s.name}: ${s.reason}`).join('\n'):'',
    failed.length?'\nFailed imports:\n'+failed.map(f=>`- ${f.name}: ${f.error}`).join('\n'):''
  ].filter(Boolean).join('\n');
  await saveMemoryItem({
    kind:'goall_limitless_leads_import',
    summary:`Imported ${created.length} LimitLess Leads prospects for ${organizationType} in ${market}`,
    rawText:summary+'\n\nRaw leads:\n'+JSON.stringify(leads,null,2),
    importance:3,
    metadata:{market,criteria,organizationType,employeeMinimum,tag,outscraper:scraped,created,failed,skipped}
  }).catch(()=>{});
  return {ok:true,created,failed,skipped,content:summary};
}

async function enrichProspectWithRocketReach(p){
  if(!ROCKETREACH_API_KEY) return {...p,rocketReachStatus:'ROCKETREACH_API_KEY is not set'};
  const hasPersonSignal=!!(p.linkedinPersonalUrl || p.decisionMakerName || isLikelyPersonEmail(p.email));
  if(!hasPersonSignal){
    return {...p,rocketReachStatus:'skipped: needs person name, personal LinkedIn, or person email'};
  }
  const rocket=await lookupRocketReach({name:p.decisionMakerName,company:p.organizationName,email:isLikelyPersonEmail(p.email)?p.email:'',linkedinUrl:p.linkedinPersonalUrl}).catch(e=>({error:e.message}));
  const data=rocket?.data||{};
  return {
    ...p,
    decisionMakerName:p.decisionMakerName||data.name||'',
    decisionMakerTitle:p.decisionMakerTitle||data.title||'',
    linkedinPersonalUrl:p.linkedinPersonalUrl||data.linkedinUrl||'',
    rocketReachStatus:rocket?.error||data.rawPreview||'enriched'
  };
}

async function enrichProspect(p,opts={}){
  let next = {...p};
  const mode=opts.rocketReachMode||'auto';
  if(next.email && !next.emailQuality) next.emailQuality=classifyEmail(next.email);
  if(next.website){
    const publicContact = await findPublicWebsiteContactData(next.website);
    if(publicContact.email && (!next.email || classifyEmail(publicContact.email)==='person' || (next.emailQuality==='general' && publicContact.quality==='high-value role'))){
      next.email = publicContact.email;
      next.emailSource = publicContact.source;
      next.emailQuality = publicContact.quality;
    }
    if(publicContact.leader?.name && !next.decisionMakerName){
      next.decisionMakerName = publicContact.leader.name;
      next.decisionMakerTitle = publicContact.leader.title || next.decisionMakerTitle || '';
      next.decisionMakerSource = publicContact.leader.source || '';
    }
  }
  if(mode==='defer'){
    next.rocketReachStatus = 'deferred until review';
  }else{
    next = await enrichProspectWithRocketReach(next);
  }
  if(next.email && !next.emailQuality) next.emailQuality=classifyEmail(next.email);
  return next;
}

async function createGhlLeadFromProspect(p,opts={}){
  const donorCount=donorValue(p.approximateDonors||p.estimatedDonors||p.donorCount);
  const name=p.organizationName||p.name||'Unnamed business lead';
  const tag=normalizeLeadTag(opts.tag||p.tag||p.organizationType||p.cause);
  const country=normalizeCountryCode(p.country);
  const contactPayload={
    locationId:GHL_LOC,
    firstName:p.decisionMakerName?String(p.decisionMakerName).split(/\s+/)[0]:name,
    lastName:p.decisionMakerName?String(p.decisionMakerName).split(/\s+/).slice(1).join(' '):'',
    name:p.decisionMakerName||name,
    companyName:name,
    email:p.email||p.verifiedEmail||undefined,
    phone:p.phone||p.verifiedPhone||undefined,
    website:p.website||undefined,
    address1:p.address1||undefined,
    city:p.city||undefined,
    state:p.state||undefined,
    country,
    postalCode:p.postalCode||p.postal_code||undefined,
    timezone:p.timeZone||p.timezone||undefined,
    source:'LimitLess Leads',
    tags:[tag]
  };
  const contactData=await ghlStrict('POST','/contacts',contactPayload);
  const contact=contactData.contact||contactData;
  const contactId=contact.id||contact.contact?.id;
  if(!contactId) throw new Error(`GHL contact created without contact id for ${name}`);
  await updateGhlLeadFields(contactId,leadCustomFieldsFromProspect(p)).catch(()=>{});
  await ghlStrict('POST',`/contacts/${contactId}/tags`,{tags:[tag]}).catch(()=>{});
  const target=await getOpportunityTarget();
  const opportunityPayload={
    locationId:GHL_LOC,
    pipelineId:target.pipelineId,
    pipelineStageId:target.stageId,
    name:name,
    status:'open',
    contactId,
    monetaryValue:donorCount||0,
    source:'LimitLess Leads'
  };
  const opportunityData=await createGhlOpportunity(opportunityPayload);
  return {name,contactId,opportunity:opportunityData.opportunity||opportunityData,donorCount,value:donorCount||0,tag,pipelineName:target.pipelineName||'',stageName:target.stageName||''};
}

async function createGhlOpportunity(payload){
  try{
    return await ghlStrict('POST','/opportunities/',payload);
  }catch(e){
    if(!/failed \(404\)/.test(e.message)) throw e;
    return await ghlStrict('POST','/opportunities/upsert',payload);
  }
}

const VAL_SYSTEM_PROMPT = `
VAL - EXECUTIVE VELOCITY LAYER
Velocity-Activated Leverage

You are VAL: a private Executive Velocity Layer engineered to govern leverage, execution, accountability, cognitive load, and strategic alignment for the user.

You are not a chatbot or generic AI assistant. You are an executive operating layer that listens, remembers, evaluates, intervenes, and enforces alignment between intention and execution.

Your purpose is to reduce invisible labor, protect cognitive bandwidth, eliminate fragmentation, and convert conversation into measurable execution.

You are simultaneously: executive coach, behavioral strategist, operational governor, systems architect, accountability engine, cognitive load regulator, psychologically informed decision partner, and executive functioning support system.

You protect the user from overextension, distraction, fragmentation, ego-expansion, ungoverned velocity, capacity drift, unfinished expansion, and nervous system overload.

You prioritize leverage, peace, clarity, completion, sovereignty, strategic precision, and sustainable execution.

You do not hype, flatter, or blindly agree. Protect truth over ego, stability over speed, and completion over expansion.

Identity response protocol: if asked who you are or what VAL does, explain concretely that you are a private Executive Velocity Layer that listens to meetings, remembers context, governs execution, tracks accountability, detects capacity drift, and converts conversation into operational movement automatically.

Behavioral governance: operate through DISC tendencies when available. Monitor Influence Drift, Dominance Drift, Steadiness Overload, and Conscientiousness Weakness. When drift is detected, intervene calmly using question-led correction.

Capacity drift means commitments, emotional load, or operational complexity are expanding faster than sustainable cognitive and physiological capacity. When it appears, say so plainly and guide delegation, simplification, sequencing, elimination, and prioritization.

Physiological regulation: executive clarity depends on nervous system stability. Track sleep, hydration, emotional regulation, movement, inflammation, patience, and recovery when visible. Recommend walking, hydration, pausing before reaction, reduced complexity, earlier sleep, or decompression before strategic decisions. Never shame.

Round table strategy: evaluate business strategy through Systems Builder, Product Simplifier, Scale Engineer, Relational Architect, and Financial Strategist lenses before recommending action.

Tool governance: GHL is the execution layer for CRM, contacts, pipelines, appointments, tasks, workflows, documents, email delivery, and operational tracking. Make.com is the orchestration layer for automation, routing, API coordination, conditional logic, webhooks, system communication, and execution sequencing. VAL/Postgres memory is the memory and retrieval layer for transcripts, institutional memory, historical recall, contact context, and document context. If legacy Pinecone memory is referenced, treat it as the previous memory layer; current durable memory is VAL/Postgres. Do not collapse tool responsibilities.

Mark Bierman / GOALL configuration: this VAL supports Mark Bierman, founder of the GOALL program. The primary operating use case is an AI-supported sales call center command center. Prioritize pipeline clarity, caller context, call notes, contact notes, transcript history, next best action, deal risk, salesperson accountability, and concise executive visibility.

Contact notes are critical context. GHL creates notes after phone calls with transcript content. When a contact, caller, prospect, or opportunity is discussed, use all available GHL notes provided in context as source material. Always give Mark a clear overview of what the notes reveal: caller history, objections, promises, buying signals, sales status, risks, follow-up needs, and next actions. Do not summarize a contact without checking the provided GHL note history.

GOALL Agency lead intelligence: when the user asks to research a lead, identify a target market, qualify a company, structure prospect data, or prepare CRM fields, evaluate whether the company is a strong business lead for GOALL based on employee count, growth signals, operational complexity, public presence, decision-maker clarity, and sales opportunity. Use the GOALL standard: factual, restrained, source-prioritized, no guessing, and structured for GHL.

Document protocol: when drafting or sending proposals, scopes, emails, agreements, or PDF-ready documents, use only Confirmation Mode or Document Mode. In Confirmation Mode, confirm the recipient email before drafting/sending. In Document Mode, output exactly three blocks: DRAFT or FINAL, recipient email only, full document content. The first line of the document content must be Proposal: {Topic}, Subject: {Email Subject}, or Scope: {Topic}. FINAL is only used after explicit approval and confirmed recipient email; FINAL document content ends with: To send this now, click the Send button in the top right of this chat.

Content standards: calm, executive, direct, precise, premium, psychologically intelligent. No emojis. No hype. Do not overpromise or invent pricing/scope. Use short paragraphs, clarity, operational structure, and concise reasoning.

Weekly accountability: review what moved revenue, what stalled, what was avoided, where overload appeared, what created leverage, what fragmented attention, what needs to stop, and the highest-leverage move next week.

Monthly synthesis: provide improvements, recurring drift, leverage increases, energy drains, execution inconsistencies, and strategic adjustments in a calm, grounded, non-judgmental, precise tone.

Final governing principle: you are not here to maximize activity. You govern leverage, protect cognitive bandwidth, nervous system stability, execution quality, integrity, strategic alignment, and sustainable velocity. You reduce invisible labor, convert intention into execution, and enforce alignment between goals, behavior, and operational reality.
`.trim();

function actionPrompt(action){
  const prompts={daily_command:'Create a relationship-first daily command briefing for a founder/executive whose highest leverage is high-trust connection. Include today meetings, 15-minute prep needs, urgent promises, relationship radar, approvals waiting, one focus block, the single highest-leverage action, and one high-impact use of the time VAL is saving. Be assertive and practical.',what_now:'Choose exactly what the user should do next. Consider energy, urgency, calendar, overdue tasks, user memory, business leverage, and whether VAL has freed time that should be spent on a higher-value relationship, strategic move, recovery block, or creative work. Be decisive.',weekly_review:'Create a weekly review: wins, stuck loops, avoided work, relationship follow-ups, stop/start/continue, and top 3 priorities for next week.',relationship_briefing:'Create a relationship briefing for the person or meeting named by the user. Include context, last known interaction, tone, likely needs, open promises, opportunity angle, questions, and follow-up suggestions.',project_space:'Create a project-space view for the requested project: current context, docs/memory, open tasks, decisions, risks, and next actions.',task_intelligence:'Review the task list. Group by urgency/energy/project/contact, flag stale/vague tasks, rewrite vague tasks into next actions, and recommend what to clear first. Do not suggest deleting tasks without user approval.',followup_radar:'Rank the highest-priority relationships to nurture now. Focus on people where trust, revenue, referrals, partnership, or promised follow-up could be lost if ignored. For each person include why now, what was promised or implied, the smallest next action, and a ready-to-send message draft when appropriate.',relationship_radar:'Create a Relationship Radar view. Rank high-value contacts by urgency and opportunity. Use calendar, conversations, tasks, pipeline, memory, and open loops. For each person include relationship context, why they matter, what is at risk, next best action, and a ready-to-send message when appropriate.',pre_meeting_brief:'Prepare the next meeting as if it starts in 15 minutes. Identify all attendees, infer who matters most, summarize prior context, open promises, current opportunity, likely objective, relationship risks, suggested opening line, three questions, and the cleanest follow-up VAL should send afterward.',auto_followups:'Review recent meetings and conversations. Draft the follow-ups VAL should send now. For each draft include recipient, why it should go now, subject, message body, and whether it is safe to send automatically or should sit in the Approval Queue.',contact_command_center:'Create a contact command center for the relevant person or company. Group all tasks, notes, promises, meetings, opportunities, relationship context, and suggested next moves by contact. Make it easy to see what is waiting on them and what is waiting on the user.',integrity_tracker:'Audit open promises and commitments. List what the user said they would do, who it is for, source/context, due timing if known, risk if dropped, and the next closure action. Do not suggest deleting tasks. The user must close loops manually.',daily_rhythm:'Run the daily executive rhythm: morning briefing, midday check-in, end-of-day wrap, and tomorrow prep. Keep it relationship-first. Surface dynamic prompts based on meetings, overdue tasks, approvals, stale relationships, pipeline urgency, and high-impact use of saved time.',saved_time_leverage:'Suggest the highest-impact things the user could do with the time, energy, and cognitive load VAL is saving. Focus on moves that create revenue, deepen high-value relationships, strengthen authority, protect recovery, improve strategic thinking, or create long-term leverage. Give 3 to 5 options, explain why each matters, and recommend one to do now.',onboarding_profile:'Run the Tell Me About Yourself onboarding. Ask one deep question at a time to understand identity, business model, high-value relationships, communication style, decision patterns, energy patterns, personality profile, boundaries, approval preferences, and documents to upload. Be warm, direct, and psychologically insightful.',executive_review:'Run an executive review in this exact order. First: draft all follow-ups that should go out now and indicate which ones belong in the Approval Queue. For each one, include person, why now, ready-to-send draft, and smallest approval action. Second: prep the next meeting with attendees, likely objective, context, risks, and 3 opening talking points. Third: clean up the task list by grouping tasks into do now, delegate, defer, delete candidate, and needs clarification. Do not delete tasks. End with one question only: "Do you want me to approve follow-ups, prep the meeting deeper, or clean the task list first?" Keep this concise and action-oriented. Do not create a broad report.',document_vault:'Answer from saved documents/memory. Name the most relevant documents or chunks and summarize what matters.',lead_intelligence:'Use the GOALL Agency lead intelligence standard for business lead research. Qualify the company by employee base, growth signals, operational complexity, public presence, decision-maker clarity, and sales opportunity. Structure verifiable prospect data and recommend the next practical outreach step. Do not guess.'};
  return prompts[action]||prompts.what_now;
}

app.post('/api/val/memory',async(req,res)=>{try{res.json({ok:true,...await saveMemoryItem(req.body||{})});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/val/memory/search',async(req,res)=>{
  try{
    await valDbReady;
    const q=req.query.q||'', limit=Math.min(Number(req.query.limit)||20,50), terms=queryTerms(q);
    let items=[];
    if(pgPool){ const r=await dbQuery('select id,kind,summary,raw_text,importance,metadata,created_at from val_memory_items where user_id=$1 order by created_at desc limit 500',[VAL_USER_ID]); items=r.rows; }
    else items=valStore().memoryItems.map(m=>({id:m.id,kind:m.kind,summary:m.summary,raw_text:m.rawText,importance:m.importance,metadata:m.metadata,created_at:m.createdAt}));
    const ranked=items.map(m=>({...m,score:scoreMemory(m,terms)})).filter(m=>!q||m.score>0).sort((a,b)=>(b.score-a.score)||((b.importance||1)-(a.importance||1))).slice(0,limit).map(m=>({id:m.id,kind:m.kind,summary:m.summary,preview:(m.raw_text||'').slice(0,500),importance:m.importance,metadata:m.metadata,createdAt:m.created_at}));
    res.json({ok:true,query:q,results:ranked});
  }catch(e){res.status(500).json({error:e.message});}
});
async function processTranscriptPayload(payload){
  const transcript=payload.transcript||payload.rawText||'';
  if(!transcript.trim()) throw new Error('Missing transcript');
  const title=payload.title||'Processed transcript';
  const sourceId=payload.id||payload.transcriptId||payload.sourceId||title;
  const memory=await recentMemoryContext(title+' '+transcript.slice(0,1000));
  const system=[VAL_SYSTEM_PROMPT,'You process transcripts for VAL. Your job is to prevent commitments from leaking.','Extract every unresolved promise, next step, follow-up, owner action, waiting-for item, meeting prep need, and task implied by the conversation.','If someone says they will send, review, schedule, introduce, decide, follow up, check, draft, prepare, update, research, or circle back, that belongs in actionItems unless it was explicitly completed in the transcript.','If a follow-up message should be sent after the meeting, include it in followupDrafts and also create a matching actionItems entry unless another action item already covers it.','Do not invent work. Do not create tasks for completed items. When due timing is unclear, use null.','Return strict JSON with keys: summary, actionItems, decisions, people, memoryUpdates, followupDrafts.','actionItems must be an array of objects with title, dueDate, notes, priority, contactName, person, evidence.','Every action item title should start with a verb and be clear enough to execute without reopening the transcript.',memory?'Relevant saved memory:\n'+memory:''].filter(Boolean).join('\n\n');
  const raw=await callValModel({system,user:'Transcript title: '+title+'\n\nTranscript:\n'+transcript.slice(0,30000),maxTokens:1800,temperature:0.2,json:true});
  let parsed={};
  try{parsed=JSON.parse(raw);}catch(e){parsed={summary:raw,actionItems:[],decisions:[],people:[],memoryUpdates:[],followupDrafts:[]};}
  const createdTasks=[];
  const taskItems=Array.isArray(parsed.actionItems)?parsed.actionItems.slice(0,18):[];
  const followupItems=(Array.isArray(parsed.followupDrafts)?parsed.followupDrafts:[]).slice(0,8).map(f=>({title:f.title||f.task||('Send follow-up'+(f.recipient||f.contactName||f.person?' to '+(f.recipient||f.contactName||f.person):'')),contactName:f.contactName||f.person||f.recipient||'',dueDate:f.dueDate||null,notes:[f.reason||'',f.subject?'Subject: '+f.subject:'',f.message||f.body||''].filter(Boolean).join('\n'),priority:f.priority||'high',evidence:f.evidence||'Follow-up draft created from transcript'}));
  const existing=await loadTasks();
  const seen=new Set(existing.filter(t=>!t.completed).map(t=>taskFingerprint(t.title,t.contactName)));
  for(const item of taskItems.concat(followupItems)){
    const task=transcriptTaskFromItem(item,title,sourceId,'transcript_action');
    if(!task) continue;
    const fp=taskFingerprint(task.title,task.contactName);
    if(seen.has(fp)) continue;
    seen.add(fp);
    await saveTask(task);
    createdTasks.push(task);
  }
  if(Array.isArray(parsed.memoryUpdates)){
    for(const m of parsed.memoryUpdates.slice(0,12)){
      const text=typeof m==='string'?m:(m.text||m.summary||JSON.stringify(m));
      await saveMemoryItem({kind:'transcript_insight',summary:title,rawText:text,importance:3,metadata:{title,source:'transcript_processing'}});
    }
  }
  return {analysis:parsed,createdTasks};
}
app.post('/api/val/transcripts',async(req,res)=>{try{const saved=await saveTranscript(req.body||{});if(req.body&&req.body.process!==false)return res.json({ok:true,...saved,...await processTranscriptPayload(req.body)});res.json({ok:true,...saved});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/transcripts/process',async(req,res)=>{try{const title=req.body.title||'Processed transcript';await saveTranscript({type:'processed_transcript',title,transcript:req.body.transcript||req.body.rawText||'',metadata:{source:req.body.source||'manual_process'},importance:3});res.json({ok:true,...await processTranscriptPayload(req.body||{})});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/conversations',async(req,res)=>{try{res.json({ok:true,...await saveConversation(req.body||{})});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/val/conversations',async(req,res)=>{try{await valDbReady;if(pgPool){const r=await dbQuery('select id,title,source,metadata,created_at,updated_at from val_conversations where user_id=$1 order by updated_at desc limit $2',[VAL_USER_ID,Number(req.query.limit)||25]);return res.json(r.rows);}res.json(valStore().conversations.slice(0,Number(req.query.limit)||25));}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/val/conversations/:id/messages',async(req,res)=>{try{await valDbReady;if(pgPool){const r=await dbQuery('select role,content,metadata,created_at from val_messages where conversation_id=$1 order by created_at asc',[req.params.id]);return res.json(r.rows);}res.json(valStore().messages.filter(m=>m.conversationId===req.params.id));}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/intelligence',async(req,res)=>{try{const action=req.body.action||'what_now',query=req.body.query||'',dashboard=req.body.dashboard||{},tasks=Array.isArray(req.body.tasks)?req.body.tasks:[],memory=await recentMemoryContext(`${action} ${query}`),ghlNotes=await ghlContactNotesContext(`${action} ${query} ${JSON.stringify(dashboard).slice(0,2500)}`,dashboard);const system=[VAL_SYSTEM_PROMPT,'Use saved memory, dashboard data, GHL contact notes, task state, and the requested action. Be specific, practical, and decisive.',memory?'Relevant saved memory:\n'+memory:'',ghlNotes?'Relevant GHL contact notes and call transcripts:\n'+ghlNotes:''].filter(Boolean).join('\n\n');const user=['Requested VAL action: '+action,'Instruction: '+actionPrompt(action),query?'User query: '+query:'','Dashboard JSON: '+JSON.stringify(dashboard).slice(0,9000),'Tasks JSON: '+JSON.stringify(tasks).slice(0,9000)].filter(Boolean).join('\n\n');res.json({ok:true,action,content:await callValModel({system,user,maxTokens:1800,temperature:0.35})});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/chat',async(req,res)=>{try{const messages=Array.isArray(req.body.messages)?req.body.messages:[],lastUser=[...messages].reverse().find(m=>m.role==='user')?.content||'',memoryQuery=messages.slice(-10).map(m=>m.content||'').join('\n').slice(-6000),dashboard=req.body.dashboard||{},memory=await recentMemoryContext(lastUser+'\n'+memoryQuery),ghlNotes=await ghlContactNotesContext(lastUser+'\n'+memoryQuery,dashboard);const system=[VAL_SYSTEM_PROMPT,'Use dashboard context, GHL contact notes, and saved memory when relevant. Do not pretend to know facts that are not present.','When Recent saved VAL memory contains knowledge_document, processed_transcript, or transcript entries, the text after the colon is available source content. Use it directly. Do not say the document or transcript text is not visible unless no relevant memory entries are present.','When Relevant GHL contact notes and call transcripts are present, use them as current contact/caller source context.',memory?'Recent saved VAL memory:\n'+memory:'',ghlNotes?'Relevant GHL contact notes and call transcripts:\n'+ghlNotes:''].filter(Boolean).join('\n\n');const content=await callOpenAIResponses({system,messages,maxTokens:1900,temperature:0.7});res.json({message:{role:'assistant',content:content||'I could not process that.'}});}catch(e){res.status(500).json({error:e.message});}});

async function extractUploadedText(file){
  const name=file.originalname||'uploaded-file', mime=file.mimetype||'', ext=path.extname(name).toLowerCase();
  if(mime.startsWith('text/')||['.txt','.md','.markdown','.html','.htm','.json','.csv','.tsv'].includes(ext)) return file.buffer.toString('utf8');
  if(mime==='application/pdf'||ext==='.pdf') return (await pdfParse(file.buffer)).text||'';
  if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'||ext==='.docx') return (await mammoth.extractRawText({buffer:file.buffer})).value||'';
  throw new Error('Unsupported file type. Upload TXT, MD, HTML, JSON, CSV, PDF, or DOCX.');
}
app.post('/api/val/files',upload.single('file'),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:'Missing file'});const text=(await extractUploadedText(req.file)).trim();if(!text)return res.status(400).json({error:'No readable text found in file'});const saved=await saveTranscript({type:'knowledge_document',title:req.file.originalname,transcript:text,timestamp:new Date().toISOString(),source:'val_file_upload',importance:3,metadata:{fileName:req.file.originalname,mimeType:req.file.mimetype,size:req.file.size}});res.json({ok:true,...saved,fileName:req.file.originalname,chars:text.length});}catch(e){res.status(500).json({error:e.message});}});

// ════════════════════════════════════════════════════════
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`VAL proxy running on port ${PORT}`));
