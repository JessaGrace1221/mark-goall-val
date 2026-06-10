const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const {AsyncLocalStorage} = require('async_hooks');
const multer  = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const {createGhlMcpService} = require('./services/ghlMcpService');
const app     = express();

app.use(cors());
app.use(express.json({limit:'10mb'}));
app.set('trust proxy',1);
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});

const CLIENT_CONFIG = {
  clientName: process.env.VAL_CLIENT_NAME || 'VAL User',
  clientSlug: process.env.VAL_CLIENT_SLUG || 'val-core',
  brandName: process.env.VAL_CLIENT_BRAND_NAME || process.env.VAL_CLIENT_NAME || 'VAL',
  logoUrl: process.env.VAL_CLIENT_LOGO_URL || process.env.VAL_LOGO_URL || '',
  publicBaseUrl: process.env.VAL_PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
  timezone: process.env.VAL_DEFAULT_TIMEZONE || 'America/New_York',
  supportEmail: process.env.VAL_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL || ''
};
const DEMO_MODE = /^(1|true|yes)$/i.test(String(process.env.VAL_DEMO_MODE || ''));
const VAL_SIGNUP_URL = process.env.VAL_SIGNUP_URL || 'https://graceintelligence.com/val';
const GHL_KEY = process.env.GHL_KEY || process.env.GHL_API_KEY;
const GHL_LOC = process.env.GHL_LOC || process.env.GHL_LOCATION_ID;
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
const requestContext = new AsyncLocalStorage();
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
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'val_session';
const VAL_USER_ID = process.env.VAL_USER_ID || CLIENT_CONFIG.clientSlug || 'default';
const MEMORY_CHUNK_SIZE = Number(process.env.MEMORY_CHUNK_SIZE) || 1800;
const MEMORY_CHUNK_OVERLAP = Number(process.env.MEMORY_CHUNK_OVERLAP) || 250;
const OPENAI_USAGE_LOG_FILE = process.env.OPENAI_USAGE_LOG_FILE || path.join(__dirname,'logs','openai-usage.jsonl');
let pgPool = null;
const ghlMcp = createGhlMcpService({
  baseUrl:BASE,
  fallbackApiKey:GHL_KEY,
  fallbackLocationId:GHL_LOC,
  calendarIds:GHL_CALENDAR_IDS,
  resolveSecret:resolveIntegrationSecret,
  getCurrentUser:currentValUser,
  getTenantId:tenantId,
  inferOwner:inferValOwner,
  logger:console
});

function approxTokens(value){
  if(value==null)return 0;
  if(typeof value==='string')return Math.ceil(value.length/4);
  if(Array.isArray(value))return value.reduce((sum,item)=>sum+approxTokens(item),0);
  if(typeof value==='object')return Object.values(value).reduce((sum,item)=>sum+approxTokens(item),0);
  return Math.ceil(String(value).length/4);
}
function requestMetaFromBody(body={}){
  const transcriptText=body.transcript||body.rawText||body.text||'';
  return {
    contactId:String(body.contactId||body.contact_id||body.contact?.id||'').slice(0,120),
    transcriptId:String(body.savedTranscriptId||body.transcriptId||body.id||body.sourceId||'').slice(0,120),
    transcriptHash:transcriptText?crypto.createHash('sha256').update(String(transcriptText)).digest('hex').slice(0,16):''
  };
}
function openAiRequestContext(extra={}){
  const ctx=requestContext.getStore()||{};
  const user=ctx.user||{};
  return {
    routeJobSource:extra.routeJobSource||ctx.routeJobSource||ctx.route||'unknown',
    userId:extra.userId||user.id||VAL_USER_ID||'',
    clientId:extra.clientId||user.clientSlug||CLIENT_CONFIG.clientSlug||'',
    locationId:extra.locationId||GHL_LOC||'',
    contactId:extra.contactId||ctx.contactId||'',
    transcriptId:extra.transcriptId||ctx.transcriptId||'',
    transcriptHash:extra.transcriptHash||ctx.transcriptHash||'',
    requestReason:extra.requestReason||ctx.requestReason||''
  };
}
function openAiTokenUsage(payload={}){
  const u=payload.usage||{};
  const details=u.output_tokens_details||{};
  return {
    actualInputTokens:u.input_tokens??u.prompt_tokens??null,
    actualOutputTokens:u.output_tokens??u.completion_tokens??null,
    totalTokens:u.total_tokens??null,
    cachedInputTokens:u.input_tokens_details?.cached_tokens??u.prompt_tokens_details?.cached_tokens??null,
    reasoningOutputTokens:details.reasoning_tokens??null
  };
}
function openAiTextRates(model=''){
  const m=String(model||'').toLowerCase();
  if(m.includes('gpt-4o-mini-search'))return {input:0.15,output:0.60};
  if(m.includes('gpt-4o-search'))return {input:2.50,output:10.00};
  if(m.includes('gpt-4o-mini'))return {input:0.15,output:0.60};
  if(m.includes('gpt-4o'))return {input:2.50,output:10.00};
  if(m.includes('gpt-5-mini'))return {input:0.25,output:2.00};
  if(m.includes('gpt-5-nano'))return {input:0.05,output:0.40};
  if(m.includes('gpt-5'))return {input:1.25,output:10.00};
  if(m.includes('gpt-4.1-mini'))return {input:0.40,output:1.60};
  if(m.includes('gpt-4.1-nano'))return {input:0.10,output:0.40};
  if(m.includes('gpt-4.1'))return {input:2.00,output:8.00};
  if(m.includes('o3'))return {input:2.00,output:8.00};
  if(m.includes('o4-mini'))return {input:1.10,output:4.40};
  return {input:1.25,output:10.00};
}
function estimateOpenAiCost({model,estimatedInputTokens,estimatedOutputTokens,actualInputTokens,actualOutputTokens,flatCostUsd}={}){
  if(Number.isFinite(flatCostUsd))return Number(flatCostUsd.toFixed(6));
  const rates=openAiTextRates(model);
  const inTokens=Number.isFinite(actualInputTokens)?actualInputTokens:(estimatedInputTokens||0);
  const outTokens=Number.isFinite(actualOutputTokens)?actualOutputTokens:(estimatedOutputTokens||0);
  return Number(((inTokens/1000000)*rates.input+(outTokens/1000000)*rates.output).toFixed(6));
}
async function appendOpenAiUsageLog(entry){
  try{
    await fs.promises.mkdir(path.dirname(OPENAI_USAGE_LOG_FILE),{recursive:true});
    await fs.promises.appendFile(OPENAI_USAGE_LOG_FILE,JSON.stringify(entry)+'\n');
  }catch(e){
    console.error('OpenAI usage log failed:',e.message);
  }
}
async function logOpenAiUsage({wrapper,model,estimatedInputTokens=0,estimatedOutputTokens=0,responsePayload={},requestId='',retry=false,extra={},flatCostUsd}){
  const usage=openAiTokenUsage(responsePayload);
  const meta=openAiRequestContext(extra);
  const row={
    timestamp:new Date().toISOString(),
    wrapper,
    routeJobSource:meta.routeJobSource,
    model,
    estimatedInputTokens,
    actualInputTokens:usage.actualInputTokens,
    actualOutputTokens:usage.actualOutputTokens,
    estimatedCostUsd:estimateOpenAiCost({model,estimatedInputTokens,estimatedOutputTokens,actualInputTokens:usage.actualInputTokens,actualOutputTokens:usage.actualOutputTokens,flatCostUsd}),
    openAiRequestId:requestId||responsePayload.id||'',
    retry:!!retry,
    userId:meta.userId,
    clientId:meta.clientId,
    locationId:meta.locationId,
    contactId:meta.contactId,
    transcriptId:meta.transcriptId,
    transcriptHash:meta.transcriptHash,
    requestReason:meta.requestReason,
    totalTokens:usage.totalTokens,
    cachedInputTokens:usage.cachedInputTokens,
    reasoningOutputTokens:usage.reasoningOutputTokens
  };
  await appendOpenAiUsageLog(row);
}
async function readOpenAiUsageRows({hours=24,limit=10000}={}){
  try{
    const raw=await fs.promises.readFile(OPENAI_USAGE_LOG_FILE,'utf8');
    const cutoff=Date.now()-(Number(hours)||24)*60*60*1000;
    return raw.split('\n').filter(Boolean).slice(-limit).map(line=>{
      try{return JSON.parse(line);}catch(_){return null;}
    }).filter(row=>{
      if(!row||!row.timestamp)return false;
      const t=new Date(row.timestamp).getTime();
      return !isNaN(t)&&t>=cutoff;
    });
  }catch(e){
    if(e.code==='ENOENT')return [];
    throw e;
  }
}
function summarizeOpenAiUsageRows(rows){
  const groups=new Map();
  for(const row of rows){
    const key=[row.model||'unknown',row.routeJobSource||'unknown',row.wrapper||'unknown'].join('||');
    if(!groups.has(key)){
      groups.set(key,{
        model:row.model||'unknown',
        routeJobSource:row.routeJobSource||'unknown',
        wrapper:row.wrapper||'unknown',
        totalCalls:0,
        estimatedTotalCostUsd:0,
        totalInputTokens:0,
        totalOutputTokens:0,
        averageCostPerCallUsd:0,
        highestCostSingleCall:null
      });
    }
    const g=groups.get(key);
    const cost=Number(row.estimatedCostUsd)||0;
    const input=Number(row.actualInputTokens ?? row.estimatedInputTokens)||0;
    const output=Number(row.actualOutputTokens)||0;
    g.totalCalls+=1;
    g.estimatedTotalCostUsd+=cost;
    g.totalInputTokens+=input;
    g.totalOutputTokens+=output;
    if(!g.highestCostSingleCall||cost>g.highestCostSingleCall.estimatedCostUsd){
      g.highestCostSingleCall={
        timestamp:row.timestamp,
        estimatedCostUsd:cost,
        estimatedInputTokens:row.estimatedInputTokens||0,
        actualInputTokens:row.actualInputTokens,
        actualOutputTokens:row.actualOutputTokens,
        openAiRequestId:row.openAiRequestId||'',
        retry:!!row.retry,
        userId:row.userId||'',
        clientId:row.clientId||'',
        locationId:row.locationId||'',
        contactId:row.contactId||'',
        transcriptId:row.transcriptId||'',
        transcriptHash:row.transcriptHash||'',
        requestReason:row.requestReason||''
      };
    }
  }
  return Array.from(groups.values()).map(g=>({
    ...g,
    estimatedTotalCostUsd:Number(g.estimatedTotalCostUsd.toFixed(6)),
    averageCostPerCallUsd:Number((g.estimatedTotalCostUsd/Math.max(1,g.totalCalls)).toFixed(6))
  })).sort((a,b)=>b.estimatedTotalCostUsd-a.estimatedTotalCostUsd);
}

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

const demoSessions = new Map();
function demoIso(dayOffset=0,hour=9,minute=0){
  const d=new Date();
  d.setHours(hour,minute,0,0);
  d.setDate(d.getDate()+dayOffset);
  return d.toISOString();
}
function cloneDemo(value){ return JSON.parse(JSON.stringify(value)); }
function demoTemplate(){
  const tasks=[
    {id:'demo-task-1',title:'Send revised scope to Elena',contactName:'Elena Brooks',dueDate:demoIso(0,16,0),notes:'Promise from yesterday’s investor prep call. Include timeline and pilot pricing.',details:[{text:'Created from transcript: Investor Prep Call',ts:demoIso(-1,11,20)}],completed:false,createdAt:demoIso(-1,11,30)},
    {id:'demo-task-2',title:'Ask Marcus for procurement owner',contactName:'Marcus Chen',dueDate:demoIso(1,10,0),notes:'Needed before the Tuesday enterprise demo. VAL flagged this as the fastest way to shorten the sales cycle.',details:[{text:'Relationship Review flagged missing decision-maker.',ts:demoIso(0,8,15)}],completed:false,createdAt:demoIso(0,8,15)},
    {id:'demo-task-3',title:'Review HealthBridge renewal risk',contactName:'Priya Raman',dueDate:demoIso(0,12,30),notes:'Renewal is strong, but implementation notes mention sponsor fatigue.',details:[{text:'Created from GHL notes and call transcript.',ts:demoIso(-2,15,10)}],completed:false,createdAt:demoIso(-2,15,10)},
    {id:'demo-task-4',title:'Prepare board update bullets',contactName:'Board',dueDate:demoIso(2,9,0),notes:'Use pipeline movement, relationship radar, and saved-time outcomes.',details:[],completed:false,createdAt:demoIso(-1,9,0)},
    {id:'demo-task-5',title:'Confirm intro path for Northstar',contactName:'Jordan Lee',dueDate:null,notes:'Jordan offered a warm path to Northstar. Needs a concise ask.',details:[],completed:false,createdAt:demoIso(-3,14,20)}
  ];
  const calendarEvents=[
    {id:'demo-cal-1',title:'Investor Prep With Elena',summary:'Investor Prep With Elena',startTime:demoIso(0,9,30),endTime:demoIso(0,10,15),source:'google',calendarName:'Google Calendar',attendees:[{name:'Elena Brooks',email:'elena@northstarcapital.com'},{name:'Avery Stone',email:'avery@demo.val'}],description:'Review traction, proposal terms, and investor follow-up.'},
    {id:'demo-cal-2',title:'Enterprise Demo With Marcus',summary:'Enterprise Demo With Marcus',startTime:demoIso(0,14,0),endTime:demoIso(0,15,0),source:'ghl',calendarName:'Sales Calendar',attendees:[{name:'Marcus Chen',email:'marcus@atlasops.com'},{name:'Nina Patel',email:'nina@atlasops.com'}],description:'Atlas Operations wants a workflow demo and buying-process discussion.'},
    {id:'demo-cal-3',title:'HealthBridge Renewal Review',summary:'HealthBridge Renewal Review',startTime:demoIso(1,11,0),endTime:demoIso(1,11,45),source:'google',calendarName:'Google Calendar',attendees:[{name:'Priya Raman',email:'priya@healthbridge.org'}],description:'Renewal health, implementation load, and expansion potential.'},
    {id:'demo-cal-4',title:'Retro Partnership Notes',summary:'Retro Partnership Notes',startTime:demoIso(-1,16,30),endTime:demoIso(-1,17,0),source:'val',calendarName:'VAL Retroactive Meetings',attendees:[{name:'Jordan Lee',email:'jordan@fieldstone.co'}],metadata:{retroactive:true,transcriptId:'demo-tr-1'}}
  ];
  const opportunities=[
    {id:'demo-opp-1',name:'Atlas Operations Pilot',status:'open',stage:'Proposal Review',value:48000,contactName:'Marcus Chen',contactId:'demo-contact-1',contactEmail:'marcus@atlasops.com',contactPhone:'555-0147',owner:'Avery Stone',updatedAt:demoIso(-3,12,0),daysInStage:9,stalled:false,notes:['Marcus liked the automation demo but needs procurement owner confirmed.','Nina asked about onboarding load and executive reporting.','Next best move: send a 3-point pilot memo and ask who signs vendor approval.']},
    {id:'demo-opp-2',name:'Northstar Capital Advisory',status:'open',stage:'Warm Intro',value:85000,contactName:'Elena Brooks',contactId:'demo-contact-2',contactEmail:'elena@northstarcapital.com',contactPhone:'555-0188',owner:'Avery Stone',updatedAt:demoIso(-1,15,0),daysInStage:2,stalled:false,notes:['Elena requested a tighter scope and proof of executive adoption.','She mentioned two portfolio founders who may need VAL.']},
    {id:'demo-opp-3',name:'HealthBridge Expansion',status:'open',stage:'Renewal Risk',value:32000,contactName:'Priya Raman',contactId:'demo-contact-3',contactEmail:'priya@healthbridge.org',contactPhone:'555-0191',owner:'Avery Stone',updatedAt:demoIso(-20,10,0),daysInStage:20,stalled:true,notes:['Implementation team feels stretched. Sponsor still values the outcome.','Do not push expansion until support load is acknowledged.']},
    {id:'demo-opp-4',name:'Fieldstone Partner Channel',status:'open',stage:'Discovery',value:120000,contactName:'Jordan Lee',contactId:'demo-contact-4',contactEmail:'jordan@fieldstone.co',contactPhone:'555-0128',owner:'Avery Stone',updatedAt:demoIso(-8,9,0),daysInStage:8,stalled:false,notes:['Jordan can introduce VAL to three operating partners. Needs a crisp referral ask.']}
  ];
  const conversations=[
    {id:'demo-conv-1',contactName:'Marcus Chen',contactId:'demo-contact-1',unread:3,unreadCount:3,lastMessage:'Can you send the pilot memo before our 2 PM call?',lastMessageBody:'Can you send the pilot memo before our 2 PM call?',type:'sms',source:'ghl'},
    {id:'demo-conv-2',contactName:'Elena Brooks',contactId:'demo-contact-2',unread:1,unreadCount:1,lastMessage:'The scope looks close. Can you make the first 30 days clearer?',lastMessageBody:'The scope looks close. Can you make the first 30 days clearer?',type:'email',source:'ghl'},
    {id:'demo-conv-3',contactName:'Jordan Lee',contactId:'demo-contact-4',unread:2,unreadCount:2,lastMessage:'Happy to intro you, just send me the tight version.',lastMessageBody:'Happy to intro you, just send me the tight version.',type:'email',source:'ghl'}
  ];
  const messages={
    'demo-conv-1':[
      {id:'m1',direction:'inbound',from:'Marcus Chen',body:'Can you send the pilot memo before our 2 PM call?',dateAdded:demoIso(0,8,42),type:'sms'},
      {id:'m2',direction:'inbound',from:'Marcus Chen',body:'Main question from my side is who owns procurement and how heavy onboarding gets.',dateAdded:demoIso(0,8,44),type:'sms'}
    ],
    'demo-conv-2':[
      {id:'m3',direction:'inbound',from:'Elena Brooks',body:'The scope looks close. Can you make the first 30 days clearer?',dateAdded:demoIso(0,7,58),type:'email'}
    ],
    'demo-conv-3':[
      {id:'m4',direction:'inbound',from:'Jordan Lee',body:'Happy to intro you, just send me the tight version.',dateAdded:demoIso(-1,17,12),type:'email'},
      {id:'m5',direction:'inbound',from:'Jordan Lee',body:'The ask should be one paragraph max.',dateAdded:demoIso(-1,17,13),type:'email'}
    ]
  };
  const drafts=[
    {id:'demo-draft-1',userId:'demo-user',tenantId:'demo-val',draftType:'follow_up',contactId:'demo-contact-2',provider:'internal',subject:'Revised VAL scope',body:'Elena,\n\nI tightened the first 30 days into three phases: context capture, operating rhythm, and executive visibility.\n\nThe main outcome is simple: fewer dropped promises, cleaner follow-through, and a leadership layer that keeps momentum visible.\n\nAvery',status:'draft',sourceContext:{source:'demo'},createdAt:demoIso(0,8,25),updatedAt:demoIso(0,8,25)},
    {id:'demo-draft-2',userId:'demo-user',tenantId:'demo-val',draftType:'email_reply',contactId:'demo-contact-1',provider:'internal',subject:'Pilot memo for today',body:'Marcus,\n\nHere is the short version for today: VAL can start with the two highest-friction workflows, show measurable follow-up capture, and keep onboarding light enough that your team does not need another system to manage.\n\nAvery',status:'draft',sourceContext:{source:'demo'},createdAt:demoIso(0,8,40),updatedAt:demoIso(0,8,40)}
  ];
  const emails=[
    {provider:'gmail',messageId:'demo-email-1',threadId:'demo-thread-1',subject:'Pilot memo before 2 PM',from:{name:'Marcus Chen',email:'marcus@atlasops.com'},snippet:'Can you send the pilot memo before our 2 PM call?',bodyPreview:'Can you send the pilot memo before our 2 PM call? Procurement and onboarding are the main questions.',classification:'needs_reply',confidence:'high',reason:'Time-sensitive meeting prep and a direct request.',recommendedAction:'Draft reply',matchedContact:{name:'Marcus Chen'}},
    {provider:'gmail',messageId:'demo-email-2',threadId:'demo-thread-2',subject:'Scope clarification',from:{name:'Elena Brooks',email:'elena@northstarcapital.com'},snippet:'Can you make the first 30 days clearer?',bodyPreview:'The scope looks close. Can you make the first 30 days clearer?',classification:'needs_reply',confidence:'high',reason:'Active opportunity, asks for revision.',recommendedAction:'Draft reply',matchedContact:{name:'Elena Brooks'}},
    {provider:'outlook',messageId:'demo-email-3',threadId:'demo-thread-3',subject:'Intro language',from:{name:'Jordan Lee',email:'jordan@fieldstone.co'},snippet:'Happy to intro you, just send me the tight version.',bodyPreview:'Happy to intro you, just send me the tight version. The ask should be one paragraph max.',classification:'needs_attention',confidence:'high',reason:'Warm intro opportunity that could go stale.',recommendedAction:'Create outreach draft',matchedContact:{name:'Jordan Lee'}},
    {provider:'gmail',messageId:'demo-email-4',threadId:'demo-thread-4',subject:'Following up on renewal',from:{name:'Priya Raman',email:'priya@healthbridge.org'},snippet:'Let’s revisit after the internal support conversation.',bodyPreview:'Let’s revisit after the internal support conversation.',classification:'waiting_on_response',confidence:'medium',reason:'Renewal risk and delayed internal conversation.',recommendedAction:'Track follow-up',matchedContact:{name:'Priya Raman'}}
  ];
  const transcripts=[
    {id:'demo-tr-1',type:'processed_transcript',title:'Retro Partnership Notes',rawText:'Jordan offered to introduce Avery to three operating partners if Avery sends a concise one-paragraph referral ask. Jordan emphasized that the ask should not sound like a pitch deck. Action item: send tight intro language.',metadata:{source:'demo'},createdAt:demoIso(-1,17,0)}
  ];
  const relationships=[
    {name:'Marcus Chen',email:'marcus@atlasops.com',score:92,priority:'high',recommendedAction:'Send pilot memo before the 2 PM demo and ask who owns procurement.',why:'High-value active opportunity, time-sensitive meeting, direct request sitting unread.',lastInteraction:demoIso(0,8,44),openLoops:['Pilot memo','Procurement owner','Onboarding concern'],evidence:[{type:'email',summary:'Asked for pilot memo before 2 PM.'},{type:'opportunity',summary:'Atlas Operations Pilot in Proposal Review.'}],draftOutreach:{subject:'Pilot memo for today',body:'Marcus, here is the concise pilot path for today...'}},
    {name:'Elena Brooks',email:'elena@northstarcapital.com',score:88,priority:'high',recommendedAction:'Send the revised first-30-days scope.',why:'Investor-adjacent relationship with two possible portfolio referrals.',lastInteraction:demoIso(0,7,58),openLoops:['Revised scope','Portfolio founder referrals'],evidence:[{type:'meeting',summary:'Investor prep today.'},{type:'draft',summary:'Draft waiting in approval queue.'}]},
    {name:'Priya Raman',email:'priya@healthbridge.org',score:74,priority:'medium',recommendedAction:'Acknowledge implementation fatigue before discussing expansion.',why:'Renewal value is real, but sponsor fatigue is showing in notes.',lastInteraction:demoIso(-2,15,10),openLoops:['Renewal risk','Support load'],evidence:[{type:'note',summary:'Implementation team feels stretched.'}]},
    {name:'Jordan Lee',email:'jordan@fieldstone.co',score:81,priority:'high',recommendedAction:'Send one-paragraph referral ask today.',why:'Warm intro offer is fresh and easy to lose if delayed.',lastInteraction:demoIso(-1,17,13),openLoops:['Intro language'],evidence:[{type:'transcript',summary:'Jordan offered three operating partner introductions.'}]}
  ];
  return {tasks,calendarEvents,opportunities,conversations,messages,drafts,emails,transcripts,relationships,createdAt:new Date().toISOString()};
}
function demoSessionId(req,res){
  const existing=parseCookies(req).val_demo_session;
  const id=existing || crypto.randomBytes(12).toString('hex');
  if(!existing) res.cookie('val_demo_session',id,{httpOnly:true,sameSite:'lax',secure:false,maxAge:60*60*1000});
  return id;
}
function demoState(req,res){
  const id=demoSessionId(req,res);
  if(!demoSessions.has(id)) demoSessions.set(id,cloneDemo(demoTemplate()));
  return demoSessions.get(id);
}
function resetDemoState(req,res){
  const id=demoSessionId(req,res);
  const state=cloneDemo(demoTemplate());
  demoSessions.set(id,state);
  return state;
}
function demoUser(){
  return {id:'demo-user',email:'demo@graceintelligence.com',name:'Demo User',role:'demo'};
}
function withDemoCta(text){
  const copy=String(text||'');
  return copy.includes(VAL_SIGNUP_URL) ? copy : `${copy}\n\nReady to make this yours? Get your VAL now: ${VAL_SIGNUP_URL}`;
}
function demoLeads(body={}){
  const type=String(body.organizationType||body.criteria||'growth companies').replace(/\s+/g,' ').trim();
  const market=String(body.market||body.location||'United States').trim();
  const limit=Math.min(Math.max(Number(body.limit)||6,1),12);
  return [
    {organizationName:'Beacon Field Services',website:'https://example.com/beacon',industry:'Field Operations',primaryService:'Multi-site service operations',location:market,organizationType:type,partnerFit:'Strong',approximateDonors:640,donorEstimateBasis:'Public team pages, hiring posts, multi-location signals',evidenceSignals:['Active hiring','Multiple locations','Visible operations team'],decisionMakerName:'Dana Holt',decisionMakerTitle:'COO',email:'dana.holt@example.com',phone:'555-0201',linkedinPersonalUrl:'https://linkedin.com/in/demo-dana-holt',linkedinCompanyUrl:'https://linkedin.com/company/demo-beacon',hiringActivity:'Yes, operations and customer success roles',careersPage:'Yes',growthActivity:'Expansion into two new markets',operationalActivity:'Dispatch, service teams, account management',operationalIndicators:'Multi-location, recurring client operations',googleRaw:'4.6 rating, 128 reviews, active listing',newsRaw:'Recent market expansion announcement',nextOutreachAngle:'Operational visibility and follow-through at scale',confidence:'high',rocketReachStatus:'verified demo email'},
    {organizationName:'Atlas People Systems',website:'https://example.com/atlas-people',industry:'Workforce Services',primaryService:'HR and operations support',location:market,organizationType:type,partnerFit:'Strong',approximateDonors:420,donorEstimateBasis:'Hiring volume, leadership page, service footprint',evidenceSignals:['Leadership team visible','Hiring posts','Enterprise service model'],decisionMakerName:'Marcus Chen',decisionMakerTitle:'VP Operations',email:'marcus.chen@example.com',phone:'555-0202',linkedinPersonalUrl:'https://linkedin.com/in/demo-marcus-chen',linkedinCompanyUrl:'https://linkedin.com/company/demo-atlas-people',hiringActivity:'Yes',careersPage:'Yes',growthActivity:'New enterprise accounts',operationalActivity:'Client delivery pods and support teams',operationalIndicators:'CRM-heavy, recurring delivery, cross-functional follow-up',googleRaw:'Active website and company listing',newsRaw:'No recent news found',nextOutreachAngle:'Reduce dropped follow-up across account teams',confidence:'high',rocketReachStatus:'verified demo email'},
    {organizationName:'Northline Benefits Group',website:'https://example.com/northline',industry:'Benefits Advisory',primaryService:'Employer benefits and advisory services',location:market,organizationType:type,partnerFit:'Moderate',approximateDonors:310,donorEstimateBasis:'Team page and LinkedIn size indicators',evidenceSignals:['Professional services team','Multiple advisors','Client onboarding complexity'],decisionMakerName:'Renee Wallace',decisionMakerTitle:'Founder',email:'renee.wallace@example.com',phone:'555-0203',linkedinPersonalUrl:'https://linkedin.com/in/demo-renee-wallace',linkedinCompanyUrl:'https://linkedin.com/company/demo-northline',hiringActivity:'Unclear',careersPage:'No',growthActivity:'Client growth signals on website',operationalActivity:'Advisor follow-up and renewal cycles',operationalIndicators:'Relationship-heavy, renewal-sensitive',googleRaw:'Business listing found',newsRaw:'No recent news found',nextOutreachAngle:'Protect renewal conversations and owner promises',confidence:'medium',rocketReachStatus:'verified demo email'}
  ].slice(0,limit).map((lead,i)=>({...lead,organizationName:i>2?`${lead.organizationName} ${i+1}`:lead.organizationName}));
}
function demoLeadDiscovery(body={}){
  const market=String(body.market||body.location||'United States');
  const organizationType=String(body.organizationType||'growth companies');
  const employeeMinimum=donorValue(body.employeeMinimum)||300;
  const tag=normalizeLeadTag(body.tag||organizationType);
  const leads=demoLeads(body);
  return {ok:true,market,criteria:String(body.criteria||`${organizationType} with at least ${employeeMinimum} employees`),organizationType,employeeMinimum,tag,scraped:{configured:true,rawCount:leads.length,demo:true},rocketReachMode:'review',leads};
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

async function gh(){
  return ghlMcp.headers();
}
async function prepareGhlRequest(path,body){
  return ghlMcp.prepare(path,body);
}
async function ghl(method,path,body){
  return ghlMcp.request(method,path,body);
}
async function ghlStrict(method,path,body){
  return ghlMcp.requestStrict(method,path,body);
}
async function readJsonResponse(response){
  const text = await response.text();
  try{ return text ? JSON.parse(text) : {}; }
  catch(e){ return {raw:text}; }
}

async function ghlTry(method,path,body){
  return ghlMcp.requestTry(method,path,body);
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
  return readJson(STORE_FILE,{conversations:[],messages:[],transcripts:[],memoryItems:[],oauthTokens:{},users:[],sessions:[]});
}
function saveValStore(store){ writeJson(STORE_FILE,store); }
function uuid(prefix){
  return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
}
function parseCookies(req){
  return String(req.headers.cookie||'').split(';').reduce((acc,part)=>{
    const i=part.indexOf('=');
    if(i>0) acc[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim());
    return acc;
  },{});
}
function signValue(value){
  return crypto.createHmac('sha256',SESSION_SECRET).update(value).digest('hex');
}
function signedSessionValue(sessionId){
  return `${sessionId}.${signValue(sessionId)}`;
}
function verifySignedSession(value){
  const [sessionId,sig]=String(value||'').split('.');
  if(!sessionId||!sig) return '';
  const expected=signValue(sessionId);
  try{
    return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)) ? sessionId : '';
  }catch(e){return '';}
}
function setSessionCookie(res,sessionId){
  const secure=process.env.NODE_ENV==='production' || !!process.env.RAILWAY_PUBLIC_DOMAIN;
  res.setHeader('Set-Cookie',`${SESSION_COOKIE}=${encodeURIComponent(signedSessionValue(sessionId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*14}${secure?'; Secure':''}`);
}
function clearSessionCookie(res){
  res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
async function hashPassword(password){
  return `bcrypt:${await bcrypt.hash(String(password||''),12)}`;
}
function hashLegacyPassword(password,salt=crypto.randomBytes(16).toString('hex')){
  const hash=crypto.scryptSync(String(password||''),salt,64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
async function verifyPassword(password,stored){
  if(String(stored||'').startsWith('bcrypt:')) return bcrypt.compare(String(password||''),String(stored).slice(7));
  const [kind,salt,hash]=String(stored||'').split(':');
  if(kind!=='scrypt'||!salt||!hash) return false;
  const candidate=hashLegacyPassword(password,salt).split(':')[2];
  try{return crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(hash,'hex'));}
  catch(e){return false;}
}
function passwordSetupToken(){
  return crypto.randomBytes(32).toString('base64url');
}
function hashPasswordSetupToken(token){
  return crypto.createHash('sha256').update(String(token||'')).digest('hex');
}
function passwordSetupUrl(token){
  const base=CLIENT_CONFIG.publicBaseUrl ? CLIENT_CONFIG.publicBaseUrl.replace(/\/$/,'') : '';
  return `${base}/set-password?token=${encodeURIComponent(token)}`;
}
function publicUser(user){
  if(!user) return null;
  return {id:user.id,email:user.email,name:user.name,role:user.role||'owner'};
}
async function seedAdminUser(){
  const email=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
  const password=String(process.env.ADMIN_PASSWORD||'');
  if(!email||!password) return;
  const name=process.env.ADMIN_NAME || CLIENT_CONFIG.clientName || 'VAL Admin';
  const role=process.env.ADMIN_ROLE || 'owner';
  if(pgPool){
    const exists=await dbQuery('select id from val_users where lower(email)=lower($1) limit 1',[email]);
    if(exists&&exists.rows&&exists.rows.length) return;
    await dbQuery('insert into val_users (id,client_slug,tenant_id,name,email,password_hash,password_set_at,role) values ($1,$2,$3,$4,$5,$6,now(),$7)',[uuid('usr'),CLIENT_CONFIG.clientSlug,CLIENT_CONFIG.clientSlug,name,email,await hashPassword(password),role]);
    console.log('Seeded VAL admin user:',email);
    return;
  }
  const store=valStore();
  store.users=store.users||[];
  if(store.users.some(u=>String(u.email||'').toLowerCase()===email)) return;
  store.users.push({id:uuid('usr'),clientSlug:CLIENT_CONFIG.clientSlug,tenantId:CLIENT_CONFIG.clientSlug,name,email,passwordHash:await hashPassword(password),passwordSetAt:new Date().toISOString(),role,createdAt:new Date().toISOString()});
  saveValStore(store);
}
async function findUserByEmail(email){
  const normalized=String(email||'').trim().toLowerCase();
  if(!normalized) return null;
  if(pgPool){
    const r=await dbQuery('select * from val_users where lower(email)=lower($1) limit 1',[normalized]);
    const row=r&&r.rows&&r.rows[0];
    return row?{id:row.id,email:row.email,name:row.name,role:row.role,passwordHash:row.password_hash,passwordSetAt:row.password_set_at}:null;
  }
  const user=(valStore().users||[]).find(u=>String(u.email||'').toLowerCase()===normalized);
  return user?{id:user.id,email:user.email,name:user.name,role:user.role,passwordHash:user.passwordHash,passwordSetAt:user.passwordSetAt}:null;
}
async function storePasswordSetupToken(userId,tokenHash,expiresAt){
  if(pgPool){
    await dbQuery('update val_users set password_reset_token_hash=$1,password_reset_expires_at=$2,updated_at=now() where id=$3',[tokenHash,expiresAt,userId]);
    return;
  }
  const store=valStore();
  const user=(store.users||[]).find(u=>u.id===userId);
  if(user){
    user.passwordResetTokenHash=tokenHash;
    user.passwordResetExpiresAt=expiresAt;
    user.updatedAt=new Date().toISOString();
    saveValStore(store);
  }
}
async function findUserByPasswordSetupToken(token){
  const tokenHash=hashPasswordSetupToken(token);
  if(pgPool){
    const r=await dbQuery('select * from val_users where password_reset_token_hash=$1 and password_reset_expires_at>now() limit 1',[tokenHash]);
    const row=r&&r.rows&&r.rows[0];
    return row?{id:row.id,email:row.email,name:row.name,role:row.role,passwordHash:row.password_hash,passwordSetAt:row.password_set_at}:null;
  }
  const user=(valStore().users||[]).find(u=>u.passwordResetTokenHash===tokenHash&&new Date(u.passwordResetExpiresAt||0).getTime()>Date.now());
  return user?{id:user.id,email:user.email,name:user.name,role:user.role,passwordHash:user.passwordHash,passwordSetAt:user.passwordSetAt}:null;
}
async function setUserPassword(userId,passwordHash){
  if(pgPool){
    await dbQuery('update val_users set password_hash=$1,password_set_at=now(),password_reset_token_hash=null,password_reset_expires_at=null,updated_at=now() where id=$2',[passwordHash,userId]);
    return;
  }
  const store=valStore();
  const user=(store.users||[]).find(u=>u.id===userId);
  if(user){
    user.passwordHash=passwordHash;
    user.passwordSetAt=new Date().toISOString();
    user.passwordResetTokenHash=null;
    user.passwordResetExpiresAt=null;
    user.updatedAt=new Date().toISOString();
    saveValStore(store);
  }
}
function currentValUser(){
  return requestContext.getStore()?.user || null;
}
function currentUserId(){
  return currentValUser()?.id || VAL_USER_ID;
}
function tenantId(){
  return CLIENT_CONFIG.clientSlug || 'default';
}
function transcriptWebhookToken(){
  return process.env.TRANSCRIPT_WEBHOOK_TOKEN || crypto.createHmac('sha256',SESSION_SECRET).update(`transcript:${tenantId()}`).digest('hex').slice(0,48);
}
function isValidTranscriptWebhookReq(req){
  const token=String(req.query.token||req.headers['x-val-transcript-token']||'');
  const expected=transcriptWebhookToken();
  if(!token||!expected)return false;
  try{return crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected));}
  catch(e){return false;}
}
function requestBaseUrl(req){
  return (CLIENT_CONFIG.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/,'');
}
function transcriptWebhookInfo(req){
  const base=requestBaseUrl(req);
  const token=transcriptWebhookToken();
  return {
    ok:true,
    live:true,
    status:'live',
    clientName:CLIENT_CONFIG.clientName,
    clientSlug:CLIENT_CONFIG.clientSlug,
    method:'POST',
    url:`${base}/api/val/transcripts?token=${encodeURIComponent(token)}`,
    headerUrl:`${base}/api/val/transcripts`,
    pingUrl:`${base}/api/val/transcripts/ping?token=${encodeURIComponent(token)}`,
    headerName:'X-VAL-Transcript-Token',
    headerToken:token,
    contentType:'application/json',
    processDefault:true,
    recent30DaysCount:0,
    matchedToMeetings30DaysCount:0,
    lastReceivedAt:null,
    lastTranscriptTitle:'',
    message:'Webhook is live. Send POST requests with JSON to this URL from a transcriber, Make.com, Zapier, or any tool that can call a webhook.',
    acceptedTranscriptFields:['transcript','rawText','text'],
    samplePayload:{
      title:'Meeting with Contact Name',
      transcript:'Full transcript text here...',
      source:'transcription_app',
      timestamp:new Date().toISOString(),
      process:true,
      metadata:{eventTitle:'Calendar event title',contactEmail:'contact@example.com'}
    }
  };
}
function encryptionKeyBuffer(){
  const raw=String(process.env.ENCRYPTION_KEY||'').trim();
  if(!raw) return null;
  if(/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw,'hex');
  try{
    const b=Buffer.from(raw,'base64');
    if(b.length===32) return b;
  }catch(e){}
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptSecret(value){
  const key=encryptionKeyBuffer();
  if(!key) throw new Error('ENCRYPTION_KEY is required to save credentials');
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(String(value||''),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join(':');
}
function decryptSecret(value){
  const key=encryptionKeyBuffer();
  if(!key) throw new Error('ENCRYPTION_KEY is required to read saved credentials');
  const [version,ivRaw,tagRaw,dataRaw]=String(value||'').split(':');
  if(version!=='v1'||!ivRaw||!tagRaw||!dataRaw) return '';
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(ivRaw,'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw,'base64')),decipher.final()]).toString('utf8');
}
function maskSecret(value){
  const v=String(value||'');
  if(!v) return '';
  if(v.length<=8) return '••••';
  return `${v.slice(0,Math.min(4,v.length-4))}...${v.slice(-4)}`;
}
function normalizeCredentialRow(row){
  if(!row) return null;
  const meta=row.metadata_json||row.metadataJson||{};
  let masked='';
  try{ masked=maskSecret(decryptSecret(row.encrypted_value||row.encryptedValue)); }
  catch(e){ masked=row.encrypted_value||row.encryptedValue?'saved':''; }
  return {
    id:row.id,
    userId:row.user_id||row.userId||'',
    tenantId:row.tenant_id||row.tenantId||tenantId(),
    provider:row.provider,
    credentialType:row.credential_type||row.credentialType,
    maskedValue:masked,
    metadata:meta,
    status:row.status||'Not tested',
    lastTestedAt:row.last_tested_at||row.lastTestedAt||null,
    createdAt:row.created_at||row.createdAt||null,
    updatedAt:row.updated_at||row.updatedAt||null
  };
}
async function saveIntegrationCredential({userId,provider,credentialType,value,metadata={},status='Not tested'}){
  const id=uuid('cred');
  const encrypted=encryptSecret(value);
  const now=new Date().toISOString();
  if(pgPool){
    const r=await dbQuery(`
      insert into user_integration_credentials
        (id,user_id,tenant_id,provider,credential_type,encrypted_value,metadata_json,status,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
      on conflict (tenant_id,user_id,provider,credential_type)
      do update set encrypted_value=excluded.encrypted_value,metadata_json=excluded.metadata_json,status=excluded.status,updated_at=now()
      returning *
    `,[id,userId,tenantId(),provider,credentialType,encrypted,metadata,status]);
    return normalizeCredentialRow(r.rows[0]);
  }
  const store=valStore();
  store.integrationCredentials=store.integrationCredentials||[];
  let row=store.integrationCredentials.find(c=>c.tenantId===tenantId()&&c.userId===userId&&c.provider===provider&&c.credentialType===credentialType);
  if(!row){
    row={id,userId,tenantId:tenantId(),provider,credentialType,createdAt:now};
    store.integrationCredentials.push(row);
  }
  row.encryptedValue=encrypted;
  row.metadataJson=metadata;
  row.status=status;
  row.updatedAt=now;
  saveValStore(store);
  return normalizeCredentialRow(row);
}
async function listIntegrationCredentials(userId){
  if(pgPool){
    const r=await dbQuery(`
      select * from user_integration_credentials
      where tenant_id=$1 and (user_id=$2 or user_id is null)
      order by provider, credential_type
    `,[tenantId(),userId]);
    return (r.rows||[]).map(normalizeCredentialRow);
  }
  return (valStore().integrationCredentials||[])
    .filter(c=>c.tenantId===tenantId()&&(c.userId===userId||!c.userId))
    .map(normalizeCredentialRow);
}
async function deleteIntegrationCredential(id,userId){
  if(pgPool){
    await dbQuery('delete from user_integration_credentials where id=$1 and tenant_id=$2 and (user_id=$3 or user_id is null)',[id,tenantId(),userId]);
    return;
  }
  const store=valStore();
  store.integrationCredentials=(store.integrationCredentials||[]).filter(c=>!(c.id===id&&c.tenantId===tenantId()&&(c.userId===userId||!c.userId)));
  saveValStore(store);
}
async function getIntegrationCredential(provider,credentialType,userId=currentValUser()?.id){
  if(!userId) return null;
  if(pgPool){
    const r=await dbQuery(`
      select * from user_integration_credentials
      where tenant_id=$1 and provider=$2 and credential_type=$3 and (user_id=$4 or user_id is null)
      order by case when user_id=$4 then 0 else 1 end, updated_at desc
      limit 1
    `,[tenantId(),provider,credentialType,userId]);
    return r.rows?.[0]||null;
  }
  return (valStore().integrationCredentials||[])
    .filter(c=>c.tenantId===tenantId()&&c.provider===provider&&c.credentialType===credentialType&&(c.userId===userId||!c.userId))
    .sort((a,b)=>(a.userId===userId?-1:1))
    [0] || null;
}
async function resolveIntegrationSecret(provider,credentialType,fallback=''){
  const row=await getIntegrationCredential(provider,credentialType);
  if(row?.encrypted_value||row?.encryptedValue){
    try{return decryptSecret(row.encrypted_value||row.encryptedValue);}
    catch(e){
      console.error(`Credential read failed for ${provider}/${credentialType}:`,e.message);
    }
  }
  return fallback || '';
}
async function resolveOpenAIKey(){ return resolveIntegrationSecret('openai','api_key',OPENAI_KEY); }
async function resolveOpenAIModel(){
  return resolveIntegrationSecret('openai','preferred_model',OPENAI_CHAT_MODEL);
}
async function resolveGhlLocationId(){
  return resolveIntegrationSecret('ghl','location_id',GHL_LOC);
}
async function markCredentialStatus(provider,status){
  const user=currentValUser();
  if(!user) return;
  if(pgPool){
    await dbQuery('update user_integration_credentials set status=$1,last_tested_at=now(),updated_at=now() where tenant_id=$2 and user_id=$3 and provider=$4',[status,tenantId(),user.id,provider]);
    return;
  }
  const store=valStore();
  (store.integrationCredentials||[]).forEach(c=>{
    if(c.tenantId===tenantId()&&c.userId===user.id&&c.provider===provider){
      c.status=status;c.lastTestedAt=new Date().toISOString();c.updatedAt=new Date().toISOString();
    }
  });
  saveValStore(store);
}
async function createSession(userId){
  const id=uuid('sess');
  const expires=new Date(Date.now()+14*24*60*60*1000).toISOString();
  if(pgPool){
    await dbQuery('insert into val_sessions (id,user_id,client_slug,expires_at) values ($1,$2,$3,$4)',[id,userId,CLIENT_CONFIG.clientSlug,expires]);
  }else{
    const store=valStore();
    store.sessions=store.sessions||[];
    store.sessions.push({id,userId,clientSlug:CLIENT_CONFIG.clientSlug,expiresAt:expires});
    saveValStore(store);
  }
  return id;
}
async function getSessionUser(req){
  const signed=parseCookies(req)[SESSION_COOKIE];
  const sessionId=verifySignedSession(signed);
  if(!sessionId) return null;
  if(pgPool){
    const r=await dbQuery(`select u.id,u.email,u.name,u.role from val_sessions s join val_users u on u.id=s.user_id where s.id=$1 and s.expires_at>now() limit 1`,[sessionId]);
    return r&&r.rows&&r.rows[0]?publicUser(r.rows[0]):null;
  }
  const store=valStore();
  const session=(store.sessions||[]).find(s=>s.id===sessionId&&new Date(s.expiresAt).getTime()>Date.now());
  if(!session) return null;
  return publicUser((store.users||[]).find(u=>u.id===session.userId));
}
async function destroySession(req){
  const sessionId=verifySignedSession(parseCookies(req)[SESSION_COOKIE]);
  if(!sessionId) return;
  if(pgPool) await dbQuery('delete from val_sessions where id=$1',[sessionId]);
  else{
    const store=valStore();
    store.sessions=(store.sessions||[]).filter(s=>s.id!==sessionId);
    saveValStore(store);
  }
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
    create table if not exists drafts (
      id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      draft_type text not null default 'follow_up',
      contact_id text,
      provider text not null default 'internal',
      subject text,
      body text not null default '',
      status text not null default 'draft',
      source_context_json jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists meeting_transcript_links (
      id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      meeting_source text,
      meeting_event_id text,
      transcript_id text,
      confidence numeric,
      matched_reason text,
      created_at timestamptz not null default now(),
      unique (user_id,tenant_id,meeting_source,meeting_event_id,transcript_id)
    );
    create table if not exists val_calendar_events (
      id text primary key,
      user_id text not null default 'default',
      tenant_id text not null default 'default',
      source text not null default 'val',
      title text not null,
      start_time timestamptz,
      end_time timestamptz,
      attendees jsonb not null default '[]',
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_users (
      id text primary key,
      client_slug text not null default 'default',
      tenant_id text not null default 'default',
      name text,
      email text not null unique,
      password_hash text,
      password_set_at timestamptz,
      password_reset_token_hash text,
      password_reset_expires_at timestamptz,
      role text not null default 'owner',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists val_sessions (
      id text primary key,
      user_id text references val_users(id) on delete cascade,
      client_slug text not null default 'default',
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );
    create table if not exists user_integration_credentials (
      id text primary key,
      user_id text references val_users(id) on delete cascade,
      tenant_id text not null default 'default',
      provider text not null,
      credential_type text not null,
      encrypted_value text not null,
      metadata_json jsonb not null default '{}',
      status text not null default 'Not tested',
      last_tested_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id,user_id,provider,credential_type)
    );
    create table if not exists email_rules (
      id text primary key,
      user_id text,
      tenant_id text not null default 'default',
      provider text not null default 'any',
      rule_name text not null,
      rule_type text not null,
      conditions_json jsonb not null default '{}',
      actions_json jsonb not null default '{}',
      approval_mode text not null default 'review_only',
      confidence_threshold text not null default 'medium',
      is_active boolean not null default true,
      created_from text,
      created_from_message_id text,
      created_from_thread_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_used_at timestamptz,
      usage_count integer not null default 0
    );
    create table if not exists email_action_log (
      id text primary key,
      user_id text,
      tenant_id text not null default 'default',
      provider text not null,
      message_id text,
      thread_id text,
      action_type text not null,
      action_status text not null default 'suggested',
      acted_by text not null default 'val',
      rule_id text,
      details_json jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create index if not exists val_tasks_user_completed_idx on val_tasks(user_id,completed,due_date);
    create index if not exists val_messages_conversation_idx on val_messages(conversation_id,created_at);
    create index if not exists val_transcripts_user_created_idx on val_transcripts(user_id,created_at desc);
    create index if not exists val_memory_user_created_idx on val_memory_items(user_id,created_at desc);
    create index if not exists val_sessions_user_expires_idx on val_sessions(user_id,expires_at);
    create index if not exists user_integration_credentials_lookup_idx on user_integration_credentials(tenant_id,user_id,provider,credential_type);
    create index if not exists email_rules_lookup_idx on email_rules(tenant_id,user_id,is_active,rule_type);
    create index if not exists email_action_log_lookup_idx on email_action_log(tenant_id,user_id,action_type,created_at desc);
    create index if not exists drafts_lookup_idx on drafts(tenant_id,user_id,status,created_at desc);
    create index if not exists meeting_transcript_links_lookup_idx on meeting_transcript_links(tenant_id,user_id,meeting_event_id,created_at desc);
    create index if not exists val_calendar_events_lookup_idx on val_calendar_events(tenant_id,user_id,start_time desc);
  `);
  for(const table of ['val_tasks','val_conversations','val_transcripts','val_memory_items','val_oauth_tokens']){
    await dbQuery(`alter table ${table} add column if not exists client_slug text not null default 'default'`);
    await dbQuery(`alter table ${table} add column if not exists tenant_id text not null default 'default'`);
  }
  await dbQuery('alter table val_users alter column password_hash drop not null');
  await dbQuery('alter table val_users add column if not exists password_set_at timestamptz');
  await dbQuery('alter table val_users add column if not exists password_reset_token_hash text');
  await dbQuery('alter table val_users add column if not exists password_reset_expires_at timestamptz');
  await seedAdminUser();
  console.log('VAL Postgres store ready');
}
const valDbReady = initValDb().then(()=>seedAdminUser()).catch(e=>console.error('VAL DB init error:',e.message));

function loginHtml(){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CLIENT_CONFIG.brandName} Login</title><style>
  :root{color-scheme:dark;--navy:#14243a;--ink:#07111d;--cream:#f4efe5;--gold:#c9a45d}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,var(--navy),var(--ink));color:var(--cream);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  .card{width:min(420px,100%);border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.055);border-radius:14px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.28)}
  .brand{font-family:Georgia,serif;font-size:34px;letter-spacing:.08em;margin:0 0 6px}.sub{color:rgba(244,239,229,.68);line-height:1.5;margin:0 0 24px}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:var(--gold);margin:16px 0 8px}
  input{width:100%;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:var(--cream);border-radius:10px;padding:13px 14px;font-size:15px;outline:none}
  button{width:100%;margin-top:22px;border:1px solid rgba(201,164,93,.55);background:rgba(201,164,93,.18);color:var(--cream);border-radius:10px;padding:13px 14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  .linkbtn{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.06);margin-top:12px;color:rgba(244,239,229,.84)}
  .err{min-height:22px;color:#ffb4a8;margin-top:14px;font-size:14px;line-height:1.45}.msg{color:rgba(244,239,229,.78);font-size:14px;line-height:1.5;margin-top:14px}.setup{display:none;margin-top:20px;padding-top:18px;border-top:1px solid rgba(255,255,255,.12)}.setup a{color:var(--gold);word-break:break-all}
  </style></head><body><main class="card"><form id="loginForm"><h1 class="brand">${CLIENT_CONFIG.brandName}</h1><p class="sub">Sign in to your private VAL dashboard.</p><label>Email</label><input id="email" type="email" autocomplete="email" required><label>Password</label><input id="password" type="password" autocomplete="current-password" required><button type="submit">Enter VAL</button><button class="linkbtn" type="button" id="showSetup">First time here? Set your password.</button><div class="err" id="err"></div></form><section class="setup" id="setupBox"><p class="msg">Enter your email and VAL will create a secure setup link. For testing, the link appears here.</p><label>Account Email</label><input id="setupEmail" type="email" autocomplete="email"><button type="button" id="requestSetup">Create Setup Link</button><div class="msg" id="setupMsg"></div></section></main><script>
  const setupBox=document.getElementById('setupBox');
  const setupMsg=document.getElementById('setupMsg');
  function showSetupBox(){setupEmail.value=email.value||setupEmail.value;setupBox.style.display='block';}
  async function requestSetupLink(){
    setupMsg.textContent='Creating setup link...';
    const r=await fetch('/api/auth/request-password-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:setupEmail.value||email.value})});
    const d=await r.json().catch(()=>({}));
    setupMsg.innerHTML=(d.message||'If that email exists, a setup link has been created.')+(d.setupUrl?'<br><br><a href="'+d.setupUrl+'">'+d.setupUrl+'</a>':'');
  }
  document.getElementById('showSetup').addEventListener('click',showSetupBox);
  document.getElementById('requestSetup').addEventListener('click',requestSetupLink);
  document.getElementById('loginForm').addEventListener('submit',async function(e){
    e.preventDefault();document.getElementById('err').textContent='';
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value,password:password.value})});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.ok){location.href='/dashboard';return;}
    if(d.requiresPasswordSetup){document.getElementById('err').textContent=d.message||'Password setup required';showSetupBox();return;}
    document.getElementById('err').textContent=d.error||'Login failed';
  });
  </script></body></html>`;
}
function setPasswordHtml(){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set Password</title><style>
  :root{color-scheme:dark;--navy:#14243a;--ink:#07111d;--cream:#f4efe5;--gold:#c9a45d}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,var(--navy),var(--ink));color:var(--cream);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  .card{width:min(420px,100%);border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.055);border-radius:14px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.28)}
  h1{font-family:Georgia,serif;font-size:34px;letter-spacing:.04em;margin:0 0 8px}.sub{color:rgba(244,239,229,.68);line-height:1.5;margin:0 0 24px}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:var(--gold);margin:16px 0 8px}
  input{width:100%;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:var(--cream);border-radius:10px;padding:13px 14px;font-size:15px;outline:none}
  button{width:100%;margin-top:22px;border:1px solid rgba(201,164,93,.55);background:rgba(201,164,93,.18);color:var(--cream);border-radius:10px;padding:13px 14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  .err{min-height:22px;color:#ffb4a8;margin-top:14px;font-size:14px}.msg{color:rgba(244,239,229,.78);font-size:14px;line-height:1.5;margin-top:14px}
  </style></head><body><form class="card" id="setPasswordForm"><h1>Set Your Password</h1><p class="sub">Choose a password for your private VAL dashboard. Minimum 10 characters.</p><label>New Password</label><input id="password" type="password" autocomplete="new-password" minlength="10" required><label>Confirm Password</label><input id="confirmPassword" type="password" autocomplete="new-password" minlength="10" required><button type="submit">Save Password</button><div class="err" id="err"></div><div class="msg" id="msg"></div></form><script>
  const token=new URLSearchParams(location.search).get('token')||'';
  document.getElementById('setPasswordForm').addEventListener('submit',async function(e){
    e.preventDefault();err.textContent='';msg.textContent='';
    if(password.value.length<10){err.textContent='Password must be at least 10 characters.';return;}
    if(password.value!==confirmPassword.value){err.textContent='Passwords do not match.';return;}
    const r=await fetch('/api/auth/set-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:password.value})});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.ok){msg.textContent='Password saved. Opening VAL...';location.href='/dashboard';return;}
    err.textContent=d.error||'This setup link is invalid or expired.';
  });
  </script></body></html>`;
}
function isPublicPath(req){
  const p=req.path;
  if(p==='/api/val/transcripts'&&req.method==='POST'&&isValidTranscriptWebhookReq(req)) return true;
  if(p==='/api/val/transcripts/ping'&&req.method==='POST') return true;
  return p==='/api/health'||p==='/health'||p==='/login'||p==='/set-password'||p==='/api/auth/login'||p==='/api/auth/logout'||p==='/api/auth/me'||p==='/api/auth/request-password-setup'||p==='/api/auth/set-password'||p==='/auth/callback'||p==='/favicon.ico';
}
async function requireAuth(req,res,next){
  if(isPublicPath(req)) return next();
  if(DEMO_MODE){
    const user=demoUser();
    const state=demoState(req,res);
    req.valUser=user;
    return requestContext.run({user,demo:true,demoState:state},()=>next());
  }
  await valDbReady;
  const user=await getSessionUser(req);
  if(user){req.valUser=user;return requestContext.run({user},()=>next());}
  if(req.path.startsWith('/api/')) return res.status(401).json({ok:false,error:'Authentication required'});
  return res.redirect('/login');
}

// ── HEALTH ───────────────────────────────────────────────
async function statusPayload(){
  const ghlCreds=await ghlMcp.credentials().catch(()=>({apiKey:GHL_KEY,locationId:GHL_LOC}));
  return {
    status:'VAL Proxy OK',
    app:CLIENT_CONFIG.clientSlug,
    time:new Date().toISOString(),
    client:CLIENT_CONFIG,
    config:{
      ghlConfigured:!!(ghlCreds.apiKey&&ghlCreds.locationId),
      ghlMissing:[ghlCreds.apiKey?'':'GHL_KEY/GHL_API_KEY',ghlCreds.locationId?'':'GHL_LOC/GHL_LOCATION_ID'].filter(Boolean),
      openAiConfigured:!!OPENAI_KEY,
      databaseConfigured:!!process.env.DATABASE_URL,
      googleConfigured:!!(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET),
      ghlCalendarMode:GHL_CALENDAR_IDS.length?'selected':'all',
      ghlCalendarCount:GHL_CALENDAR_IDS.length,
      demoMode:DEMO_MODE
    }
  };
}

app.get('/',async(req,res)=>{
  if(DEMO_MODE) return res.redirect('/guide');
  await valDbReady;
  const user=await getSessionUser(req);
  if(!user) return res.type('html').send(loginHtml());
  return res.sendFile(path.join(__dirname,'dashboard.html'));
});
app.get('/api/health',async(req,res)=>res.json(await statusPayload()));
app.get('/health',async(req,res)=>res.json(await statusPayload()));
app.get('/login',async(req,res)=>{
  if(DEMO_MODE) return res.redirect('/guide');
  await valDbReady;
  const user=await getSessionUser(req);
  if(user) return res.redirect('/dashboard');
  res.type('html').send(loginHtml());
});
app.get('/set-password',(req,res)=>{
  res.type('html').send(setPasswordHtml());
});
app.post('/api/auth/login',async(req,res)=>{
  await valDbReady;
  const user=await findUserByEmail(req.body.email);
  if(!user) return res.status(401).json({ok:false,error:'Invalid email or password'});
  if(!user.passwordHash) return res.status(403).json({ok:false,requiresPasswordSetup:true,message:'Password setup required'});
  if(!(await verifyPassword(req.body.password,user.passwordHash))) return res.status(401).json({ok:false,error:'Invalid email or password'});
  const sessionId=await createSession(user.id);
  setSessionCookie(res,sessionId);
  res.json({ok:true,user:publicUser(user)});
});
app.post('/api/auth/request-password-setup',async(req,res)=>{
  await valDbReady;
  const email=String(req.body.email||'').trim().toLowerCase();
  const generic={ok:true,message:'If that email exists, a setup link has been created.'};
  const user=await findUserByEmail(email);
  if(!user){
    if(email) console.log('Password setup requested for unknown email:',email);
    return res.json(generic);
  }
  const token=passwordSetupToken();
  const expiresAt=new Date(Date.now()+60*60*1000).toISOString();
  await storePasswordSetupToken(user.id,hashPasswordSetupToken(token),expiresAt);
  res.json({...generic,setupUrl:passwordSetupUrl(token),expiresAt});
});
app.post('/api/auth/set-password',async(req,res)=>{
  await valDbReady;
  const token=String(req.body.token||'');
  const password=String(req.body.password||'');
  if(!token) return res.status(400).json({ok:false,error:'Invalid or expired setup link'});
  if(password.length<10) return res.status(400).json({ok:false,error:'Password must be at least 10 characters'});
  const user=await findUserByPasswordSetupToken(token);
  if(!user) return res.status(400).json({ok:false,error:'Invalid or expired setup link'});
  await setUserPassword(user.id,await hashPassword(password));
  const sessionId=await createSession(user.id);
  setSessionCookie(res,sessionId);
  res.json({ok:true,user:publicUser(user)});
});
app.post('/api/auth/logout',async(req,res)=>{
  await destroySession(req);
  clearSessionCookie(res);
  res.json({ok:true});
});
app.get('/api/auth/me',async(req,res)=>{
  if(DEMO_MODE) return res.json({ok:true,user:demoUser(),demo:true});
  await valDbReady;
  const user=await getSessionUser(req);
  res.status(user?200:401).json(user?{ok:true,user}:{ok:false,error:'Authentication required'});
});
app.use(requireAuth);
app.use((req,res,next)=>{
  const bodyMeta=requestMetaFromBody(req.body||{});
  const routeMeta={
    route:req.path,
    routeJobSource:`${req.method} ${req.path}`,
    contactId:bodyMeta.contactId,
    transcriptId:bodyMeta.transcriptId,
    transcriptHash:bodyMeta.transcriptHash,
    requestReason:String(req.body?.reason||req.body?.action||req.body?.source||req.query?.reason||'').slice(0,160)
  };
  const ctx=requestContext.getStore();
  if(ctx){Object.assign(ctx,routeMeta);return next();}
  return requestContext.run(routeMeta,()=>next());
});
app.get('/api/config',(req,res)=>res.json({...CLIENT_CONFIG,demoMode:DEMO_MODE,signupUrl:VAL_SIGNUP_URL}));
app.get('/api/config/status',async(req,res)=>res.json(await statusPayload()));
app.get('/api/debug/openai-usage-summary',async(req,res)=>{
  try{
    const rows=await readOpenAiUsageRows({hours:24,limit:Number(req.query.limit)||10000});
    res.json({
      ok:true,
      windowHours:24,
      logFile:OPENAI_USAGE_LOG_FILE,
      totalCalls:rows.length,
      estimatedTotalCostUsd:Number(rows.reduce((sum,row)=>sum+(Number(row.estimatedCostUsd)||0),0).toFixed(6)),
      summary:summarizeOpenAiUsageRows(rows)
    });
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.post('/api/demo/reset',(req,res)=>res.json({ok:true,demo:true,state:resetDemoState(req,res)}));
app.get('/api/val/transcripts/webhook',async(req,res)=>{
  try{
    const [transcripts,matched]=await Promise.all([
      recentTranscripts(30).catch(()=>[]),
      countTranscriptMeetingLinks(30).catch(()=>0)
    ]);
    const latest=transcripts[0]||null;
    res.json({...transcriptWebhookInfo(req),recent30DaysCount:transcripts.length,matchedToMeetings30DaysCount:matched,lastReceivedAt:latest?.createdAt||'',lastTranscriptTitle:latest?.title||latest?.type||'',lastTranscriptId:latest?.id||''});
  }catch(e){res.status(500).json({ok:false,live:false,error:e.message});}
});
app.post('/api/val/transcripts/ping',(req,res)=>{
  if(!isValidTranscriptWebhookReq(req)) return res.status(401).json({ok:false,live:false,error:'Invalid or missing transcript webhook token'});
  res.json({ok:true,live:true,status:'live',clientName:CLIENT_CONFIG.clientName,clientSlug:CLIENT_CONFIG.clientSlug,receivedAt:new Date().toISOString(),message:'Transcript webhook is live. Use the transcript URL for real transcript payloads.'});
});
app.get('/api/integrations/credentials',async(req,res)=>{
  try{
    if(DEMO_MODE){
      return res.json({ok:true,credentials:[
        {id:'demo-openai',provider:'openai',credentialType:'api_key',maskedValue:'sk-...demo',status:'Connected',lastTestedAt:new Date().toISOString()},
        {id:'demo-ghl',provider:'ghl',credentialType:'api_key',maskedValue:'ghl-...demo',status:'Connected',lastTestedAt:new Date().toISOString()},
        {id:'demo-outs',provider:'outscraper',credentialType:'api_key',maskedValue:'out-...demo',status:'Connected',lastTestedAt:new Date().toISOString()},
        {id:'demo-rr',provider:'rocketreach',credentialType:'api_key',maskedValue:'rr-...demo',status:'Connected',lastTestedAt:new Date().toISOString()}
      ],oauth:{google:true,microsoft:true},demo:true});
    }
    const credentials=await listIntegrationCredentials(req.valUser.id);
    const oauth={
      google:!!(await loadOAuthTokens('google')),
      microsoft:!!(await loadOAuthTokens('microsoft'))
    };
    res.json({ok:true,credentials,oauth});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.post('/api/integrations/credentials',async(req,res)=>{
  try{
    const provider=String(req.body.provider||'').trim().toLowerCase();
    const allowed=new Set(['openai','ghl','outscraper','rocketreach','google_oauth','microsoft_oauth']);
    if(!allowed.has(provider)) return res.status(400).json({ok:false,error:'Unsupported provider'});
    if(DEMO_MODE) return res.json({ok:true,demo:true,credentials:[{id:`demo-${provider}`,provider,credentialType:'api_key',maskedValue:'...demo',status:'Connected',lastTestedAt:new Date().toISOString()}]});
    const fields=req.body.fields||{};
    const saved=[];
    async function save(type,value,metadata){
      if(String(value||'').trim()){
        saved.push(await saveIntegrationCredential({
          userId:req.valUser.id,
          provider,
          credentialType:type,
          value:String(value).trim(),
          metadata:metadata||{},
          status:'Not tested'
        }));
      }
    }
    if(provider==='openai'){
      await save('api_key',fields.apiKey||fields.key);
      await save('preferred_model',fields.preferredModel||fields.model);
    }else if(provider==='ghl'){
      await save('api_key',fields.apiKey||fields.accessToken||fields.key);
      await save('location_id',fields.locationId);
      await save('mcp_url',fields.mcpUrl);
    }else if(provider==='outscraper'){
      await save('api_key',fields.apiKey||fields.key);
    }else if(provider==='rocketreach'){
      await save('api_key',fields.apiKey||fields.key);
    }else{
      return res.status(400).json({ok:false,error:'Use OAuth connect buttons for Google or Microsoft'});
    }
    res.json({ok:true,credentials:saved});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.delete('/api/integrations/credentials/:id',async(req,res)=>{
  try{
    if(DEMO_MODE) return res.json({ok:true,demo:true,message:'Demo credential reset.'});
    await deleteIntegrationCredential(req.params.id,req.valUser.id);
    res.json({ok:true});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.post('/api/integrations/test/:provider',async(req,res)=>{
  const provider=String(req.params.provider||'').toLowerCase();
  try{
    if(DEMO_MODE) return res.json({ok:true,status:'Connected',message:`${provider} is connected in demo mode.`,demo:true});
    let ok=false, message='Not tested';
    if(provider==='openai'){
      const key=await resolveOpenAIKey();
      if(!key) throw new Error('OpenAI API key is missing');
      const r=await fetch('https://api.openai.com/v1/models',{headers:{Authorization:`Bearer ${key}`}});
      ok=r.ok; message=ok?'Connected':`Failed (${r.status})`;
    }else if(provider==='ghl'){
      const loc=await resolveGhlLocationId();
      const key=await resolveIntegrationSecret('ghl','api_key',GHL_KEY);
      if(!key||!loc) throw new Error('GHL API key and Location ID are required');
      const r=await ghlMcp.requestTry('GET',`/locations/${encodeURIComponent(loc)}`);
      ok=r.ok; message=ok?'Connected':`Failed (${r.status})`;
    }else if(provider==='outscraper'){
      const key=await resolveIntegrationSecret('outscraper','api_key',OUTSCRAPER_API_KEY);
      ok=!!key; message=ok?'Connected': 'Outscraper API key is missing';
    }else if(provider==='rocketreach'){
      const key=await resolveIntegrationSecret('rocketreach','api_key',ROCKETREACH_API_KEY);
      ok=!!key; message=ok?'Connected': 'RocketReach API key is missing';
    }else if(provider==='google_oauth'){
      ok=!!(await loadOAuthTokens('google')); message=ok?'Connected':'Not connected';
    }else if(provider==='microsoft_oauth'){
      ok=!!(await loadOAuthTokens('microsoft')); message=ok?'Connected':'Not connected';
    }else{
      return res.status(400).json({ok:false,error:'Unsupported provider'});
    }
    await markCredentialStatus(provider,ok?'Connected':'Failed');
    res.status(ok?200:400).json({ok,status:ok?'Connected':'Failed',message});
  }catch(e){
    await markCredentialStatus(provider,'Failed').catch(()=>{});
    res.status(500).json({ok:false,status:'Failed',error:e.message});
  }
});
app.delete('/api/integrations/oauth/:provider',async(req,res)=>{
  try{
    const provider=String(req.params.provider||'').toLowerCase();
    if(!['google','microsoft'].includes(provider)) return res.status(400).json({ok:false,error:'Unsupported OAuth provider'});
    if(pgPool) await dbQuery('delete from val_oauth_tokens where provider=$1',[provider]);
    else{
      const store=valStore();
      store.oauthTokens=store.oauthTokens||{};
      delete store.oauthTokens[provider];
      saveValStore(store);
    }
    if(provider==='google') googleTokens={};
    res.json({ok:true});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.get('/api/gmail/debug',async(req,res)=>{
  try{
    await ensureGoogleTokensLoaded();
    const errors=[];
    const scopes=googleScopeList();
    const missingScopes=missingGoogleScopes(REQUIRED_GMAIL_SCOPES);
    const token=await getGoogleToken();
    if(!token) errors.push(lastGoogleAuthError||'Google token missing');
    let profileEmail='', recentMessagesCount=0, unreadMessagesCount=0, sampleSubjects=[];
    if(token&&!missingScopes.includes('https://www.googleapis.com/auth/gmail.readonly')){
      const profileRes=await fetch('https://www.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token}`}});
      const profile=await readJsonResponse(profileRes);
      if(profileRes.ok) profileEmail=profile.emailAddress||'';
      else errors.push(profile.error?.message||`Gmail profile failed (${profileRes.status})`);
      const [recent,unread]=await Promise.all([
        fetchGmailMessages({query:'newer_than:7d',maxResults:10}),
        fetchGmailMessages({query:'is:unread',maxResults:10})
      ]);
      recentMessagesCount=(recent.emails||[]).length;
      unreadMessagesCount=(unread.emails||[]).length;
      sampleSubjects=(recent.emails||[]).slice(0,5).map(e=>e.subject||'(No subject)');
      if(recent.error) errors.push(recent.error);
      if(unread.error) errors.push(unread.error);
    }
    res.json({ok:!errors.length,profileEmail,scopes,missingScopes,recentMessagesCount,unreadMessagesCount,sampleSubjects,errors});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.get('/api/integrations/health',async(req,res)=>{
  try{
    const errors=[];
    await ensureGoogleTokensLoaded();
    const scopes=googleScopeList();
    const missingScopes=missingGoogleScopes();
    const hasRefreshToken=!!googleTokens.refresh_token;
    const token=await getGoogleToken();
    const refreshTest=token?'passed':'failed';
    if(!token) errors.push(lastGoogleAuthError||'Google auth required');
    const now=new Date();
    const past=new Date(now);past.setDate(past.getDate()-7);
    const future=new Date(now);future.setDate(future.getDate()+7);
    const [pastCal,nextCal,recentGmail,unreadGmail,transcripts]=await Promise.all([
      fetchGoogleCalendarEvents(past,now,100).catch(e=>{errors.push('Calendar past 7 days: '+e.message);return [];}),
      fetchGoogleCalendarEvents(now,future,100).catch(e=>{errors.push('Calendar next 7 days: '+e.message);return [];}),
      fetchGmailMessages({query:'newer_than:7d',maxResults:100}).catch(e=>({emails:[],error:e.message})),
      fetchGmailMessages({query:'is:unread',maxResults:100}).catch(e=>({emails:[],error:e.message})),
      recentTranscripts(7).catch(e=>{errors.push('Transcripts: '+e.message);return [];})
    ]);
    if(recentGmail.error) errors.push('Gmail recent: '+recentGmail.error);
    if(unreadGmail.error) errors.push('Gmail unread: '+unreadGmail.error);
    const matched=await countTranscriptMeetingLinks(7).catch(e=>{errors.push('Transcript links: '+e.message);return 0;});
    res.json({
      ok:!errors.length,
      google:{
        connected:!!token,
        hasRefreshToken,
        scopes,
        missingScopes,
        tokenExpiresAt:googleTokenExpiresAt(),
        refreshTest,
        calendar:{enabled:!!token,past7DaysCount:pastCal.length,next7DaysCount:nextCal.length},
        gmail:{enabled:!!token&&!missingScopes.includes('https://www.googleapis.com/auth/gmail.readonly'),unreadCount:(unreadGmail.emails||[]).length,recent7DaysCount:(recentGmail.emails||[]).length}
      },
      transcripts:{last7DaysCount:transcripts.length,matchedToMeetingsCount:matched},
      actions:{canCreateTasks:true,canCreateDrafts:true},
      errors
    });
  }catch(e){
    res.status(500).json({ok:false,error:e.message,errors:[e.message]});
  }
});
app.get('/api/email/intelligence',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const s=demoState(req,res), emails=s.emails||[];
      const buckets=emails.reduce((acc,email)=>{acc[email.classification]=(acc[email.classification]||0)+1;return acc;},{});
      return res.json({ok:true,needsAttention:emails.filter(e=>e.classification==='needs_attention'),needsReply:emails.filter(e=>e.classification==='needs_reply'),lowPriority:[],waitingOnResponse:emails.filter(e=>e.classification==='waiting_on_response'),draftSuggestions:emails.filter(e=>['needs_reply','appointment_recap_needed'].includes(e.classification)),providers:{gmail:{status:'connected',needsAuth:false,missingScopes:[],error:''},outlook:{status:'connected',needsAuth:false,error:''}},errors:[],emails,summary:{total:emails.length,buckets,draftsPrepared:2,waitingOnResponse:1,forwardingSuggestions:0,ignoredLowPriority:0,ruleSuggestions:2,savedRules:1},rules:[{id:'demo-rule-1',ruleName:'Draft replies for investor requests',ruleType:'draft_reply',isActive:true}]});
    }
    const rules=await listEmailRules(req.valUser.id);
    const limit=Number(req.query.limit)||20;
    const [gmail,outlook]=await Promise.all([
      fetchUnifiedGmailEmails(limit).catch(e=>({emails:[],needsAuth:/google auth/i.test(e.message),error:e.message,provider:'gmail'})),
      fetchUnifiedOutlookEmails(limit).catch(e=>({emails:[],needsAuth:true,error:e.message,provider:'outlook'}))
    ]);
    const emails=[...(gmail.emails||[]),...(outlook.emails||[])].map(email=>{
      const c=classifyEmail(email,rules);
      return {...email,...c,matchedRuleId:c.matchedRuleId||'',matchedContact:email.matchedContact||{}};
    });
    await Promise.all(emails.slice(0,20).map(email=>logEmailAction(req.valUser.id,{provider:email.provider,messageId:email.messageId,threadId:email.threadId,actionType:'classified',actionStatus:'suggested',actedBy:'val',ruleId:email.matchedRuleId,details:{classification:email.classification,confidence:email.confidence,reason:email.reason}}).catch(()=>{})));
    const buckets=emails.reduce((acc,email)=>{acc[email.classification]=(acc[email.classification]||0)+1;return acc;},{});
    const draftsPrepared=emails.filter(e=>e.classification==='needs_reply'||e.classification==='appointment_recap_needed').length;
    const waitingOnResponse=emails.filter(e=>e.classification==='waiting_on_response').length;
    const forwardingSuggestions=emails.filter(e=>e.classification==='forward_to_team').length;
    const ignoredLowPriority=emails.filter(e=>['ignored','low_priority','solicitation','spam_like'].includes(e.classification)).length;
    res.json({
      ok:true,
      needsAttention:emails.filter(e=>e.classification==='needs_attention'),
      needsReply:emails.filter(e=>e.classification==='needs_reply'),
      lowPriority:emails.filter(e=>['ignored','low_priority','solicitation','spam_like'].includes(e.classification)),
      waitingOnResponse:emails.filter(e=>e.classification==='waiting_on_response'),
      draftSuggestions:emails.filter(e=>e.classification==='needs_reply'||e.classification==='appointment_recap_needed'),
      providers:{gmail:{status:gmail.needsAuth?'reconnect_required':'connected',needsAuth:!!gmail.needsAuth,missingScopes:gmail.missingScopes||[],error:gmail.error||''},outlook:{needsAuth:!!outlook.needsAuth,error:outlook.error||'',status:outlook.needsAuth?'not_connected':'connected'}},
      errors:[gmail.error,outlook.error].filter(Boolean),
      emails,
      summary:{total:emails.length,buckets,draftsPrepared,waitingOnResponse,forwardingSuggestions,ignoredLowPriority,ruleSuggestions:0,savedRules:rules.filter(r=>r.isActive!==false).length},
      rules
    });
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.get('/api/email/rules',async(req,res)=>{
  try{res.json({ok:true,rules:await listEmailRules(req.valUser.id)});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/rules',async(req,res)=>{
  try{
    const rule=await saveEmailRule(req.valUser.id,req.body||{});
    await logEmailAction(req.valUser.id,{provider:rule.provider,actionType:'rule_created',actionStatus:'created',actedBy:'user',ruleId:rule.id,details:rule});
    res.json({ok:true,rule});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.patch('/api/email/rules/:id',async(req,res)=>{
  try{
    const rules=await listEmailRules(req.valUser.id);
    const existing=rules.find(r=>r.id===req.params.id);
    if(!existing)return res.status(404).json({ok:false,error:'Rule not found'});
    const rule=await saveEmailRule(req.valUser.id,{...existing,...req.body,id:req.params.id});
    res.json({ok:true,rule});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/actions',async(req,res)=>{
  try{
    const body=req.body||{};
    const action=String(body.actionType||body.action||'').trim();
    const email=body.email||{};
    const sensitive=/legal|hr|medical|financial|contract|complaint|confidential/i.test([email.subject,email.bodyPreview,email.bodyText].join(' '));
    const external=['send','forward','delete','archive','marked_read'].includes(action);
    const status=(external||sensitive)?'needs_approval':'prepared';
    const result={ok:true,status,requiresApproval:status==='needs_approval'};
    if(action==='drafted_reply'||action==='draft_reply'){
      result.draft={subject:'Re: '+(email.subject||''),body:`Hi ${email.from?.name||''},\n\nThank you for your note. I wanted to respond thoughtfully.\n\n[VAL draft: review and personalize before sending.]\n\nBest,`};
      result.internalDraft=await saveInternalDraft({draftType:'email_reply',provider:'internal',subject:result.draft.subject,body:result.draft.body,sourceContext:{source:'email_intelligence',messageId:email.messageId,threadId:email.threadId,from:email.from}});
    }else if(action==='forwarded'||action==='forward'){
      result.forwardDraft={to:body.forwardTo||'',subject:'Fwd: '+(email.subject||''),body:`VAL summary:\n${email.reason||'This may need review.'}\n\nOriginal email below.\n\nFrom: ${email.from?.email||''}\nSubject: ${email.subject||''}\n\n${email.bodyPreview||email.snippet||''}`};
      result.internalDraft=await saveInternalDraft({draftType:'email_forward',provider:'internal',subject:result.forwardDraft.subject,body:result.forwardDraft.body,sourceContext:{source:'email_intelligence',messageId:email.messageId,threadId:email.threadId,forwardTo:result.forwardDraft.to}});
    }else if(action==='followup_tracked'||action==='track_response'){
      result.followup={title:'Follow up on '+(email.subject||'email'),dueInBusinessDays:3};
      const due=new Date();due.setDate(due.getDate()+3);
      result.task={id:uuid('task'),title:result.followup.title,contactName:email.from?.name||email.from?.email||'',dueDate:due.toISOString(),notes:'Created from Email Intelligence waiting-on-response tracking.',details:[{text:'Source email: '+(email.subject||''),ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
      await saveTask(result.task);
    }else if(action==='task_created'||action==='add_task'){
      result.task={id:uuid('task'),title:'Review email: '+(email.subject||'(No subject)'),contactName:email.from?.name||email.from?.email||'',dueDate:null,notes:[email.reason||'',email.recommendedAction||'',email.bodyPreview||email.snippet||''].filter(Boolean).join('\n'),details:[{text:'Created from Email Intelligence',ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
      await saveTask(result.task);
    }
    await logEmailAction(req.valUser.id,{provider:email.provider,messageId:email.messageId,threadId:email.threadId,actionType:action||'suggested',actionStatus:status,actedBy:'user',ruleId:email.matchedRuleId||'',details:{email,body,result}});
    res.json(result);
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/automation-rule',async(req,res)=>{
  try{
    const email=req.body.email||{};
    const mode=req.body.mode||'auto_next_time';
    const action=req.body.action||email.recommendedAction||'label';
    const fromEmail=email.from?.email||'';
    const domain=fromEmail.split('@')[1]||'';
    let ruleType='label',conditions={},actions={action:'label',label:email.classification||'review'};
    if(mode==='ignore_sender'||mode==='ignore_domain'){
      ruleType=mode;conditions=mode==='ignore_domain'?{from_domain:domain}:{from_email:fromEmail};actions={action:'label',label:'low_priority'};
    }else if(/forward/i.test(action)){
      ruleType='forward_sender';conditions={from_email:fromEmail};actions={action:'forward',forward_to:req.body.forwardTo||'',include_summary:true,cc_user:false};
    }else if(/reply|draft/i.test(action)){
      ruleType='draft_reply';conditions={from_email:fromEmail};actions={action:'draft_reply'};
    }else if(/track/i.test(action)){
      ruleType='track_sent_followup';conditions={from_email:fromEmail||'',subject_contains:(email.subject||'').slice(0,80)};actions={action:'track_response',business_days:3};
    }
    if(!conditions.from_email&&!conditions.from_domain&&!conditions.subject_contains)return res.status(400).json({ok:false,error:'Rule trigger is too broad. Confirmation needs a specific sender, domain, or subject pattern.'});
    const rule=await saveEmailRule(req.valUser.id,{provider:email.provider||'any',ruleName:req.body.ruleName||`Auto ${ruleType} for ${conditions.from_email||conditions.from_domain||conditions.subject_contains}`,ruleType,conditions,actions,approvalMode:req.body.approvalMode||'always_auto',confidenceThreshold:'high',createdFrom:'user_confirmation',createdFromMessageId:email.messageId||'',createdFromThreadId:email.threadId||''});
    await logEmailAction(req.valUser.id,{provider:email.provider,messageId:email.messageId,threadId:email.threadId,actionType:'rule_created',actionStatus:'created',actedBy:'user',ruleId:rule.id,details:{rule}});
    res.json({ok:true,rule});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/email/rule-suggestions/analyze',async(req,res)=>{
  try{
    const actions=req.body.recentEmailActions||await recentEmailActions(req.valUser.id,200);
    const existing=req.body.existingRules||await listEmailRules(req.valUser.id);
    const suggestions=[];
    const forwardCounts={};
    const ignoreCounts={};
    actions.forEach(a=>{
      const d=a.details_json||a.details||{};
      const from=d.email?.from?.email||d.from_email||'';
      const forwardTo=d.body?.forwardTo||d.forward_to||'';
      if(from&&forwardTo)forwardCounts[from+'>'+forwardTo]=(forwardCounts[from+'>'+forwardTo]||0)+1;
      if(from&&['ignored','low_priority'].includes(d.classification||d.email?.classification))ignoreCounts[from]=(ignoreCounts[from]||0)+1;
    });
    Object.entries(forwardCounts).filter(([,n])=>n>=2).slice(0,5).forEach(([key,n])=>{
      const [from,to]=key.split('>');
      suggestions.push({suggestedRuleType:'forward_sender',plainEnglish:`I noticed you often forward emails from ${from} to ${to}.`,conditions:{from_email:from},actions:{action:'forward',forward_to:to,include_summary:true,cc_user:false},confidence:n>=3?'high':'medium',evidence:[`${n} similar forwarding actions`],confirmationQuestion:`Should VAL automatically forward future emails from ${from} to ${to}?`});
    });
    Object.entries(ignoreCounts).filter(([,n])=>n>=2).slice(0,5).forEach(([from,n])=>{
      suggestions.push({suggestedRuleType:'ignore_sender',plainEnglish:`You repeatedly ignore or downgrade emails from ${from}.`,conditions:{from_email:from},actions:{action:'label',label:'low_priority'},confidence:n>=3?'high':'medium',evidence:[`${n} ignored or low priority actions`],confirmationQuestion:`Should VAL move future emails from ${from} into low priority automatically?`});
    });
    res.json({ok:true,suggestions,existingRules:existing.length});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
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
.dash-float{position:fixed;right:18px;bottom:18px;z-index:20;box-shadow:0 18px 50px rgba(0,0,0,.32)}
.demo-banner{border:1px solid rgba(215,181,109,.35);background:rgba(215,181,109,.08);border-radius:12px;padding:14px 16px;margin-bottom:18px;color:var(--muted);display:${DEMO_MODE?'flex':'none'};gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.demo-banner strong{color:var(--text)}
</style></head><body><div class="top"><a href="/dashboard">Back to VAL</a></div><main class="wrap">
<a class="btn dash-float" href="/dashboard">Back To Dashboard</a>
<div class="demo-banner"><div><strong>Demo Mode</strong><br>Explore VAL with sample meetings, emails, tasks, relationships, drafts, transcripts, and pipeline data. Reset any time.</div><div class="actions"><a class="btn" href="${VAL_SIGNUP_URL}">Get Your VAL Now</a><button class="btn secondary" onclick="resetDemo()">Reset Demo</button></div></div>
<section class="hero"><div><div class="eyebrow">Velocity-Activated Leverage</div><h1>VAL</h1><p>Your executive operating layer. Never lose track of important people, promises, or opportunities again.</p><div class="actions"><a class="btn" href="/dashboard">Open Demo</a><a class="btn secondary" href="/dashboard">Run Relationship Review</a><a class="btn" href="${VAL_SIGNUP_URL}">Get Your VAL Now</a></div></div></section>
<section><div class="section-head"><div><h2>Your Priorities</h2><p>Start with the moves that create clarity fastest.</p></div></div><div class="grid">
<a class="card" href="/dashboard"><span class="icon">${icon.calendar}</span><h3>Prepare For Today</h3><p>Know who matters before your next conversation.</p><div class="status" id="meetingStatus">Loading meetings</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.radar}</span><h3>Relationship Review</h3><p>See who matters most, which relationships are cooling, and where hidden opportunity exists.</p><div class="status" id="radarStatus">Checking signals</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.stack}</span><h3>Approval Queue</h3><p>Review drafts, promises, and pending actions.</p><div class="status" id="queueStatus">Loading drafts</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.stack}</span><h3>Email Intelligence</h3><p>Find needed replies, waiting-on-response items, and safe draft opportunities.</p><div class="status">Review inbox signals</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.node}</span><h3>Integration Status</h3><p>Check Gmail, Calendar, transcripts, tasks, drafts, and missing permissions.</p><div class="status">Verify data pipes</div></a>
<a class="card" href="/dashboard"><span class="icon">${icon.node}</span><h3>Register Your Keys</h3><p>Securely add client-owned keys and connection details inside VAL.</p><div class="status">Encrypted setup</div></a>
</div></section>
<section><div class="section-head"><div><h2>Your First 3 Minutes</h2><p>A short path that helps VAL understand you and start creating momentum.</p></div></div><div class="journey"><div class="step"><span>Step 1</span><h3>Personalize VAL</h3><p>Tell VAL who you are, how you work, and what relationships drive your business.</p><a class="btn secondary" href="/dashboard">Personalize VAL</a></div><div class="step"><span>Step 2</span><h3>Review Today</h3><p>See meetings, priorities, and what needs your attention before the day gets noisy.</p><a class="btn secondary" href="/dashboard">Open Today View</a></div><div class="step"><span>Step 3</span><h3>Run Relationship Review</h3><p>Find the people, promises, and opportunities most likely to create value or lose trust if ignored.</p><a class="btn secondary" href="/dashboard">Run Relationship Review</a></div></div></section>
<section><div class="section-head"><div><h2>What Do You Want To Do?</h2><p>Choose by outcome, not by feature name.</p></div></div><div class="modes"><div class="mode"><h3>Stay Ahead</h3><a href="/dashboard">Meeting Prep</a><a href="/dashboard">Daily Rhythm</a><a href="/dashboard">Calendar Intelligence</a></div><div class="mode"><h3>Protect Relationships</h3><a href="/dashboard">Relationship Review</a><a href="/dashboard">Follow-Ups</a><a href="/dashboard">Contact Command Center</a></div><div class="mode"><h3>Clear Mental Load</h3><a href="/dashboard">Approval Queue</a><a href="/dashboard">Drafts</a><a href="/dashboard">Tasks By Relationship</a></div><div class="mode"><h3>Trust The System</h3><a href="/dashboard">Email Intelligence</a><a href="/dashboard">Integration Status</a><a href="/dashboard">Register Your Keys</a></div></div></section>
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
async function resetDemo(){await fetch('/api/demo/reset',{method:'POST'});location.href='/guide';}
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
app.get('/dashboard',(req,res)=>res.sendFile(path.join(__dirname,'dashboard.html')));

// ════════════════════════════════════════════════════════
// GOOGLE OAUTH
// ════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI         = process.env.GOOGLE_REDIRECT_URI || process.env.REDIRECT_URI || `${CLIENT_CONFIG.publicBaseUrl}/auth/callback`;
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose'
];
const REQUIRED_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose'
];
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
  const scopedTokens={...tokens,user_id:currentUserId(),tenant_id:tenantId(),client_slug:CLIENT_CONFIG.clientSlug};
  if(pgPool){
    await valDbReady;
    await dbQuery(`
      insert into val_oauth_tokens (provider,user_id,tokens,updated_at)
      values ($1,$2,$3,now())
      on conflict (provider) do update set tokens=excluded.tokens, updated_at=now()
    `,[provider,currentUserId(),JSON.stringify(scopedTokens)]);
  }else{
    const store=valStore();
    store.oauthTokens=store.oauthTokens||{};
    store.oauthTokens[provider]=scopedTokens;
    saveValStore(store);
  }
}

async function loadOAuthTokens(provider){
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select tokens from val_oauth_tokens where provider=$1 and (user_id=$2 or user_id=$3) order by case when user_id=$2 then 0 else 1 end limit 1',[provider,currentUserId(),VAL_USER_ID]);
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

function googleScopeList(tokens=googleTokens){
  return String(tokens?.scope||'').split(/\s+/).map(s=>s.trim()).filter(Boolean);
}
function missingGoogleScopes(required=REQUIRED_GMAIL_SCOPES,tokens=googleTokens){
  const scopes=new Set(googleScopeList(tokens));
  return required.filter(scope=>!scopes.has(scope));
}
function googleTokenExpiresAt(tokens=googleTokens){
  if(!tokens?.issued_at||!tokens?.expires_in) return '';
  return new Date(Number(tokens.issued_at)+Number(tokens.expires_in)*1000).toISOString();
}

// Step 1 — redirect user to Google consent screen
// ── IMAGE ANALYSIS (GPT-4o) ─────────────────────────────
app.post('/api/analyze-image',async(req,res)=>{
  try{
    const {base64,mediaType,prompt}=req.body;
    if(!base64||!mediaType) return res.status(400).json({error:'Missing base64 or mediaType'});
    const openAiKey=await resolveOpenAIKey();
    if(!openAiKey) return res.status(500).json({error:'OPENAI_KEY not configured'});
    const r=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
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
    await logOpenAiUsage({
      wrapper:'route:/api/analyze-image',
      model:'gpt-4o',
      estimatedInputTokens:approxTokens(prompt||'Analyze this image and give detailed feedback. What do you see, what\'s working well, and what could be improved?')+1100,
      estimatedOutputTokens:1000,
      responsePayload:d,
      requestId:r.headers.get('x-request-id')||'',
      retry:false,
      extra:{requestReason:'image_analysis'}
    });
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
    const openAiKey=await resolveOpenAIKey();
    if(!openAiKey) return res.status(500).json({error:'OPENAI_KEY not configured'});
    const r=await fetch('https://api.openai.com/v1/images/generations',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
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
    const selectedQuality=quality||'standard';
    const selectedSize=size||'1024x1024';
    await logOpenAiUsage({
      wrapper:'route:/api/generate-image',
      model:'dall-e-3',
      estimatedInputTokens:approxTokens(prompt),
      estimatedOutputTokens:0,
      responsePayload:d,
      requestId:r.headers.get('x-request-id')||'',
      retry:false,
      extra:{requestReason:`image_generation:${selectedQuality}:${selectedSize}`},
      flatCostUsd:selectedQuality==='hd'?0.08:0.04
    });
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
  const scopes = GOOGLE_SCOPES.join(' ');
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
  if(!googleTokens.refresh_token){
    lastGoogleAuthError='Google refresh token missing. Reconnect required.';
    return null;
  }
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
    if(fresh.error){
      lastGoogleAuthError = fresh.error_description || fresh.error;
      console.error('Google token refresh failed:', fresh.error);
      if(fresh.error==='invalid_grant') googleTokens.access_token='';
      return null;
    }
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
  await ensureGoogleTokensLoaded();
  res.json({
    connected: !!token,
    hasRefreshToken: !!googleTokens.refresh_token,
    scopes: googleScopeList(),
    missingScopes: missingGoogleScopes(),
    tokenExpiresAt: googleTokenExpiresAt(),
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
  return ghlMcp.getCalendarEvents(start,end);
}

// ════════════════════════════════════════════════════════
// GMAIL — replies from GHL contacts only
// ════════════════════════════════════════════════════════

app.get('/api/google/gmail', async (req, res) => {
  try {
    const token = await getGoogleToken();
    if(!token) return res.json({emails:[], needsAuth: true});

    // First get GHL contacts to cross-reference
    const contacts = await ghlMcp.searchContacts({limit:100,sortBy:'date_added',sortDirection:'desc'});
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

function parseEmailAddress(raw){
  const text=String(raw||'').trim();
  const match=text.match(/^(.*?)\s*<([^>]+)>$/);
  const email=(match?match[2]:text).replace(/"/g,'').trim().toLowerCase();
  const name=(match?match[1]:text.replace(email,'')).replace(/"/g,'').trim();
  return {name:name||email.split('@')[0]||'',email};
}
function decodeBase64Url(value){
  if(!value)return '';
  try{return Buffer.from(String(value).replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');}
  catch(e){return '';}
}
function extractGmailBody(payload){
  if(!payload)return '';
  if(payload.body?.data)return decodeBase64Url(payload.body.data);
  const parts=payload.parts||[];
  const plain=parts.find(p=>p.mimeType==='text/plain')||parts.find(p=>p.body?.data);
  if(plain?.body?.data)return decodeBase64Url(plain.body.data);
  for(const part of parts){
    const nested=extractGmailBody(part);
    if(nested)return nested;
  }
  return '';
}
function normalizeGmailMessage(md){
  const headers=md.payload?.headers||[];
  const header=name=>headers.find(h=>String(h.name||'').toLowerCase()===name.toLowerCase())?.value||'';
  const from=parseEmailAddress(header('From'));
  const bodyText=extractGmailBody(md.payload)||md.snippet||'';
  const to=String(header('To')||'').split(',').map(parseEmailAddress).filter(v=>v.email);
  const cc=String(header('Cc')||'').split(',').map(parseEmailAddress).filter(v=>v.email);
  const attachments=JSON.stringify(md.payload||{}).includes('"filename"');
  return {
    provider:'gmail',
    messageId:md.id||'',
    threadId:md.threadId||'',
    subject:header('Subject')||'(No subject)',
    from,
    to,
    cc,
    receivedAt:header('Date') ? new Date(header('Date')).toISOString() : '',
    snippet:md.snippet||'',
    bodyPreview:String(bodyText||'').slice(0,700),
    bodyText:String(bodyText||''),
    hasAttachments:attachments,
    webLink:`https://mail.google.com/mail/u/0/#inbox/${md.threadId||md.id}`,
    classification:'',
    recommendedAction:'',
    matchedContact:{},
    matchedRuleId:'',
    requiresApproval:true,
    confidence:'medium'
  };
}
function classifyEmail(email,rules=[]){
  const text=[email.subject,email.snippet,email.bodyPreview,email.bodyText,email.from?.email].join(' ').toLowerCase();
  const domain=(email.from?.email||'').split('@')[1]||'';
  const activeRules=rules.filter(r=>r.is_active!==false&&r.isActive!==false);
  for(const rule of activeRules){
    const conditions=rule.conditions||rule.conditions_json||rule.conditionsJson||{};
    if((conditions.from_email&&conditions.from_email===email.from?.email) || (conditions.from_domain&&conditions.from_domain===domain)){
      const type=rule.ruleType||rule.rule_type;
      const actions=rule.actions||rule.actions_json||rule.actionsJson||{};
      return {
        classification:type==='ignore_sender'||type==='ignore_domain'?'ignored':type==='forward_sender'||type==='forward_category'?'forward_to_team':type==='vip_priority'?'needs_attention':'needs_attention',
        reason:`Matched saved rule: ${rule.rule_name||rule.ruleName||type}`,
        recommendedAction:actions.action==='forward'?`Forward to ${actions.forward_to}`:actions.action||type,
        confidence:'high',
        matchedRuleId:rule.id,
        requiresApproval:(rule.approvalMode||rule.approval_mode)!=='always_auto'
      };
    }
  }
  if(/\b(unsubscribe|special offer|limited time|book a call|seo|cold email|quick question|sponsor|advertis|newsletter)\b/.test(text)){
    return {classification:'solicitation',reason:'Looks promotional or unsolicited.',recommendedAction:'Move to low priority review.',confidence:'medium',requiresApproval:true};
  }
  if(/\b(invoice|contract|agreement|legal|payment|billing|complaint|confidential|medical|hr|termination)\b/.test(text)){
    return {classification:'needs_attention',reason:'Sensitive or high-stakes language detected.',recommendedAction:'Review before any action.',confidence:'high',requiresApproval:true,sensitive:true};
  }
  if(/\b(can you|could you|please|confirm|question|let me know|reply|respond|available|schedule|meeting)\b/.test(text)){
    return {classification:'needs_reply',reason:'Asks for a response or decision.',recommendedAction:'Draft a reply for approval.',confidence:'high',requiresApproval:true};
  }
  if(/\b(proposal|pricing|contract|intro|introduction|following up|checking in)\b/.test(text)){
    return {classification:'waiting_on_response',reason:'Looks connected to a deal, intro, or follow-up loop.',recommendedAction:'Track response and draft follow-up if needed.',confidence:'medium',requiresApproval:true};
  }
  return {classification:'low_priority',reason:'No urgent request detected.',recommendedAction:'Keep in low priority unless this sender matters.',confidence:'medium',requiresApproval:true};
}
async function listEmailRules(userId){
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select * from email_rules where tenant_id=$1 and (user_id=$2 or user_id is null) order by created_at desc',[tenantId(),userId]);
    return (r.rows||[]).map(row=>({
      id:row.id,userId:row.user_id,tenantId:row.tenant_id,provider:row.provider,ruleName:row.rule_name,ruleType:row.rule_type,
      conditions:row.conditions_json||{},actions:row.actions_json||{},approvalMode:row.approval_mode,confidenceThreshold:row.confidence_threshold,
      isActive:row.is_active,createdFrom:row.created_from,createdFromMessageId:row.created_from_message_id,createdFromThreadId:row.created_from_thread_id,
      createdAt:row.created_at,updatedAt:row.updated_at,lastUsedAt:row.last_used_at,usageCount:row.usage_count
    }));
  }
  return (valStore().emailRules||[]).filter(r=>r.tenantId===tenantId()&&(r.userId===userId||!r.userId));
}
async function saveEmailRule(userId,rule){
  const id=rule.id||uuid('erule');
  const now=new Date().toISOString();
  const record={
    id,userId,tenantId:tenantId(),provider:rule.provider||'any',ruleName:rule.ruleName||rule.rule_name||'Email rule',
    ruleType:rule.ruleType||rule.rule_type||'label',conditions:rule.conditions||rule.conditions_json||{},
    actions:rule.actions||rule.actions_json||{},approvalMode:rule.approvalMode||rule.approval_mode||'review_only',
    confidenceThreshold:rule.confidenceThreshold||rule.confidence_threshold||'medium',isActive:rule.isActive!==false,
    createdFrom:rule.createdFrom||rule.created_from||'user_confirmation',createdFromMessageId:rule.createdFromMessageId||rule.created_from_message_id||'',
    createdFromThreadId:rule.createdFromThreadId||rule.created_from_thread_id||'',createdAt:rule.createdAt||now,updatedAt:now,lastUsedAt:rule.lastUsedAt||null,usageCount:rule.usageCount||0
  };
  if(pgPool){
    const r=await dbQuery(`
      insert into email_rules (id,user_id,tenant_id,provider,rule_name,rule_type,conditions_json,actions_json,approval_mode,confidence_threshold,is_active,created_from,created_from_message_id,created_from_thread_id,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())
      on conflict (id) do update set rule_name=excluded.rule_name,conditions_json=excluded.conditions_json,actions_json=excluded.actions_json,approval_mode=excluded.approval_mode,confidence_threshold=excluded.confidence_threshold,is_active=excluded.is_active,updated_at=now()
      returning *
    `,[id,userId,tenantId(),record.provider,record.ruleName,record.ruleType,record.conditions,record.actions,record.approvalMode,record.confidenceThreshold,record.isActive,record.createdFrom,record.createdFromMessageId,record.createdFromThreadId]);
    return (await listEmailRules(userId)).find(x=>x.id===r.rows[0].id);
  }
  const store=valStore();
  store.emailRules=store.emailRules||[];
  const idx=store.emailRules.findIndex(r=>r.id===id);
  if(idx>=0)store.emailRules[idx]={...store.emailRules[idx],...record};
  else store.emailRules.push(record);
  saveValStore(store);
  return record;
}
async function logEmailAction(userId,entry){
  const record={id:uuid('elog'),userId,tenantId:tenantId(),provider:entry.provider||'',messageId:entry.messageId||'',threadId:entry.threadId||'',actionType:entry.actionType||entry.action_type||'classified',actionStatus:entry.actionStatus||entry.action_status||'suggested',actedBy:entry.actedBy||entry.acted_by||'val',ruleId:entry.ruleId||entry.rule_id||'',details:entry.details||entry.details_json||{},createdAt:new Date().toISOString()};
  if(pgPool){
    await dbQuery('insert into email_action_log (id,user_id,tenant_id,provider,message_id,thread_id,action_type,action_status,acted_by,rule_id,details_json) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[record.id,userId,tenantId(),record.provider,record.messageId,record.threadId,record.actionType,record.actionStatus,record.actedBy,record.ruleId,record.details]);
  }else{
    const store=valStore();store.emailActionLog=store.emailActionLog||[];store.emailActionLog.push(record);saveValStore(store);
  }
  return record;
}
async function recentEmailActions(userId,limit=200){
  if(pgPool){
    const r=await dbQuery('select * from email_action_log where tenant_id=$1 and user_id=$2 order by created_at desc limit $3',[tenantId(),userId,limit]);
    return r.rows||[];
  }
  return (valStore().emailActionLog||[]).filter(a=>a.tenantId===tenantId()&&a.userId===userId).slice(-limit).reverse();
}
async function fetchGmailMessages({query='newer_than:7d',maxResults=20}={}){
  await ensureGoogleTokensLoaded();
  const missing=missingGoogleScopes(['https://www.googleapis.com/auth/gmail.readonly']);
  if(missing.length) return {emails:[],needsAuth:true,missingScopes:missing,error:'Reconnect required for Gmail'};
  const token=await getGoogleToken();
  if(!token)return {emails:[],needsAuth:true,missingScopes:missingGoogleScopes(),error:lastGoogleAuthError||'Google auth required',provider:'gmail'};
  const limit=Math.min(Number(maxResults)||20,100);
  const searchUrl=`https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${encodeURIComponent(limit)}`;
  const r=await fetch(searchUrl,{headers:{Authorization:`Bearer ${token}`}});
  const d=await readJsonResponse(r);
  if(!r.ok) return {emails:[],needsAuth:r.status===401,error:d.error?.message||`Gmail ${r.status}`,provider:'gmail',missingScopes:missingGoogleScopes()};
  const messages=d.messages||[];
  const details=await mapWithConcurrency(messages.slice(0,limit),5,async m=>{
    const mr=await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,{headers:{Authorization:`Bearer ${token}`}});
    const md=await readJsonResponse(mr);
    return normalizeGmailMessage(md);
  });
  return {emails:details,needsAuth:false,provider:'gmail',missingScopes:missingGoogleScopes()};
}
async function fetchUnifiedGmailEmails(limit=20){
  return fetchGmailMessages({query:'newer_than:14d',maxResults:limit});
}
function normalizeOutlookMessage(m){
  const from=m.from?.emailAddress||{};
  const to=(m.toRecipients||[]).map(r=>({name:r.emailAddress?.name||'',email:String(r.emailAddress?.address||'').toLowerCase()})).filter(v=>v.email);
  const cc=(m.ccRecipients||[]).map(r=>({name:r.emailAddress?.name||'',email:String(r.emailAddress?.address||'').toLowerCase()})).filter(v=>v.email);
  const bodyText=String(m.bodyPreview||m.body?.content||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  return {
    provider:'outlook',
    messageId:m.id||'',
    threadId:m.conversationId||m.id||'',
    subject:m.subject||'(No subject)',
    from:{name:from.name||'',email:String(from.address||'').toLowerCase()},
    to,cc,
    receivedAt:m.receivedDateTime||m.sentDateTime||'',
    snippet:m.bodyPreview||'',
    bodyPreview:bodyText.slice(0,700),
    bodyText,
    hasAttachments:!!m.hasAttachments,
    webLink:m.webLink||'',
    classification:'',
    recommendedAction:'',
    matchedContact:{},
    matchedRuleId:'',
    requiresApproval:true,
    confidence:'medium'
  };
}
async function fetchUnifiedOutlookEmails(limit=20){
  const saved=await loadOAuthTokens('microsoft');
  const token=saved?.access_token;
  if(!token)return {emails:[],needsAuth:true,provider:'outlook'};
  const url=`https://graph.microsoft.com/v1.0/me/messages?$top=${encodeURIComponent(limit)}&$orderby=receivedDateTime desc&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,webLink,isRead`;
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  const d=await readJsonResponse(r);
  if(!r.ok)return {emails:[],needsAuth:r.status===401,error:d.error?.message||`Microsoft Graph ${r.status}`,provider:'outlook'};
  return {emails:(d.value||[]).map(normalizeOutlookMessage),needsAuth:false,provider:'outlook'};
}

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
function gmailMeetingQuery(event){
  const attendees=inferAttendeesFromEvent(event);
  const emails=attendees.map(a=>a.email).filter(Boolean).slice(0,8);
  const names=attendees.map(a=>a.name).filter(Boolean).slice(0,6);
  const titleWords=String(event.title||event.summary||'').split(/\s+/).filter(w=>w.length>3&&!/meeting|call|zoom|google|with/i.test(w)).slice(0,6);
  const parts=[
    ...emails.map(e=>`from:${e} OR to:${e}`),
    ...names.map(n=>`"${n.replace(/"/g,'')}"`),
    ...titleWords.map(w=>`"${w.replace(/"/g,'')}"`)
  ].filter(Boolean);
  return parts.length ? `newer_than:60d (${parts.join(' OR ')})` : 'newer_than:14d';
}
async function matchingTranscriptContext(event,limit=5){
  const linked=await linkedTranscriptsForEvent(event,limit).catch(()=>[]);
  if(linked.length>=limit) return linked.slice(0,limit);
  const transcripts=await recentTranscripts(90);
  const linkedIds=new Set(linked.map(t=>t.id));
  const fuzzy=transcripts.map(t=>({...t,match:scoreTranscriptMeetingMatch(t,event)}))
    .filter(t=>!linkedIds.has(t.id))
    .filter(t=>t.match.confidence>=0.2)
    .sort((a,b)=>b.match.confidence-a.match.confidence)
    .slice(0,Math.max(0,limit-linked.length))
    .map(t=>({id:t.id,title:t.title,type:t.type,createdAt:t.createdAt,confidence:t.match.confidence,reason:t.match.reason,summary:String(t.rawText||'').slice(0,900)}));
  return [...linked,...fuzzy].slice(0,limit);
}
async function matchingTaskContext(event,limit=10){
  const tasks=await loadTasks();
  const attendees=inferAttendeesFromEvent(event);
  const hay=[event.title,event.summary,...attendees.flatMap(a=>[a.name,a.email])].filter(Boolean).join(' ').toLowerCase();
  return tasks.filter(t=>{
    const text=[t.title,t.contactName,t.notes].join(' ').toLowerCase();
    return !t.completed && hay && text && (hay.includes(String(t.contactName||'').toLowerCase()) || attendees.some(a=>(a.email&&text.includes(a.email.toLowerCase()))||(a.name&&text.includes(a.name.toLowerCase()))) || text.includes(String(event.title||event.summary||'').toLowerCase().slice(0,40)));
  }).slice(0,limit);
}
function personKey(name,email){
  const e=String(email||'').trim().toLowerCase();
  if(e) return 'email:'+e;
  return 'name:'+String(name||'Unknown').trim().toLowerCase().replace(/\s+/g,' ');
}
function cleanPersonName(value,email=''){
  const text=String(value||'').replace(/<.*?>/g,'').replace(/["']/g,'').trim();
  if(text&&text.includes('@')) return email ? email.split('@')[0] : text.split('@')[0];
  return text || (email ? email.split('@')[0] : 'Unknown');
}
function relationshipEvidence(type,summary,date='',confidence='medium',sourceId=''){
  return {type,summary:String(summary||'').slice(0,260),date:date||'',confidence,sourceId};
}
function interactionDate(value){
  const d=new Date(value||0);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
function daysSince(value){
  const t=interactionDate(value);
  if(!t) return null;
  return Math.floor((Date.now()-t)/(24*60*60*1000));
}
function splitPeopleFromText(text){
  const raw=String(text||'');
  const emails=(raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).slice(0,8).map(email=>({name:'',email:email.toLowerCase(),confidence:'high'}));
  const names=[...raw.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)].map(m=>m[1])
    .filter(v=>!/Google Calendar|Zoom Meeting|VAL|GHL|CRM|Make|OpenAI|Railway|Postgres|United States|New Lead|Relationship Review|Executive Review/.test(v))
    .slice(0,8).map(name=>({name,email:'',confidence:'low'}));
  const seen=new Set();
  return emails.concat(names).filter(p=>{const k=personKey(p.name,p.email);if(seen.has(k))return false;seen.add(k);return true;});
}
async function recentMemoryItems(days=30,limit=120){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState || {};
    const transcriptItems=(state.transcripts||[]).map(t=>({id:t.id,kind:t.type||'transcript',summary:t.title||'Transcript',rawText:t.rawText||'',metadata:t.metadata||{},createdAt:t.createdAt||''}));
    const memoryItems=state.memoryItems||[];
    return cloneDemo(memoryItems.concat(transcriptItems).slice(0,limit));
  }
  await valDbReady;
  const since=new Date(Date.now()-Number(days)*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select id,kind,summary,raw_text,metadata,created_at from val_memory_items where user_id=$1 and created_at >= $2 order by created_at desc limit $3',[VAL_USER_ID,since,limit]);
    return r.rows.map(row=>({id:row.id,kind:row.kind,summary:row.summary||'',rawText:row.raw_text||'',metadata:row.metadata||{},createdAt:row.created_at?row.created_at.toISOString():''}));
  }
  return (valStore().memoryItems||[]).filter(m=>new Date(m.createdAt||0)>=new Date(since)).slice(0,limit);
}
function relationshipScore(contact){
  const ev=contact.evidence||[];
  const hasPipeline=ev.some(e=>e.type==='opportunity');
  const hasMeeting=ev.some(e=>e.type==='meeting');
  const hasEmail=ev.some(e=>e.type==='email');
  const hasNote=ev.some(e=>e.type==='note');
  const hasTranscript=ev.some(e=>e.type==='transcript');
  const openLoops=(contact.openLoops||[]).length;
  const tags=(contact.tags||[]).map(t=>String(t).toLowerCase());
  const vip=contact.manualVip||tags.some(t=>/vip|client|partner|investor|mentor|referral|decision|prospect/.test(t));
  const strategic=Math.min(25,(vip?14:0)+(hasPipeline?8:0)+(contact.company?2:0)+(contact.superConnector?5:0)+(openLoops?3:0));
  const opportunity=Math.min(20,(hasPipeline?12:0)+(ev.some(e=>/proposal|pricing|contract|partnership|referral|intro|revenue|buying/i.test(e.summary))?6:0)+(contact.superConnector?3:0));
  const activity=Math.min(15,(hasMeeting?4:0)+(hasEmail?4:0)+(hasNote?3:0)+(hasTranscript?3:0)+Math.min(ev.length,5));
  const since=daysSince(contact.lastInteractionAt);
  const drift=Math.min(15,((since!==null&&since>=14)?7:0)+((since!==null&&since>=30)?4:0)+(openLoops?4:0)+(ev.some(e=>/stalled|overdue|pending|waiting/i.test(e.summary))?4:0));
  const loops=Math.min(15,openLoops*4+(ev.some(e=>/follow up|send|review|schedule|introduce|proposal|pending|waiting/i.test(e.summary))?5:0));
  const reciprocity=Math.min(10,(ev.some(e=>/referral|introduced|introduction|connected/i.test(e.summary))?5:0)+(contact.superConnector?5:0));
  return {
    total:Math.min(100,Math.round(strategic+opportunity+activity+drift+loops+reciprocity)),
    strategicImportance:strategic,opportunityPotential:opportunity,relationshipActivity:activity,driftRisk:drift,openLoopsCommitments:loops,reciprocityBalance:reciprocity
  };
}
function recommendedRelationshipAction(contact){
  if((contact.openLoops||[]).length) return `Close the open loop: ${contact.openLoops[0]}`;
  if(contact.lastInteractionDays!==null&&contact.lastInteractionDays>=14) return `Send a specific reconnect note referencing ${contact.lastEvidenceSummary||'the last known conversation'}.`;
  if(contact.superConnector) return 'Ask what they are seeing in the market and whether there is someone useful you can support or introduce.';
  if(contact.scoreBreakdown?.opportunityPotential>=10) return 'Move the opportunity forward with one concrete next step.';
  return 'Send a short, specific value-add check-in.';
}
function draftRelationshipOutreach(contact){
  const name=(contact.name||'there').split(/\s+/)[0];
  const evidence=contact.lastEvidenceSummary||'our last conversation';
  const ask=(contact.openLoops||[])[0]||contact.recommendedAction||'keep momentum moving';
  return {
    type:'email',
    subject:`Quick follow-up${contact.company?' re: '+contact.company:''}`,
    body:`Hi ${name},\n\nI was thinking about ${evidence}. I wanted to follow up while it is still fresh.\n\n${ask}\n\nWould it be useful to compare notes for a few minutes this week?`
  };
}
function relationshipProfile(contact){
  return {
    name:contact.name,company:contact.company||'',email:contact.email||'',score:contact.score,scoreBreakdown:contact.scoreBreakdown,
    relationshipSummary:contact.reason,recentTopics:contact.topics||[],openLoops:contact.openLoops||[],
    lastMeaningfulInteraction:contact.lastInteractionAt||'',strategicValue:contact.strategicValue||'Evidence-based relationship priority.',
    opportunitySignals:contact.opportunitySignals||[],riskSignals:contact.riskSignals||[],suggestedNextAction:contact.recommendedAction,
    suggestedOutreach:contact.draftOutreach,relatedContacts:contact.relatedContacts||[],tags:contact.tags||[]
  };
}
async function buildRelationshipReview({windowDays=7}={}){
  const now=new Date();
  const past=new Date(now);past.setDate(past.getDate()-Math.max(Number(windowDays)||7,7));
  const widerPast=new Date(now);widerPast.setDate(widerPast.getDate()-45);
  const future=new Date(now);future.setDate(future.getDate()+14);
  const people=new Map();
  const errors=[];
  function touch({name='',email='',company='',tags=[]}){
    const key=personKey(name,email);
    if(!people.has(key)) people.set(key,{key,name:cleanPersonName(name,email),email:String(email||'').toLowerCase(),company:company||'',tags:[],evidence:[],openLoops:[],opportunitySignals:[],riskSignals:[],topics:[],relatedContacts:[]});
    const p=people.get(key);
    if(name&&(!p.name||p.name==='Unknown')) p.name=cleanPersonName(name,email);
    if(email&&!p.email) p.email=String(email).toLowerCase();
    if(company&&!p.company) p.company=company;
    p.tags=Array.from(new Set((p.tags||[]).concat(tags||[]).filter(Boolean)));
    return p;
  }
  function addEvidence(person,evidence){
    if(!person||!evidence.summary)return;
    person.evidence.push(evidence);
    if(evidence.date&&interactionDate(evidence.date)>interactionDate(person.lastInteractionAt)) {
      person.lastInteractionAt=evidence.date;
      person.lastEvidenceSummary=evidence.summary;
    }
    if(/follow up|send|review|schedule|introduce|proposal|pending|waiting|owed|promised/i.test(evidence.summary)){
      person.openLoops=Array.from(new Set((person.openLoops||[]).concat(evidence.summary.slice(0,180)))).slice(0,8);
    }
    if(/proposal|pricing|contract|partnership|referral|intro|revenue|opportunity|pipeline/i.test(evidence.summary)) person.opportunitySignals.push(evidence.summary.slice(0,180));
    if(/stalled|overdue|waiting|no response|missed|forgotten|cooling/i.test(evidence.summary)) person.riskSignals.push(evidence.summary.slice(0,180));
    const topic=String(evidence.summary||'').split(/[.!?]/)[0].slice(0,90);
    if(topic) person.topics=Array.from(new Set((person.topics||[]).concat(topic))).slice(0,8);
  }
  const [gmail,outlook,tasks,transcripts,memory,ghlEvents,googleEvents,pipeline,ghlCrm]=await Promise.all([
    fetchGmailMessages({query:'newer_than:45d',maxResults:60}).catch(e=>{errors.push('Gmail: '+e.message);return {emails:[],error:e.message};}),
    fetchUnifiedOutlookEmails(60).catch(e=>{errors.push('Outlook: '+e.message);return {emails:[],error:e.message};}),
    loadTasks().catch(e=>{errors.push('Tasks: '+e.message);return [];}),
    recentTranscripts(45).catch(e=>{errors.push('Transcripts: '+e.message);return [];}),
    recentMemoryItems(45,120).catch(e=>{errors.push('Memory: '+e.message);return [];}),
    fetchGhlCalendarEvents(widerPast,future).catch(e=>{errors.push('GHL calendar: '+e.message);return [];}),
    fetchGoogleCalendarEvents(widerPast,future,150).catch(e=>{errors.push('Google calendar: '+e.message);return [];}),
    fetchGhlOpportunities({status:'open',limit:100}).catch(e=>{errors.push('Pipeline: '+e.message);return {data:{opportunities:[]}};}),
    ghlMcp.buildContext('',{limit:12,opportunityLimit:50,conversationLimit:12,notesLimit:4,taskLimit:4}).catch(e=>{errors.push('GHL CRM context: '+e.message);return {contacts:[],conversations:[],notes:[],tasks:[],opportunities:[]};})
  ]);
  for(const email of (gmail.emails||[]).concat(outlook.emails||[])){
    const sender=touch({name:email.from?.name,email:email.from?.email});
    addEvidence(sender,relationshipEvidence('email',`${email.subject||'(No subject)'}: ${email.snippet||email.bodyPreview||''}`,email.receivedAt,'high',email.messageId));
  }
  for(const ev of ghlEvents.concat(googleEvents)){
    inferAttendeesFromEvent(ev).forEach(a=>{
      const p=touch({name:a.name,email:a.email});
      addEvidence(p,relationshipEvidence('meeting',`${ev.title||ev.summary||'Meeting'}${ev.startTime?' on '+new Date(ev.startTime).toLocaleDateString('en-US'):''}`,ev.startTime,'high',ev.id));
    });
  }
  for(const task of tasks.filter(t=>!t.completed)){
    const p=touch({name:task.contactName||''});
    if(p.name==='Unknown') continue;
    addEvidence(p,relationshipEvidence('task',task.title+(task.notes?': '+task.notes:''),task.createdAt||task.dueDate,'high',task.id));
  }
  for(const tr of transcripts){
    splitPeopleFromText([tr.title,tr.rawText].join(' ')).forEach(person=>{
      const p=touch(person);
      addEvidence(p,relationshipEvidence('transcript',`${tr.title||'Transcript'}: ${String(tr.rawText||'').slice(0,220)}`,tr.createdAt,person.confidence,tr.id));
    });
  }
  for(const mem of memory){
    splitPeopleFromText([mem.summary,mem.rawText].join(' ')).forEach(person=>{
      const p=touch(person);
      addEvidence(p,relationshipEvidence('memory',`${mem.summary||mem.kind}: ${String(mem.rawText||'').slice(0,220)}`,mem.createdAt,person.confidence,mem.id));
    });
  }
  for(const o of (pipeline.data?.opportunities||[])){
    const c=o.contact||{};
    const p=touch({name:c.name||o.contactName||o.name,email:c.email||o.contactEmail,company:o.name});
    addEvidence(p,relationshipEvidence('opportunity',`${o.name||'Open opportunity'}${o.monetaryValue?' worth $'+o.monetaryValue:''}${o.status?' is '+o.status:''}`,o.updatedAt||o.lastStatusChangeAt,'high',o.id));
  }
  for(const c of (ghlCrm.contacts||[])){
    const p=touch({name:c.name,email:c.email,company:c.company,tags:['GHL contact']});
    addEvidence(p,relationshipEvidence('ghl_contact',`GHL contact record${c.company?' at '+c.company:''}${c.phone?' | '+c.phone:''}`,'','medium',c.id));
  }
  for(const t of (ghlCrm.tasks||[])){
    const p=touch({name:t.contactName||t.assignedToName||'',email:t.email||''});
    if(p.name==='Unknown'&&!t.contactId) continue;
    addEvidence(p,relationshipEvidence('ghl_task',`${t.title||t.name||t.body||'GHL task'}${t.dueDate||t.due_date?' due '+(t.dueDate||t.due_date):''}`,'','high',t.id||t.contactId));
  }
  for(const n of (ghlCrm.notes||[])){
    const p=touch({name:n.contactName||'',email:n.email||''});
    if(p.name==='Unknown'&&!n.contactId) continue;
    addEvidence(p,relationshipEvidence('ghl_note',noteBody(n)||String(n.body||n.note||n.text||'GHL note').slice(0,220),n.createdAt||n.created_at,'high',n.id||n.contactId));
  }
  for(const c of (ghlCrm.conversations||[])){
    const p=touch({name:c.contactName||c.fullName||c.name||'',email:c.email||''});
    if(p.name==='Unknown'&&!c.contactId) continue;
    addEvidence(p,relationshipEvidence('ghl_conversation',`${c.unreadCount||0} unread. ${c.lastMessageBody||c.lastMessage||'GHL conversation activity'}`,c.lastMessageDate||c.updatedAt,'high',c.id));
  }
  for(const p of people.values()){
    const introCount=p.evidence.filter(e=>/intro|introduction|connect|referral|referred/i.test(e.summary)).length;
    p.superConnector=introCount>=2;
    if(p.superConnector) p.tags.push('Super Connector');
    p.lastInteractionDays=daysSince(p.lastInteractionAt);
    p.scoreBreakdown=relationshipScore(p);
    p.score=p.scoreBreakdown.total;
    p.reason=[p.score>=70?'High priority relationship':'Relationship worth tracking',p.lastEvidenceSummary||'Evidence found across connected systems'].join(': ');
    p.recommendedAction=recommendedRelationshipAction(p);
    p.draftOutreach=draftRelationshipOutreach(p);
    p.profile=relationshipProfile(p);
  }
  const contacts=Array.from(people.values()).filter(p=>p.name&&p.name!=='Unknown'&&p.evidence.length).sort((a,b)=>b.score-a.score).slice(0,80);
  const topRelationshipPriorities=contacts.slice(0,10);
  const highestLeverageRelationships=contacts.filter(c=>c.scoreBreakdown.strategicImportance>=10||c.superConnector||c.scoreBreakdown.opportunityPotential>=10).slice(0,8);
  const coolingRelationships=contacts.filter(c=>c.lastInteractionDays!==null&&c.lastInteractionDays>=14&&c.score>=35).sort((a,b)=>b.score-a.score).slice(0,8);
  const momentumRelationships=contacts.filter(c=>c.evidence.filter(e=>interactionDate(e.date)>=past.getTime()).length>=2||c.scoreBreakdown.opportunityPotential>=10).slice(0,8);
  const peopleNotContactedRecently=contacts.filter(c=>c.lastInteractionDays!==null&&c.lastInteractionDays>=14).slice(0,10);
  const forgottenCommitments=contacts.flatMap(c=>(c.openLoops||[]).map(loop=>({contact:c.name,score:c.score,commitment:loop,sourceEvidence:c.evidence.find(e=>e.summary.includes(loop.slice(0,30)))||c.evidence[0],recommendedAction:`Close the loop with ${c.name}.`}))).slice(0,12);
  const hiddenOpportunities=contacts.filter(c=>(c.opportunitySignals||[]).length||c.superConnector).slice(0,10).map(c=>({contact:c.name,score:c.score,opportunity:(c.opportunitySignals||[])[0]||(c.superConnector?'Super Connector relationship may reveal introductions or market intelligence.':''),evidence:c.evidence.slice(0,2),recommendedAction:c.recommendedAction}));
  const connectors=contacts.filter(c=>c.superConnector);
  const opportunityPeople=contacts.filter(c=>c.scoreBreakdown.opportunityPotential>=8&&!c.superConnector);
  const suggestedIntroductions=connectors.slice(0,3).flatMap(a=>opportunityPeople.slice(0,3).filter(b=>b.key!==a.key).slice(0,1).map(b=>({personA:a.name,personB:b.name,reason:`${a.name} shows connector/referral signals and ${b.name} has opportunity signals.`,confidence:'low',evidence:[a.evidence[0],b.evidence[0]].filter(Boolean),suggestedIntroMessage:`${a.name}, I thought of you because ${b.name} is working through something that may overlap with your world. Would an introduction be useful?`}))).slice(0,5);
  return {
    ok:true,windowDays,generatedAt:new Date().toISOString(),errors,
    relationshipProfiles:contacts.map(c=>c.profile),
    topRelationshipPriorities,
    highestLeverageRelationships,
    coolingRelationships,
    momentumRelationships,
    peopleNotContactedRecently,
    forgottenCommitments,
    hiddenOpportunities,
    suggestedIntroductions,
    relationshipTaskPriorities:topRelationshipPriorities.map(c=>({contact:c.name,priority:c.score>=70?'High':c.score>=45?'Medium':'Low',tasks:c.openLoops||[],suggestedNextTask:c.recommendedAction,recommendedOutreach:c.draftOutreach})),
    draftCommunications:topRelationshipPriorities.slice(0,8).map(c=>({contact:c.name,score:c.score,draft:c.draftOutreach,evidence:c.evidence.slice(0,2)})),
    priorityReviewIntegration:{highestLeverageRelationship:highestLeverageRelationships[0]||null,top3RelationshipPriorities:topRelationshipPriorities.slice(0,3),oneCoolingRelationship:coolingRelationships[0]||null,oneForgottenCommitment:forgottenCommitments[0]||null,oneSuggestedIntroduction:suggestedIntroductions[0]||null,oneHiddenOpportunity:hiddenOpportunities[0]||null},
    askForAssistance:{question:'Would you like me to help with any of these relationships?',options:['Draft outreach','Create tasks','Brainstorm opportunities','Brainstorm ways to help this person','Prepare for upcoming meeting','Review relationship history']}
  };
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

function decodeBasicHtmlEntities(value){
  return String(value||'')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)||32))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)||32))
    .replace(/&commat;/gi,'@')
    .replace(/&period;/gi,'.')
    .replace(/&amp;/gi,'&');
}

function deobfuscateContactText(value){
  return decodeBasicHtmlEntities(value)
    .replace(/\s*(?:\[|\(|\{)\s*at\s*(?:\]|\)|\})\s*/gi,'@')
    .replace(/\s+at\s+/gi,'@')
    .replace(/\s*(?:\[|\(|\{)\s*dot\s*(?:\]|\)|\})\s*/gi,'.')
    .replace(/\s+dot\s+/gi,'.')
    .replace(/%40/g,'@')
    .replace(/%2e/gi,'.');
}

function extractEmailsFromValue(value){
  const text = deobfuscateContactText(typeof value === 'string' ? value : JSON.stringify(value||''));
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(e=>e.toLowerCase())
    .filter(e=>!/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e))
    .filter(e=>!/(example|domain|email\.com|sentry|wixpress|wordpress|schema\.org|cloudflare|godaddy)/i.test(e)))];
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
  return !/^(info|hello|contact|support|admin|office|team|media|press|help|careers|jobs|webmaster|noreply|no-reply|donotreply|frontdesk|reception|appointments|billing|service|customerservice)$/.test(local);
}

function classifyEmail(email){
  if(!email) return 'missing';
  const local=String(email).split('@')[0].toLowerCase();
  if(/^(owner|founder|ceo|president|coo|operations|ops|director|sales|partnerships|bizdev|businessdevelopment|hr|humanresources|benefits)$/.test(local)) return 'high-value role';
  if(isLikelyPersonEmail(email)) return 'person';
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
  const rocketReachKey=await resolveIntegrationSecret('rocketreach','api_key',ROCKETREACH_API_KEY);
  if(!rocketReachKey) return {configured:false, error:'ROCKETREACH_API_KEY is not set'};
  if(Date.now()<rocketReachLimitedUntil) return {configured:true, error:'RocketReach rate-limited; skipped to protect quota'};
  const params = new URLSearchParams();
  if(attendee.email) params.set('email',attendee.email);
  if(attendee.linkedinUrl) params.set('linkedin_url',attendee.linkedinUrl);
  if(attendee.name) params.set('name',attendee.name);
  if(attendee.company) params.set('current_employer',attendee.company);
  const url = `${ROCKETREACH_BASE_URL.replace(/\/$/,'')}/person/lookup?${params.toString()}`;
  const response = await fetch(url,{headers:{'Api-Key':rocketReachKey}});
  const data = await readJsonResponse(response);
  if(response.status===429){
    rocketReachLimitedUntil = Date.now() + 10*60*1000;
    return {configured:true, error:'RocketReach 429 rate limit'};
  }
  if(!response.ok) return {configured:true, error:data.message || data.error || `RocketReach ${response.status}`};
  return {configured:true, data:normalizeRocketReachPerson(data)};
}

async function lookupOutscraperLinkedIn(attendee, profile){
  const outscraperKey=await resolveIntegrationSecret('outscraper','api_key',OUTSCRAPER_API_KEY);
  if(!outscraperKey) return {configured:false, error:'OUTSCRAPER_API_KEY is not set'};
  if(!OUTSCRAPER_LINKEDIN_POSTS_URL) return {configured:false, error:'OUTSCRAPER_LINKEDIN_POSTS_URL is not set'};
  const url = new URL(OUTSCRAPER_LINKEDIN_POSTS_URL);
  const query = profile?.linkedinUrl || attendee.linkedinUrl || attendee.email || attendee.name;
  if(query) url.searchParams.set('query', query);
  url.searchParams.set('async','false');
  const response = await fetch(url.toString(),{headers:{'X-API-KEY':outscraperKey}});
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
    if(DEMO_MODE){
      const events=demoState(req,res).calendarEvents||[];
      const today=events.filter(e=>new Date(e.startTime).toDateString()===new Date().toDateString()).sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
      return res.json({meetingsToday:today.length,appointments:today,calendarSource:'demo',calendarId:'demo-calendar',_debug:{demo:true,googleCount:today.filter(e=>e.source==='google').length,ghlCount:today.filter(e=>e.source==='ghl').length,valCount:today.filter(e=>e.source==='val').length}});
    }
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setHours(23,59,59,999);

    const [ghlRes,googleRes,valRes] = await Promise.allSettled([
      fetchGhlCalendarEvents(s,e),
      fetchGoogleCalendarEvents(s,e,25),
      fetchValCalendarEvents(s,e)
    ]);

    const ghlEvents = ghlRes.status==='fulfilled' ? ghlRes.value : [];
    const googleEvents = googleRes.status==='fulfilled' ? googleRes.value : [];
    const valEvents = valRes.status==='fulfilled' ? valRes.value : [];
    const allEvents=[...ghlEvents,...googleEvents,...valEvents];
    allEvents.sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
    res.json({meetingsToday:allEvents.length, appointments:allEvents, calendarSource:'ghl+google+val', calendarId:GHL_CALENDAR_ID, _debug:{ghlCount:ghlEvents.length, googleCount:googleEvents.length, valCount:valEvents.length, googleNeedsAuth:googleRes.status==='rejected'}});
  }catch(e){
    console.error('meetings error:',e);
    res.json({meetingsToday:0,appointments:[]});
  }
});

async function fetchGhlOpportunities({status='open',limit=100}={}){
  return ghlMcp.findOpenOpportunities({status,limit});
}

app.get('/api/pipeline',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const opps=demoState(req,res).opportunities||[];
      return res.json({pipelineActive:opps.filter(o=>o.status==='open').length,stalledDeals:opps.filter(o=>o.stalled).length,opportunities:opps,_debug:{configured:true,demo:true}});
    }
    if(!(await ghlMcp.isConfigured())){
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
            ghlMcp.getContact(contactId)
          ]);
          contactEmail=contactData?.email||contactData?.contact?.email||'';
          contactPhone=contactData?.phone||contactData?.contact?.phone||'';
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
    const creds=await ghlMcp.credentials();
    if(!creds.apiKey||!creds.locationId){
      return res.json({configured:false,error:'Missing GHL_KEY or GHL_LOC'});
    }
    const found=await fetchGhlOpportunities({status:req.query.status||'open',limit:Number(req.query.limit||100)});
    res.json({
      configured:true,
      locationId:creds.locationId,
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
    res.json({configured:await ghlMcp.isConfigured().catch(()=>false),error:e.message});
  }
});

app.get('/api/debug/ghl-mcp-context',async(req,res)=>{
  try{
    const query=String(req.query.q||req.query.query||'').slice(0,500);
    const creds=await ghlMcp.credentials();
    const context=await ghlMcp.buildContext(query,{limit:Number(req.query.limit)||8,opportunityLimit:25,conversationLimit:8,notesLimit:4,taskLimit:4});
    res.json({
      ok:true,
      configured:!!(creds.apiKey&&creds.locationId),
      tenantId:creds.tenantId,
      userId:creds.user?.id||'',
      locationId:creds.locationId||'',
      counts:{
        contacts:context.contacts?.length||0,
        opportunities:context.opportunities?.length||0,
        tasks:context.tasks?.length||0,
        notes:context.notes?.length||0,
        conversations:context.conversations?.length||0
      },
      errors:context.errors||[],
      textPreview:String(context.text||'').slice(0,3500)
    });
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

app.post('/api/debug/goall-test-contact',async(req,res)=>{
  try{
    const result=await createOrUpdateGoallTestContact();
    res.json({ok:true,message:goallTestContactSummary(result),result});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get('/api/calendar',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const mapped=(demoState(req,res).calendarEvents||[]).slice().sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
      return res.json({calendarEvents:mapped,calendarSource:'demo',calendarId:'demo-calendar',_debug:{demo:true,ghlCount:mapped.filter(e=>e.source==='ghl').length,googleCount:mapped.filter(e=>e.source==='google').length,valCount:mapped.filter(e=>e.source==='val').length}});
    }
    const s=new Date();s.setHours(0,0,0,0);
    const e=new Date();e.setDate(e.getDate()+7);e.setHours(23,59,59,999);

    const [ghlRes,googleRes,valRes] = await Promise.allSettled([
      fetchGhlCalendarEvents(s,e),
      fetchGoogleCalendarEvents(s,e,75),
      fetchValCalendarEvents(s,e)
    ]);

    const ghlEvents = ghlRes.status==='fulfilled'?ghlRes.value:[];
    const googleEvents = googleRes.status==='fulfilled'?googleRes.value:[];
    const valEvents = valRes.status==='fulfilled'?valRes.value:[];

    console.log(`Calendar: ${ghlEvents.length} GHL events across ${GHL_CALENDAR_IDS.length||'all'} calendars; ${googleEvents.length} Google events; ${valEvents.length} VAL retro events`);

    const mapped = [...ghlEvents,...googleEvents,...valEvents];
    mapped.sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
    res.json({
      calendarEvents:mapped,
      calendarSource:'ghl+google+val',
      calendarId:GHL_CALENDAR_ID,
      _debug:{ghlCount:ghlEvents.length, googleCount:googleEvents.length, valCount:valEvents.length, googleNeedsAuth:googleRes.status==='rejected'}
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
    if(DEMO_MODE){
      const proposals=[
        {id:'demo-prop-1',title:'Atlas Operations Pilot',status:'viewed',stage:'viewed',contactName:'Marcus Chen',value:48000,viewCount:4,sentAt:demoIso(-2,10,0),url:VAL_SIGNUP_URL},
        {id:'demo-prop-2',title:'Northstar Advisory Scope',status:'draft',stage:'draft',contactName:'Elena Brooks',value:85000,viewCount:0,sentAt:null,url:VAL_SIGNUP_URL},
        {id:'demo-prop-3',title:'HealthBridge Renewal',status:'sent',stage:'sent',contactName:'Priya Raman',value:32000,viewCount:1,sentAt:demoIso(-7,9,0),url:VAL_SIGNUP_URL}
      ];
      return res.json({total:2,draft:1,sent:1,viewed:1,signed:0,allCount:proposals.length,proposals,waiting:proposals.filter(p=>['sent','viewed'].includes(p.stage))});
    }
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
  if(DEMO_MODE){
    const s=demoState(req,res);
    const conv=(s.conversations||[]).find(c=>c.id===id)||{};
    const messages=s.messages?.[id]||[];
    return res.json({id,contactName:conv.contactName||'Contact',contactId:conv.contactId||'',type:conv.type||'demo',unreadCount:conv.unreadCount||conv.unread||0,lastMessageBody:conv.lastMessageBody||conv.lastMessage||'',messages,lastMessage:messages[messages.length-1]?.body||conv.lastMessage||'',_debug:{demo:true}});
  }
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
    if(DEMO_MODE){
      const convos=demoState(req,res).conversations||[];
      const unread=convos.filter(c=>(c.unreadCount||c.unread)>0);
      return res.json({total:unread.length,ghlUnread:unread.length,items:unread.map(c=>({id:c.id,label:`${c.contactName||'Contact'} (${c.unreadCount||c.unread} unread)`,sublabel:c.lastMessage||'',source:'demo',type:'unread',actionUrl:VAL_SIGNUP_URL}))});
    }
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
    if(DEMO_MODE){
      const lead={...demoLeads({market:location||'United States',limit:1})[0],organizationName:company,location:location||'Demo Market'};
      const content=`company_payload:\nCompany Name: ${lead.organizationName}\nIndustry: ${lead.industry}\nPrimary Service: ${lead.primaryService}\nBusiness Model: B2B services\nLocation(s): ${lead.location}\nWebsite Status: active\n\ngoogle_raw:\n${lead.googleRaw}\n\ncompany_signals_raw:\n- Hiring activity: ${lead.hiringActivity}\n- Careers page: ${lead.careersPage}\n- Operational indicators: ${lead.operationalIndicators}\n\ncompany_news_raw:\n${lead.newsRaw}\n\nlinkedin_personal_url:\n${lead.linkedinPersonalUrl}\n\nlinkedin_company_url:\n${lead.linkedinCompanyUrl}`;
      return res.json({ok:true,company,location,content:withDemoCta(content),fields:parseLeadFieldOutputs(content),ghlUpdate:{updated:!!contactId,demo:true}});
    }
    const user=[
      'Research this potential business lead for GOALL using the GOALL lead intelligence standard.',
      'Company name: '+company,
      location?'City/state or market: '+location:'',
      body.website?'Known website: '+body.website:'',
      '',
      'Follow the required search process. Evaluate fit as a GOALL Agency business lead, especially employee count, hiring/growth signals, operational complexity, and reachable decision-makers. Return only the strict field outputs.'
    ].filter(Boolean).join('\n');
    const content=await callOpenAIWebResearch({system:GOALL_LEADS_SYSTEM_PROMPT,user,maxTokens:2600,temperature:0.1,meta:{contactId,requestReason:'lead_research'}});
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
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(req.body||{});
      return res.json({...discovered,content:withDemoCta(leadPreviewText(discovered))});
    }
    const body=req.body||{};
    const market=String(body.market||body.location||body.cityState||'').trim()||'United States';
    const criteria=String(body.criteria||body.query||'businesses with at least 300 employees or clear operational complexity').trim();
    const limit=leadLimitValue(body.limit);
    const system=[
      GOALL_LEADS_SYSTEM_PROMPT,
      'Discovery mode: find multiple potential GOALL Agency business leads, not one named company.',
      'Prioritize companies with visible evidence of employee size, hiring, expansion, multiple locations, operational complexity, or active sales/service teams.',
      'For contact quality, prioritize named owners, founders, CEOs, presidents, operations leaders, HR/benefits leaders, sales leaders, or partnership leaders. Treat receptionist, front desk, assistant, scheduler, billing, support, and office-manager contacts as gatekeepers unless no better route is public.',
      'Check each company website for public emails on contact, about, team, staff, leadership, management, people, directory, careers, and footer sections before marking email missing.',
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
      'Best public email/contact route:',
      'Why this fits GOALL Agency:',
      'Next outreach angle:',
      'Confidence:'
    ].join('\n');
    const content=await callOpenAIWebResearch({system,user,maxTokens:3600,temperature:0.2,meta:{requestReason:'lead_discovery'}});
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
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(req.body||{});
      return res.json({...discovered,...{created:discovered.leads,failed:[],skipped:[],content:withDemoCta(`Imported ${discovered.leads.length} demo leads to the demo CRM.\n\nTag applied: ${discovered.tag}\nPipeline stage: New Lead`)}});
    }
    const body=req.body||{};
    const discovered=await discoverHbsLeadProspects(body);
    const imported=await importApprovedHbsLeads(discovered);
    res.json({...discovered,...imported});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/discover-preview',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(req.body||{});
      return res.json({...discovered,content:withDemoCta(leadPreviewText(discovered))});
    }
    const discovered=await discoverHbsLeadProspects(req.body||{});
    res.json({...discovered,content:leadPreviewText(discovered)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/val/leads/import-approved',async(req,res)=>{
  try{
    const body=req.body||{};
    if(DEMO_MODE){
      const discovered=demoLeadDiscovery(body);
      const leads=Array.isArray(body.leads)&&body.leads.length?body.leads:discovered.leads;
      return res.json({...discovered,leads,created:leads,failed:[],skipped:[],content:withDemoCta(`Imported ${leads.length} approved demo lead${leads.length===1?'':'s'} to the demo CRM.\n\nTag applied: ${discovered.tag}\nSource: LimitLess Leads\nPipeline stage: New Lead`)});
    }
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
    if(DEMO_MODE){
      const enriched=leads.map((p,i)=>({...p,email:p.email||`decisionmaker${i+1}@example.com`,decisionMakerName:p.decisionMakerName||['Dana Holt','Marcus Chen','Renee Wallace'][i%3],decisionMakerTitle:p.decisionMakerTitle||'Operations Leader',rocketReachStatus:'verified demo email'}));
      const discovered={...demoLeadDiscovery(body),leads:enriched,rocketReachMode:'review'};
      return res.json({...discovered,content:withDemoCta(leadPreviewText(discovered))});
    }
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
    if(DEMO_MODE){
      const leads=demoLeads({limit:4,market:'Demo CRM'}).map((l,i)=>({name:l.organizationName,contactName:l.decisionMakerName,email:l.email,phone:l.phone,website:l.website,decisionMakerName:l.decisionMakerName,confidence:l.confidence}));
      const content=withDemoCta(leads.map((l,i)=>`${i+1}. ${l.name}\n   Decision maker: ${l.decisionMakerName}\n   Email: ${l.email}\n   Phone: ${l.phone}\n   Status: verified demo data`).join('\n\n'));
      return res.json({ok:true,count:leads.length,leads,content,demo:true});
    }
    const exclude=(Array.isArray(body.exclude)?body.exclude:['aric','jessa']).map(v=>String(v).toLowerCase());
    const limit=leadLimitValue(body.limit);
    const d=(await fetchGhlOpportunities({status:'open',limit:100})).data||{};
    let leads=(d.opportunities||[])
      .map(leadContactSnapshot)
      .filter(l=>l.name && !exclude.some(x=>String(l.name+' '+l.contactName).toLowerCase().includes(x)))
      .slice(0,limit);
    if(!leads.length) return res.status(404).json({error:'No current GHL opportunities found to enrich.'});
    leads=await mapWithConcurrency(leads,2,async lead=>{
      if(!lead.website) return lead;
      const publicContact=await findPublicWebsiteContactData(lead.website);
      const next={...lead,websiteContactStatus:publicContact.source?[
        publicContact.email?`email found: ${publicContact.quality}`:'no email found',
        publicContact.leader?.name?`decision-maker signal: ${publicContact.leader.title}`:'no decision-maker signal'
      ].join('; '):'not found'};
      if(publicContact.email && emailScore(publicContact)>emailScore({email:next.email,source:'ghl'})){
        next.email=publicContact.email;
        next.emailSource=publicContact.source;
        next.emailQuality=publicContact.quality;
      }
      if(publicContact.leader?.name && (!next.contactName || titleScore(publicContact.leader.title)>0)){
        next.contactName=publicContact.leader.name;
        next.decisionMakerName=publicContact.leader.name;
        next.decisionMakerTitle=publicContact.leader.title;
        next.decisionMakerSource=publicContact.leader.source;
      }
      return next;
    });
    const system=[
      GOALL_LEADS_SYSTEM_PROMPT,
      'Current-lead enrichment mode: verify existing GHL lead data for business lead outreach.',
      'For each existing lead, verify or flag the best public phone, email/contact route, and actual likely decision-maker. Do not invent direct emails or phone numbers. If only a general contact channel is public, say that.',
      'Do not accept gatekeepers as the likely decision-maker when a founder, owner, CEO, president, operations, HR/benefits, sales, or partnership leader is publicly visible.',
      'Search the company website contact, about, team, staff, leadership, management, people, directory, careers, and footer sections for public emails before marking email missing.',
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
    const content=await callOpenAIWebResearch({system,user,maxTokens:5000,temperature:0.15,meta:{requestReason:'current_lead_enrichment'}});
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
  if(DEMO_MODE) return cloneDemo(requestContext.getStore()?.demoState?.tasks || []);
  await valDbReady;
  if(pgPool){
    const r=await dbQuery('select * from val_tasks where user_id=$1 order by completed asc, due_date asc nulls last, created_at desc',[VAL_USER_ID]);
    return r.rows.map(rowToTask);
  }
  return readTasks();
}
async function saveTask(task){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state){
      const clean={...task,id:task.id||uuid('demo-task'),title:String(task.title||'Untitled task').trim()||'Untitled task',createdAt:task.createdAt||new Date().toISOString()};
      const idx=state.tasks.findIndex(t=>t.id===clean.id);
      if(idx>=0) state.tasks[idx]=clean; else state.tasks.push(clean);
    }
    return;
  }
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
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state) state.tasks=cloneDemo(tasks);
    return;
  }
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
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state) state.tasks=(state.tasks||[]).filter(t=>t.id!==id);
    return;
  }
  await valDbReady;
  if(pgPool){ await dbQuery('delete from val_tasks where user_id=$1 and id=$2',[VAL_USER_ID,id]); return; }
  writeTasks(readTasks().filter(t=>t.id!==id));
}
app.get('/api/val/tasks',async(req,res)=>{try{res.json(await loadTasks());}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/tasks',async(req,res)=>{try{const task=req.body;if(!task||!task.id)return res.status(400).json({error:'Missing task id'});await saveTask(task);res.json({ok:true,task});}catch(e){res.status(500).json({error:e.message});}});
app.put('/api/val/tasks',async(req,res)=>{try{if(!Array.isArray(req.body))return res.status(400).json({error:'Expected array'});await replaceTasks(req.body);res.json({ok:true,count:req.body.length});}catch(e){res.status(500).json({error:e.message});}});
app.delete('/api/val/tasks/:id',async(req,res)=>{try{await deleteTask(req.params.id);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

function rowToDraft(row){
  return {id:row.id,userId:row.user_id,tenantId:row.tenant_id,draftType:row.draft_type,contactId:row.contact_id||'',provider:row.provider,subject:row.subject||'',body:row.body||'',status:row.status,sourceContext:row.source_context_json||{},createdAt:row.created_at?row.created_at.toISOString():new Date().toISOString(),updatedAt:row.updated_at?row.updated_at.toISOString():new Date().toISOString()};
}
async function saveInternalDraft(payload){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    const draft={id:payload.id||uuid('demo-draft'),userId:'demo-user',tenantId:'demo-val',draftType:payload.draftType||payload.draft_type||'follow_up',contactId:payload.contactId||payload.contact_id||'',provider:payload.provider||'internal',subject:payload.subject||'',body:payload.body||'',status:payload.status||'draft',sourceContext:payload.sourceContext||payload.source_context_json||{},createdAt:payload.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(state){
      const idx=state.drafts.findIndex(d=>d.id===draft.id);
      if(idx>=0) state.drafts[idx]={...state.drafts[idx],...draft}; else state.drafts.unshift(draft);
    }
    return draft;
  }
  await valDbReady;
  const draft={id:payload.id||uuid('draft'),userId:payload.userId||currentUserId(),tenantId:tenantId(),draftType:payload.draftType||payload.draft_type||'follow_up',contactId:payload.contactId||payload.contact_id||'',provider:payload.provider||'internal',subject:payload.subject||'',body:payload.body||'',status:payload.status||'draft',sourceContext:payload.sourceContext||payload.source_context_json||{}};
  if(pgPool){
    const r=await dbQuery(`
      insert into drafts (id,user_id,tenant_id,draft_type,contact_id,provider,subject,body,status,source_context_json,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
      on conflict (id) do update set draft_type=excluded.draft_type,contact_id=excluded.contact_id,provider=excluded.provider,subject=excluded.subject,body=excluded.body,status=excluded.status,source_context_json=excluded.source_context_json,updated_at=now()
      returning *
    `,[draft.id,draft.userId,draft.tenantId,draft.draftType,draft.contactId,draft.provider,draft.subject,draft.body,draft.status,JSON.stringify(draft.sourceContext)]);
    return rowToDraft(r.rows[0]);
  }
  const store=valStore();store.drafts=store.drafts||[];
  const idx=store.drafts.findIndex(d=>d.id===draft.id);
  const record={...draft,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  if(idx>=0)store.drafts[idx]={...store.drafts[idx],...record}; else store.drafts.unshift(record);
  saveValStore(store);
  return record;
}
async function listDrafts(status=''){
  if(DEMO_MODE){
    const drafts=requestContext.getStore()?.demoState?.drafts || [];
    return cloneDemo(drafts.filter(d=>!status||d.status===status).slice(0,100));
  }
  await valDbReady;
  if(pgPool){
    const params=[currentUserId(),tenantId()];
    let sql='select * from drafts where user_id=$1 and tenant_id=$2';
    if(status){params.push(status);sql+=' and status=$3';}
    sql+=' order by created_at desc limit 100';
    const r=await dbQuery(sql,params);
    return r.rows.map(rowToDraft);
  }
  return (valStore().drafts||[]).filter(d=>d.userId===currentUserId()&&(!status||d.status===status)).slice(0,100);
}
app.get('/api/val/drafts',async(req,res)=>{try{res.json({ok:true,drafts:await listDrafts(req.query.status||'')});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/val/drafts',async(req,res)=>{try{res.json({ok:true,draft:await saveInternalDraft(req.body||{})});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.patch('/api/val/drafts/:id',async(req,res)=>{
  try{
    const existing=(await listDrafts()).find(d=>d.id===req.params.id);
    if(!existing)return res.status(404).json({ok:false,error:'Draft not found'});
    res.json({ok:true,draft:await saveInternalDraft({...existing,...req.body,id:req.params.id})});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/gmail/drafts',async(req,res)=>{
  try{
    await ensureGoogleTokensLoaded();
    const missing=missingGoogleScopes(['https://www.googleapis.com/auth/gmail.compose']);
    const payload=req.body||{};
    if(missing.length){
      const draft=await saveInternalDraft({draftType:'email_reply',provider:'internal',subject:payload.subject||'',body:payload.body||'',sourceContext:{warning:'Gmail compose scope missing. Created internal draft instead.',to:payload.to||'',threadId:payload.threadId||''}});
      return res.status(202).json({ok:true,warning:'Gmail compose scope missing. Created internal draft instead.',draft});
    }
    const token=await getGoogleToken();
    if(!token){
      const draft=await saveInternalDraft({draftType:'email_reply',provider:'internal',subject:payload.subject||'',body:payload.body||'',sourceContext:{warning:lastGoogleAuthError||'Google auth required',to:payload.to||'',threadId:payload.threadId||''}});
      return res.status(202).json({ok:true,warning:'Google auth unavailable. Created internal draft instead.',draft});
    }
    const lines=[`To: ${payload.to||''}`,`Subject: ${payload.subject||''}`,'',payload.body||''];
    const raw=Buffer.from(lines.join('\r\n')).toString('base64url');
    const r=await fetch('https://www.googleapis.com/gmail/v1/users/me/drafts',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({message:{raw,threadId:payload.threadId||undefined}})});
    const d=await readJsonResponse(r);
    if(!r.ok) throw new Error(d.error?.message||`Gmail draft failed (${r.status})`);
    res.json({ok:true,gmailDraft:d});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

async function saveMemoryItem(payload){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    if(state){
      state.memoryItems=state.memoryItems||[];
      state.memoryItems.unshift({id:payload.id||uuid('demo-mem'),kind:payload.kind||payload.type||'note',summary:payload.summary||'',rawText:payload.rawText||payload.transcript||payload.summary||'',importance:payload.importance||1,metadata:payload.metadata||{},createdAt:new Date().toISOString()});
    }
    return {id:payload.id||uuid('demo-mem')};
  }
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
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    const id=payload.id||uuid('demo-tr');
    const type=payload.type||'transcript';
    const rawText=payload.transcript||payload.rawText||payload.text||'';
    if(state) state.transcripts.unshift({id,type,title:payload.title||'',rawText,metadata:{...payload},createdAt:payload.timestamp||new Date().toISOString()});
    return {id,type};
  }
  await valDbReady;
  const id=payload.id||uuid('tr');
  const type=payload.type||'transcript';
  const rawText=payload.transcript||payload.rawText||payload.text||'';
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
async function recentTranscripts(days=7){
  if(DEMO_MODE) return cloneDemo(requestContext.getStore()?.demoState?.transcripts || []);
  await valDbReady;
  const since=new Date(Date.now()-Number(days)*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select id,type,title,raw_text,metadata,created_at from val_transcripts where user_id=$1 and created_at >= $2 order by created_at desc',[VAL_USER_ID,since]);
    return r.rows.map(row=>({id:row.id,type:row.type,title:row.title||'',rawText:row.raw_text||'',metadata:row.metadata||{},createdAt:row.created_at?row.created_at.toISOString():''}));
  }
  return (valStore().transcripts||[]).filter(t=>new Date(t.createdAt||0)>=new Date(since));
}
async function countTranscriptMeetingLinks(days=7){
  await valDbReady;
  const since=new Date(Date.now()-Number(days)*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select count(*)::int as count from meeting_transcript_links where user_id=$1 and tenant_id=$2 and created_at >= $3',[VAL_USER_ID,tenantId(),since]);
    return r.rows[0]?.count||0;
  }
  return (valStore().meetingTranscriptLinks||[]).filter(l=>l.userId===VAL_USER_ID&&l.tenantId===tenantId()&&new Date(l.createdAt||0)>=new Date(since)).length;
}
async function linkedTranscriptsForEvent(event,limit=5){
  await valDbReady;
  if(!event?.id) return [];
  const source=event.source||'unknown';
  if(pgPool){
    const r=await dbQuery(`
      select t.id,t.type,t.title,t.raw_text,t.metadata,t.created_at,l.confidence,l.matched_reason
      from meeting_transcript_links l
      join val_transcripts t on t.id=l.transcript_id
      where l.user_id=$1 and l.tenant_id=$2 and l.meeting_event_id=$3 and (l.meeting_source=$4 or l.meeting_source is null)
      order by l.created_at desc
      limit $5
    `,[VAL_USER_ID,tenantId(),event.id,source,limit]);
    return r.rows.map(row=>({id:row.id,type:row.type,title:row.title||'',createdAt:row.created_at?row.created_at.toISOString():'',confidence:Number(row.confidence||0),reason:row.matched_reason||'explicit transcript link',summary:String(row.raw_text||'').slice(0,900),metadata:row.metadata||{}}));
  }
  const store=valStore();
  const links=(store.meetingTranscriptLinks||[]).filter(l=>l.userId===VAL_USER_ID&&l.tenantId===tenantId()&&l.meetingEventId===event.id&&(!l.meetingSource||l.meetingSource===source)).slice(0,limit);
  const transcripts=store.transcripts||[];
  return links.map(l=>{
    const t=transcripts.find(tr=>tr.id===l.transcriptId);
    return t ? {id:t.id,type:t.type,title:t.title||'',createdAt:t.createdAt||'',confidence:Number(l.confidence||0),reason:l.matchedReason||'explicit transcript link',summary:String(t.rawText||'').slice(0,900),metadata:t.metadata||{}} : null;
  }).filter(Boolean);
}
function transcriptMeetingTitle(transcript){
  const text=[transcript.title,transcript.rawText,JSON.stringify(transcript.metadata||{})].join(' ');
  const explicit=String(transcript.title||'').replace(/\b(transcript|meeting|call|zoom|recording)\b/ig,' ').replace(/[^a-z0-9\s]/ig,' ').replace(/\s+/g,' ').trim();
  const source=[explicit,text].filter(Boolean).join(' ');
  const seen=new Set();
  const words=(source.toLowerCase().match(/[a-z0-9]{3,}/g)||[])
    .filter(w=>!['transcript','meeting','call','zoom','recording','with','from','this','that','notes','summary','unknown','processed','source','smoke','test','jessa'].includes(w))
    .filter(w=>{if(seen.has(w)) return false; seen.add(w); return true;})
    .slice(0,4);
  if(words.length>=3) return words.map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
  const people=splitPeopleFromText(text).slice(0,2).map(p=>p.name||p.email?.split('@')[0]).filter(Boolean);
  if(people.length) return people.concat(['Follow Up']).join(' ').split(/\s+/).slice(0,4).join(' ');
  return 'Retro Conversation Notes';
}
async function saveValCalendarEvent(event){
  await valDbReady;
  const id=event.id||uuid('vev');
  const record={id,userId:VAL_USER_ID,tenantId:tenantId(),source:event.source||'val',title:event.title||'Retro Conversation Notes',startTime:event.startTime||new Date().toISOString(),endTime:event.endTime||event.startTime||new Date().toISOString(),attendees:event.attendees||[],metadata:event.metadata||{}};
  if(pgPool){
    await dbQuery(`
      insert into val_calendar_events (id,user_id,tenant_id,source,title,start_time,end_time,attendees,metadata,created_at,updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
      on conflict (id) do update set title=excluded.title,start_time=excluded.start_time,end_time=excluded.end_time,attendees=excluded.attendees,metadata=excluded.metadata,updated_at=now()
    `,[record.id,record.userId,record.tenantId,record.source,record.title,record.startTime,record.endTime,JSON.stringify(record.attendees),JSON.stringify(record.metadata)]);
  }else{
    const store=valStore();store.calendarEvents=store.calendarEvents||[];
    const idx=store.calendarEvents.findIndex(e=>e.id===id);
    if(idx>=0)store.calendarEvents[idx]={...store.calendarEvents[idx],...record}; else store.calendarEvents.unshift(record);
    saveValStore(store);
  }
  return {id:record.id,title:record.title,summary:record.title,startTime:record.startTime,endTime:record.endTime,attendees:record.attendees,source:'val',calendarName:'VAL Retroactive Meetings',metadata:record.metadata};
}
async function fetchValCalendarEvents(start,end){
  await valDbReady;
  const s=start?.toISOString?start.toISOString():new Date(Date.now()-7*24*60*60*1000).toISOString();
  const e=end?.toISOString?end.toISOString():new Date(Date.now()+7*24*60*60*1000).toISOString();
  if(pgPool){
    const r=await dbQuery('select * from val_calendar_events where user_id=$1 and tenant_id=$2 and start_time >= $3 and start_time <= $4 order by start_time asc',[VAL_USER_ID,tenantId(),s,e]);
    return r.rows.map(row=>({id:row.id,title:row.title,summary:row.title,startTime:row.start_time?row.start_time.toISOString():'',endTime:row.end_time?row.end_time.toISOString():'',attendees:row.attendees||[],source:'val',calendarName:'VAL Retroactive Meetings',metadata:row.metadata||{}}));
  }
  return (valStore().calendarEvents||[]).filter(ev=>new Date(ev.startTime||0)>=new Date(s)&&new Date(ev.startTime||0)<=new Date(e));
}
function scoreTranscriptMeetingMatch(transcript,event){
  const tText=[transcript.title,transcript.rawText,JSON.stringify(transcript.metadata||{})].join(' ').toLowerCase();
  const eTitle=String(event.title||event.summary||'').toLowerCase();
  let score=0,reasons=[];
  if(eTitle&&tText.includes(eTitle.slice(0,80))){score+=0.45;reasons.push('title');}
  const attendees=inferAttendeesFromEvent(event);
  attendees.forEach(a=>{
    if(a.email&&tText.includes(a.email.toLowerCase())){score+=0.2;reasons.push('attendee email');}
    if(a.name&&a.name.length>3&&tText.includes(a.name.toLowerCase())){score+=0.12;reasons.push('attendee name');}
  });
  const ts=new Date(transcript.createdAt||transcript.metadata?.timestamp||transcript.metadata?.createdAt||0).getTime();
  const start=new Date(event.startTime||event.start||0).getTime();
  if(ts&&start&&Math.abs(ts-start)<4*60*60*1000){score+=0.25;reasons.push('time window');}
  return {confidence:Math.min(Number(score.toFixed(2)),1),reason:[...new Set(reasons)].join(', ')||'weak match'};
}
async function saveMeetingTranscriptLink({event,transcript,confidence,reason}){
  if(!event?.id||!transcript?.id) return null;
  const isRetro=event.source==='val' || event.metadata?.retroactive;
  if(!isRetro&&confidence<0.35) return null;
  const record={id:uuid('mtl'),userId:VAL_USER_ID,tenantId:tenantId(),meetingSource:event.source||'unknown',meetingEventId:event.id,transcriptId:transcript.id,confidence,matchedReason:reason,createdAt:new Date().toISOString()};
  if(pgPool){
    await dbQuery(`
      insert into meeting_transcript_links (id,user_id,tenant_id,meeting_source,meeting_event_id,transcript_id,confidence,matched_reason)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (user_id,tenant_id,meeting_source,meeting_event_id,transcript_id) do update set confidence=greatest(meeting_transcript_links.confidence,excluded.confidence),matched_reason=excluded.matched_reason
    `,[record.id,record.userId,record.tenantId,record.meetingSource,record.meetingEventId,record.transcriptId,record.confidence,record.matchedReason]);
  }else{
    const store=valStore();store.meetingTranscriptLinks=store.meetingTranscriptLinks||[];
    if(!store.meetingTranscriptLinks.some(l=>l.meetingEventId===record.meetingEventId&&l.transcriptId===record.transcriptId))store.meetingTranscriptLinks.push(record);
    saveValStore(store);
  }
  return record;
}
async function linkTranscriptToBestMeeting(transcript,options={}){
  const now=new Date(transcript.createdAt||Date.now());
  const start=new Date(now);start.setDate(start.getDate()-1);
  const end=new Date(now);end.setDate(end.getDate()+1);
  const events=[
    ...(await fetchGhlCalendarEvents(start,end).catch(()=>[])),
    ...(await fetchGoogleCalendarEvents(start,end,100).catch(()=>[])),
    ...(await fetchValCalendarEvents(start,end).catch(()=>[]))
  ];
  let best=null;
  for(const event of events){
    const m=scoreTranscriptMeetingMatch(transcript,event);
    if(!best||m.confidence>best.confidence) best={event,...m};
  }
  if(best&&best.confidence>=0.35) return saveMeetingTranscriptLink({event:best.event,transcript,confidence:best.confidence,reason:best.reason});
  if(options.createRetro!==false){
    const ts=transcript.createdAt||transcript.metadata?.timestamp||transcript.metadata?.createdAt||new Date().toISOString();
    const retro=await saveValCalendarEvent({
      title:transcriptMeetingTitle(transcript),
      startTime:ts,
      endTime:new Date(new Date(ts).getTime()+30*60*1000).toISOString(),
      attendees:splitPeopleFromText([transcript.title,transcript.rawText,JSON.stringify(transcript.metadata||{})].join(' ')).slice(0,8),
      metadata:{retroactive:true,createdFrom:'unmatched_transcript',transcriptId:transcript.id,originalTitle:transcript.title||''}
    });
    return saveMeetingTranscriptLink({event:retro,transcript,confidence:0.25,reason:'retroactive VAL meeting created for unmatched transcript'});
  }
  return null;
}
async function saveConversation(payload){
  if(DEMO_MODE){
    const state=requestContext.getStore()?.demoState;
    const id=payload.id||uuid('demo-chat');
    const messages=Array.isArray(payload.messages)?payload.messages:[];
    const title=payload.title||(messages.find(m=>m.role==='user')?.content||'Demo Conversation').slice(0,80);
    if(state){
      state.savedConversations=state.savedConversations||[];
      state.savedConversationMessages=state.savedConversationMessages||{};
      state.savedConversations=state.savedConversations.filter(c=>c.id!==id);
      state.savedConversations.unshift({id,title,source:payload.source||payload.type||'chat',metadata:payload.metadata||{},created_at:payload.timestamp||new Date().toISOString(),updated_at:new Date().toISOString()});
      state.savedConversationMessages[id]=messages.map(m=>({role:m.role||'user',content:m.content||'',metadata:m.metadata||{},created_at:m.timestamp||new Date().toISOString()}));
    }
    return {id,title,count:messages.length};
  }
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
  const notes=await ghlMcp.getContactNotes(contactId,{limit});
  return normalizeNotesPayload({notes}).map(noteBody).filter(Boolean).slice(0,limit);
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
      ghlMcp.getContact(contactId).catch(()=>({})),
      fetchContactNotes(contactId,30)
    ]);
    const contact=contactData.contact||contactData;
    if(!notes.length)return '';
    return `Contact: ${contactDisplayName(contact)}${contact.email?' | '+contact.email:''}${contact.phone?' | '+contact.phone:''}\nGHL notes and call transcript history:\n- ${notes.join('\n- ')}`;
  }catch(e){return '';}
}
async function ghlContactNotesContext(query,dashboard){
  if(!(await ghlMcp.isConfigured()))return '';
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
      const contacts=await ghlMcp.searchContacts({query:q,limit:3});
      for(const c of contacts){
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
async function ghlPlatformContext(query,dashboard,opts={}){
  if(!(await ghlMcp.isConfigured())) return '';
  const [crm,notes]=await Promise.all([
    ghlMcp.buildContext(query,{limit:opts.limit||8,opportunityLimit:opts.opportunityLimit||25,conversationLimit:opts.conversationLimit||8,notesLimit:opts.notesLimit||5,taskLimit:opts.taskLimit||5}).catch(e=>({text:'GHL CRM context error: '+e.message})),
    ghlContactNotesContext(query,dashboard).catch(()=>'')
  ]);
  return [
    crm.text||'',
    notes?`Targeted GHL note history:\n${notes}`:''
  ].filter(Boolean).join('\n\n');
}
async function callValModel({system,user,maxTokens=1200,temperature=0.4,json=false,meta={}}){
  return callOpenAIResponses({system,messages:[{role:'user',content:user}],maxTokens,temperature,json,meta});
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

async function callOpenAIResponses({system,messages,maxTokens=1200,temperature=0.4,json=false,meta={}}){
  const openAiKey=await resolveOpenAIKey();
  const openAiModel=await resolveOpenAIModel();
  if(!openAiKey) throw new Error('OPENAI_KEY not configured');
  const body = {
    model:openAiModel,
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
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
    body:JSON.stringify(body)
  });
  let d=await r.json();
  let requestId=r.headers.get('x-request-id')||'';
  let retry=false;
  if(d.error && /temperature/i.test(d.error.message||'')){
    delete body.temperature;
    r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
      body:JSON.stringify(body)
    });
    d=await r.json();
    requestId=r.headers.get('x-request-id')||requestId;
    retry=true;
  }
  await logOpenAiUsage({
    wrapper:'callOpenAIResponses',
    model:openAiModel,
    estimatedInputTokens:approxTokens(body.instructions)+approxTokens(body.input),
    estimatedOutputTokens:maxTokens,
    responsePayload:d,
    requestId,
    retry,
    extra:meta
  });
  if(d.error) throw new Error(d.error.message);
  return responseText(d);
}

async function callOpenAIWebResearch({system,user,maxTokens=2200,temperature=0.1,meta={}}){
  const openAiKey=await resolveOpenAIKey();
  const openAiModel=await resolveOpenAIModel();
  if(!openAiKey) throw new Error('OPENAI_KEY not configured');
  const body = {
    model: openAiModel,
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
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
    body:JSON.stringify(body)
  });
  let d=await r.json();
  let requestId=r.headers.get('x-request-id')||'';
  let retry=false;
  if(d.error && /temperature/i.test(d.error.message||'')){
    delete body.temperature;
    r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${openAiKey}`},
      body:JSON.stringify(body)
    });
    d=await r.json();
    requestId=r.headers.get('x-request-id')||requestId;
    retry=true;
  }
  await logOpenAiUsage({
    wrapper:'callOpenAIWebResearch',
    model:openAiModel,
    estimatedInputTokens:approxTokens(body.input),
    estimatedOutputTokens:maxTokens,
    responsePayload:d,
    requestId,
    retry,
    extra:{...meta,requestReason:meta.requestReason||'web_research'}
  });
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
- Avoid gatekeepers as the primary contact when a higher-authority owner, founder, executive, operations, HR, benefits, sales, or partnership leader is publicly visible. Reception, front desk, admin, office manager, scheduler, billing, and generic support contacts are fallback routes only.

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
6. Best available decision-maker contact path, with preference for a named owner/executive/department leader and a public direct or role-based email from the company's own website

SEARCH PROCESS - follow in order:
1. Search company name + city/state
2. Identify official website
3. Crawl the official website's contact, about, team, staff, leadership, management, people, directory, careers, and footer areas for public email/contact routes
4. Extract core company data
5. Search LinkedIn company page
6. Search LinkedIn people / likely decision-makers
7. Check Google Business
8. Scan for news, hiring, activity, expansion, funding, operations, and growth signals
9. Compile structured outputs

Source priority:
1. Official website
2. LinkedIn company page
3. Google Business listing
4. News / press mentions
5. Secondary directories

Accuracy rules:
- Only include information that is directly observed, clearly stated, or strongly supported by multiple signals.
- Never invent employee counts, services, locations, contact info, decision-makers, or company descriptions.
- Do not settle for a gatekeeper if a stronger decision-maker is visible on the company website, LinkedIn, or a staff/leadership page.
- If a direct person email is not visible, prefer public role emails tied to revenue, operations, HR, benefits, partnerships, owner, founder, CEO, president, or director functions before generic info/contact/support addresses.
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

const leadFieldIdCache=new Map();
async function resolveLeadFieldIds(){
  const loc=await resolveGhlLocationId();
  const cacheKey=loc||GHL_LOC||tenantId();
  if(leadFieldIdCache.has(cacheKey)) return leadFieldIdCache.get(cacheKey);
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
  leadFieldIdCache.set(cacheKey,resolved);
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
    website:o.contact?.website||o.website||o.contact?.additionalEmails?.website||'',
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

function compactObject(obj){
  return Object.fromEntries(Object.entries(obj||{}).filter(([,v])=>v!==undefined&&v!==null&&v!==''&&v!==null));
}

function normalizeGhlFieldName(value){
  return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

function ghlCustomFieldId(field={}){
  return field.id||field._id||field.fieldId||field.customFieldId||'';
}

async function fetchGhlCustomFields(){
  const loc=await resolveGhlLocationId();
  const data=await ghlStrict('GET',`/locations/${encodeURIComponent(loc||GHL_LOC||'')}/customFields`);
  return data.customFields||data.fields||data.data||[];
}

function goallTestContactValues(){
  return {
    'Company Name':'TEST TESTERTON HVAC',
    'Industry':'HVAC',
    'Business Type':'Home Services',
    'State':'Arizona',
    'City':'Phoenix',
    'Employee Count':'35',
    'Company Size':'25 to 50 employees',
    'Owner Name':'TEST TESTERTON',
    'Title':'Owner',
    'Decision Maker':'Yes',
    'Lead Source':'Internal TEST',
    'Lead Type':'Demo/Test Contact',
    'GOALL Fit':'Demo qualified employer profile',
    'Qualification Status':'Test record, not a real prospect',
    'Sales Status':'Demo only',
    'Primary Pain Point':'Employee retention and loyalty',
    'Secondary Pain Point':'Keeping field employees engaged and supported',
    'Benefits Interest':'Interested in employee support and retention programs',
    'Current Benefits Situation':'Demo value, currently unclear',
    'Urgency':'Medium',
    'Estimated Opportunity Value':'50',
    'Pipeline Note':'Demo contact for testing GHL custom fields and HVAC workflow',
    'Follow-Up Status':'No live follow-up, test only',
    'Automation Permission':'Do not automate unless manually approved',
    'Notes':'TEST TESTERTON is a demo contact pretending to own an Arizona HVAC company with 35 employees. Used only for CRM testing.'
  };
}

function goallTestContactTags(){
  return ['HVAC','TEST - DO NOT AUTOMATE'];
}

function goallTestContactNote(){
  return 'TEST/demo contact. TEST TESTERTON is a fictional HVAC company owner in Arizona with 35 employees. Use this record only to test GHL custom fields, tags, workflows, pipeline behavior, and CRM display. Do not treat as a real prospect unless manually approved. Email address used: miken@goallprogram.com. Tag requested: HVAC. Suppress automations if possible.';
}

function isGoallTestContactRequest(text=''){
  const q=String(text||'').toLowerCase();
  return /miken@goallprogram\.com/.test(q)
    && /testerton|test testerton|test contact|demo contact/.test(q)
    && /\b(create|update|upsert|add|execute|do this|make)\b/.test(q);
}

function testContactFieldPayloads(customFields,values){
  const used=new Set();
  const payloads=[];
  for(const [label,value] of Object.entries(values)){
    const wanted=normalizeGhlFieldName(label);
    const found=(customFields||[]).find(f=>{
      const id=ghlCustomFieldId(f);
      if(!id||used.has(String(id))) return false;
      const name=normalizeGhlFieldName(f.name||f.fieldName||'');
      const key=normalizeGhlFieldName(f.fieldKey||f.key||f.field_key||'');
      return name===wanted || key.endsWith(wanted.replace(/\s+/g,' ')) || key.includes(wanted);
    });
    if(found){
      const id=String(ghlCustomFieldId(found));
      used.add(id);
      payloads.push({id,field_value:value});
    }
  }
  return payloads;
}

async function searchGhlContactsByQuery(query,limit=10){
  const loc=await resolveGhlLocationId();
  const data=await ghlStrict('GET',`/contacts/?locationId=${encodeURIComponent(loc||GHL_LOC||'')}&query=${encodeURIComponent(query)}&limit=${limit}`);
  return data.contacts||data.data||[];
}

async function createOrUpdateGoallTestContact(){
  const email='miken@goallprogram.com';
  const contacts=await searchGhlContactsByQuery(email,10).catch(()=>[]);
  const existing=contacts.find(c=>String(c.email||'').toLowerCase()===email) || contacts[0] || null;
  const customFields=await fetchGhlCustomFields().catch(()=>[]);
  const customFieldPayloads=testContactFieldPayloads(customFields,goallTestContactValues());
  const tags=goallTestContactTags();
  const loc=await resolveGhlLocationId();
  const payload=compactObject({
    locationId:loc||GHL_LOC,
    firstName:'TEST',
    lastName:'TESTERTON',
    name:'TEST TESTERTON',
    companyName:'TEST TESTERTON HVAC',
    email,
    city:'Phoenix',
    state:'Arizona',
    country:'US',
    source:'Internal TEST',
    tags,
    customFields:customFieldPayloads.length?customFieldPayloads:undefined
  });
  let contactId=existing?.id||existing?.contactId||'';
  let data;
  if(contactId){
    data=await ghlStrict('PUT',`/contacts/${encodeURIComponent(contactId)}`,payload);
  }else{
    data=await ghlStrict('POST','/contacts',payload);
    const contact=data.contact||data;
    contactId=contact.id||contact.contactId||contact.contact?.id||'';
  }
  if(!contactId) throw new Error('GHL did not return a contact id for TEST TESTERTON.');
  await ghlStrict('POST',`/contacts/${encodeURIComponent(contactId)}/tags`,{tags}).catch(()=>{});
  await ghlStrict('POST',`/contacts/${encodeURIComponent(contactId)}/notes`,{body:goallTestContactNote()}).catch(()=>{});
  return {
    ok:true,
    created:!existing,
    updated:!!existing,
    contactId,
    email,
    name:'TEST TESTERTON',
    company:'TEST TESTERTON HVAC',
    tags,
    customFieldsMatched:customFieldPayloads.length,
    customFieldsAvailable:customFields.length,
    noteAdded:true,
    rawContact:data.contact||data
  };
}

function goallTestContactSummary(result){
  return [
    `${result.created?'Created':'Updated existing'} GHL test contact: TEST TESTERTON.`,
    `Email: ${result.email}`,
    `Company: ${result.company}`,
    `Tags applied: ${(result.tags||[]).join(', ')}`,
    `Contact ID: ${result.contactId}`,
    `Custom fields populated by matching schema: ${result.customFieldsMatched}`,
    `GHL custom fields scanned: ${result.customFieldsAvailable}`,
    result.noteAdded?'Contact note added with TEST/demo safeguard text.':'',
    'Automation suppression requested by tag/note. I did not trigger workflows.'
  ].filter(Boolean).join('\n');
}

function leadCustomFieldsFromProspect(p){
  const name=p.organizationName||p.name||'';
  const donorCount=donorValue(p.approximateDonors||p.estimatedDonors||p.donorCount);
  const enrichment=[
    `Decision maker: ${p.decisionMakerName||'unclear'}`,
    `Title: ${p.decisionMakerTitle||'unclear'}`,
    `Email source: ${p.emailSource||'unclear'} (${p.emailQuality||classifyEmail(p.email)})`,
    `Website contact scrape: ${p.websiteContactStatus||'not run'}`,
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
  const outscraperKey=await resolveIntegrationSecret('outscraper','api_key',OUTSCRAPER_API_KEY);
  if(!outscraperKey) return {configured:false, leads:[], error:'OUTSCRAPER_API_KEY is not set'};
  const url=new URL(OUTSCRAPER_GOOGLE_MAPS_SEARCH_URL);
  url.searchParams.set('query',`${organizationType} businesses in ${market}`);
  url.searchParams.set('limit',String(limit||12));
  url.searchParams.set('async','false');
  const response=await fetch(url.toString(),{headers:{'X-API-KEY':outscraperKey}});
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

function normalizeWebsiteUrl(website){
  const raw=String(website||'').trim();
  if(!raw) return '';
  try{return new URL(raw).href;}catch(_){}
  try{return new URL('https://'+raw.replace(/^\/+/,'')).href;}catch(_){}
  return '';
}

function candidateContactUrls(website){
  website=normalizeWebsiteUrl(website);
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
      new URL('/management',origin).href,
      new URL('/our-team',origin).href,
      new URL('/meet-the-team',origin).href,
      new URL('/executive-team',origin).href,
      new URL('/careers',origin).href,
      new URL('/jobs',origin).href,
      new URL('/services',origin).href,
      new URL('/locations',origin).href,
      new URL('/people',origin).href,
      new URL('/who-we-are',origin).href,
      new URL('/company',origin).href,
      new URL('/directory',origin).href
    ])];
  }catch(_){
    return [];
  }
}

function contactUrlScore(url){
  const text=String(url||'').toLowerCase();
  let score=0;
  if(/team|staff|leadership|management|people|directory/.test(text)) score+=8;
  if(/about|who-we-are|company/.test(text)) score+=5;
  if(/contact/.test(text)) score+=4;
  if(/career|job/.test(text)) score+=1;
  if(/privacy|terms|login|cart|shop|blog|news|event|wp-content|uploads/.test(text)) score-=10;
  return score;
}

function emailScore(candidate){
  const email=String(candidate.email||'').toLowerCase();
  const local=email.split('@')[0]||'';
  const quality=candidate.quality||classifyEmail(email);
  let score=({person:80,'high-value role':70,general:35,missing:0}[quality]||0);
  if(/^(owner|founder|ceo|president|coo|operations|director|sales|partnerships|hr|benefits)$/.test(local)) score+=18;
  if(/^(info|hello|contact)$/.test(local)) score+=6;
  if(/^(admin|office|team|support|service|customerservice)$/.test(local)) score-=10;
  if(/^(frontdesk|reception|appointments|billing|noreply|no-reply|donotreply)$/.test(local)) score-=35;
  score+=Math.min(12,Math.max(0,contactUrlScore(candidate.source)));
  return score;
}

function bestEmail(candidates){
  const unique=[...new Map(candidates.filter(c=>c.email).map(c=>[c.email.toLowerCase(),{...c,email:c.email.toLowerCase(),quality:classifyEmail(c.email)}])).values()];
  unique.sort((a,b)=>emailScore(b)-emailScore(a));
  return unique[0]||{email:'',source:'',quality:'missing'};
}

function titleScore(title){
  const t=String(title||'').toLowerCase();
  if(!t) return 0;
  let score=0;
  if(/\b(owner|founder|co-founder|chief executive|ceo|president|principal|managing partner)\b/.test(t)) score+=100;
  if(/\b(chief operating|coo|operations|general manager|executive director|managing director)\b/.test(t)) score+=85;
  if(/\b(vp|vice president|director|head of|sales|partnership|business development|human resources|hr|benefits|people)\b/.test(t)) score+=70;
  if(/\b(manager|administrator)\b/.test(t)) score+=25;
  if(/\b(reception|front desk|assistant|coordinator|office manager|admin|customer service|support|billing|scheduler)\b/.test(t)) score-=60;
  return score;
}

function isGatekeeperTitle(title){
  return titleScore(title)<20 && /\b(reception|front desk|assistant|coordinator|office manager|admin|customer service|support|billing|scheduler)\b/i.test(String(title||''));
}

function betterLeader(a={},b={}){
  if(!b.name) return a;
  if(!a.name) return b;
  const aScore=titleScore(a.title)+contactUrlScore(a.source);
  const bScore=titleScore(b.title)+contactUrlScore(b.source);
  return bScore>aScore ? b : a;
}

function extractLeadership(text){
  const clean=String(text||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const titles='Chief Executive Officer|CEO|Founder|Co-Founder|Owner|President|Principal|Managing Partner|Executive Director|Managing Director|Operations Manager|Director of Operations|Chief Operating Officer|COO|HR Director|Human Resources Director|Benefits Manager|Sales Director|VP Sales|Vice President of Sales|Partnerships Director|Business Development Director|General Manager|Office Manager|Administrative Assistant|Receptionist|Front Desk';
  const titleFirst=new RegExp(`\\b(${titles})\\b\\s*[:\\-–|,]?\\s*([A-Z][A-Za-z.'’\\-]+(?:\\s+[A-Z][A-Za-z.'’\\-]+){1,3})`,'gi');
  const nameFirst=new RegExp(`\\b([A-Z][A-Za-z.'’\\-]+(?:\\s+[A-Z][A-Za-z.'’\\-]+){1,3})\\s*[,\\-–|]+\\s*(${titles})\\b`,'gi');
  let best={name:'',title:''};
  for(const re of [nameFirst,titleFirst]){
    for(const m of clean.matchAll(re)){
      const candidate = re===nameFirst ? {name:m[1].trim(),title:m[2].trim()} : {name:m[2].trim(),title:m[1].trim()};
      if(!/^(Contact Us|About Us|Our Team|Learn More)$/i.test(candidate.name)) best=betterLeader(best,candidate);
    }
  }
  return isGatekeeperTitle(best.title) ? {name:'',title:''} : best;
}

function extractInternalContactLinks(html,pageUrl,origin){
  const urls=[];
  const text=String(html||'');
  for(const m of text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){
    const href=decodeBasicHtmlEntities(m[1]||'').trim();
    if(!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try{
      const url=new URL(href,pageUrl);
      if(url.origin!==origin) continue;
      url.hash='';
      const path=(url.pathname||'').toLowerCase();
      if(/contact|about|team|staff|leadership|management|people|directory|company|who-we-are|owner|founder|executive/.test(path)){
        urls.push(url.href);
      }
    }catch(_){}
  }
  return urls;
}

async function findPublicWebsiteContactData(website){
  const normalized=normalizeWebsiteUrl(website);
  const origin=normalized?new URL(normalized).origin:'';
  const urls = candidateContactUrls(normalized);
  const emails=[];
  let leader={name:'',title:''};
  const seen=new Set();
  for(let i=0;i<urls.length&&i<28;i++){
    const url=urls[i];
    if(seen.has(url)) continue;
    seen.add(url);
    const text = await fetchTextWithTimeout(url);
    if(!text) continue;
    extractEmailsFromValue(text).forEach(email=>emails.push({email,source:url}));
    if(origin && i<10){
      for(const linked of extractInternalContactLinks(text,url,origin).sort((a,b)=>contactUrlScore(b)-contactUrlScore(a))){
        if(!seen.has(linked) && !urls.includes(linked)) urls.push(linked);
      }
    }
    const found=extractLeadership(text);
    if(found.name) leader=betterLeader(leader,{...found,source:url});
    const currentBest=bestEmail(emails);
    if(emailScore(currentBest)>=88 && leader.name && titleScore(leader.title)>=70) break;
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
      'Before returning email as missing, check the company website contact, about, team, staff, leadership, management, people, directory, careers, and footer sections for public person or role emails.',
      'Avoid gatekeepers as decisionMakerName when a founder, owner, CEO, president, operations, HR/benefits, sales, or partnership leader is public.',
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
      '{"leads":[{"organizationName":"","website":"","industry":"","primaryService":"","location":"","organizationType":"","partnerFit":"","approximateDonors":0,"donorEstimateBasis":"","evidenceSignals":[""],"decisionMakerName":"","decisionMakerTitle":"","decisionMakerSource":"","email":"","emailSource":"","emailQuality":"","phone":"","linkedinPersonalUrl":"","linkedinCompanyUrl":"","hiringActivity":"","careersPage":"","growthActivity":"","operationalActivity":"","socialActivity":"","operationalIndicators":"","weakFitConcerns":"","googleRaw":"","newsRaw":"","nextOutreachAngle":"","confidence":""}]}'
    ].join('\n');
    raw=await callOpenAIWebResearch({system,user,maxTokens:6000,temperature:0.15,meta:{requestReason:'lead_discovery_fallback_web_search'}});
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
  const rocketReachKey=await resolveIntegrationSecret('rocketreach','api_key',ROCKETREACH_API_KEY);
  if(!rocketReachKey) return {...p,rocketReachStatus:'ROCKETREACH_API_KEY is not set'};
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
    const existingEmailScore=next.email?emailScore({email:next.email,quality:next.emailQuality,source:next.emailSource}):0;
    if(publicContact.email && emailScore(publicContact)>existingEmailScore){
      next.email = publicContact.email;
      next.emailSource = publicContact.source;
      next.emailQuality = publicContact.quality;
    }
    if(publicContact.leader?.name && (!next.decisionMakerName || titleScore(publicContact.leader.title)>titleScore(next.decisionMakerTitle))){
      next.decisionMakerName = publicContact.leader.name;
      next.decisionMakerTitle = publicContact.leader.title || next.decisionMakerTitle || '';
      next.decisionMakerSource = publicContact.leader.source || '';
    }
    if(publicContact.source){
      next.websiteContactStatus = [
        publicContact.email?`email found: ${publicContact.quality}`:'no email found',
        publicContact.leader?.name?`decision-maker signal: ${publicContact.leader.title}`:'no decision-maker signal'
      ].join('; ');
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

Client configuration: this VAL supports ${CLIENT_CONFIG.clientName}. ${process.env.VAL_CLIENT_CONTEXT || 'Prioritize relationship context, calendar awareness, tasks, transcripts, contact notes, pipeline clarity, next best action, and concise executive visibility.'}

Contact notes are critical context. GHL may create notes after phone calls with transcript content. When a contact, caller, prospect, or opportunity is discussed, use all available GHL notes provided in context as source material. Always give the user a clear overview of what the notes reveal: caller history, objections, promises, buying signals, sales status, risks, follow-up needs, and next actions. Do not summarize a contact without checking the provided GHL note history.

GOALL Agency lead intelligence: when the user asks to research a lead, identify a target market, qualify a company, structure prospect data, or prepare CRM fields, evaluate whether the company is a strong business lead for GOALL based on employee count, growth signals, operational complexity, public presence, decision-maker clarity, and sales opportunity. Use the GOALL standard: factual, restrained, source-prioritized, no guessing, and structured for GHL.

Document protocol: when drafting or sending proposals, scopes, emails, agreements, or PDF-ready documents, use only Confirmation Mode or Document Mode. In Confirmation Mode, confirm the recipient email before drafting/sending. In Document Mode, output exactly three blocks: DRAFT or FINAL, recipient email only, full document content. The first line of the document content must be Proposal: {Topic}, Subject: {Email Subject}, or Scope: {Topic}. FINAL is only used after explicit approval and confirmed recipient email; FINAL document content ends with: To send this now, click the Send button in the top right of this chat.

Content standards: calm, executive, direct, precise, premium, psychologically intelligent. No emojis. No hype. Do not overpromise or invent pricing/scope. Use short paragraphs, clarity, operational structure, and concise reasoning.

Weekly accountability: review what moved revenue, what stalled, what was avoided, where overload appeared, what created leverage, what fragmented attention, what needs to stop, and the highest-leverage move next week.

Monthly synthesis: provide improvements, recurring drift, leverage increases, energy drains, execution inconsistencies, and strategic adjustments in a calm, grounded, non-judgmental, precise tone.

Final governing principle: you are not here to maximize activity. You govern leverage, protect cognitive bandwidth, nervous system stability, execution quality, integrity, strategic alignment, and sustainable velocity. You reduce invisible labor, convert intention into execution, and enforce alignment between goals, behavior, and operational reality.
`.trim();

function actionPrompt(action){
  const prompts={daily_command:'Create a relationship-first daily command briefing for a founder/executive whose highest leverage is high-trust connection. Include today meetings, 15-minute prep needs, urgent promises, relationship radar, approvals waiting, email intelligence including important unread emails, needed replies, waiting-on-response items, forwarding suggestions, rule suggestions, ignored email count, appointment recap drafts, one focus block, the single highest-leverage action, and one high-impact use of the time VAL is saving. Be assertive and practical.',what_now:'Choose exactly what the user should do next. Consider energy, urgency, calendar, overdue tasks, user memory, business leverage, and whether VAL has freed time that should be spent on a higher-value relationship, strategic move, recovery block, or creative work. Be decisive.',weekly_review:'Create a weekly review: wins, stuck loops, avoided work, relationship follow-ups, stop/start/continue, and top 3 priorities for next week.',relationship_briefing:'Create a relationship briefing for the person or meeting named by the user. Include context, last known interaction, tone, likely needs, open promises, opportunity angle, questions, and follow-up suggestions.',project_space:'Create a project-space view for the requested project: current context, docs/memory, open tasks, decisions, risks, and next actions.',task_intelligence:'Review the task list. Group by urgency/energy/project/contact, flag stale/vague tasks, rewrite vague tasks into next actions, and recommend what to clear first. Do not suggest deleting tasks without user approval.',followup_radar:'Rank the highest-priority relationships to nurture now. Focus on people where trust, revenue, referrals, partnership, or promised follow-up could be lost if ignored. For each person include why now, what was promised or implied, the smallest next action, and a ready-to-send message draft when appropriate.',relationship_radar:'Create a Relationship Radar view. Rank high-value contacts by urgency and opportunity. Use calendar, conversations, tasks, pipeline, memory, and open loops. For each person include relationship context, why they matter, what is at risk, next best action, and a ready-to-send message when appropriate.',pre_meeting_brief:'Prepare the next meeting as if it starts in 15 minutes. Identify all attendees, infer who matters most, summarize prior context, open promises, current opportunity, likely objective, relationship risks, suggested opening line, three questions, and the cleanest follow-up VAL should send afterward.',auto_followups:'Review recent meetings and conversations. Draft the follow-ups VAL should send now. For each draft include recipient, why it should go now, subject, message body, and whether it is safe to send automatically or should sit in the Approval Queue.',contact_command_center:'Create a contact command center for the relevant person or company. Group all tasks, notes, promises, meetings, opportunities, relationship context, and suggested next moves by contact. Make it easy to see what is waiting on them and what is waiting on the user.',integrity_tracker:'Audit open promises and commitments. List what the user said they would do, who it is for, source/context, due timing if known, risk if dropped, and the next closure action. Do not suggest deleting tasks. The user must close loops manually.',daily_rhythm:'Run the daily executive rhythm: morning briefing, midday check-in, end-of-day wrap, and tomorrow prep. Keep it relationship-first. Surface dynamic prompts based on meetings, overdue tasks, approvals, stale relationships, pipeline urgency, and high-impact use of saved time.',saved_time_leverage:'Suggest the highest-impact things the user could do with the time, energy, and cognitive load VAL is saving. Focus on moves that create revenue, deepen high-value relationships, strengthen authority, protect recovery, improve strategic thinking, or create long-term leverage. Give 3 to 5 options, explain why each matters, and recommend one to do now.',onboarding_profile:'Run the Tell Me About Yourself onboarding. Ask one deep question at a time to understand identity, business model, high-value relationships, communication style, decision patterns, energy patterns, personality profile, boundaries, approval preferences, and documents to upload. Be warm, direct, and psychologically insightful.',executive_review:'Run an executive review in this exact order. First: review Email Intelligence, including important unread emails, emails needing reply, waiting-on-response items, forwarding suggestions, rule suggestions, ignored email count, and appointment recap drafts. Second: include Relationship Intelligence: highest leverage relationship, top 3 relationship priorities, one cooling relationship, one forgotten commitment, one suggested introduction, and one hidden opportunity. Third: draft all follow-ups that should go out now and indicate which ones belong in the Approval Queue. Fourth: prep the next meeting with attendees, likely objective, context, risks, and 3 opening talking points. Fifth: clean up the task list by grouping tasks into do now, delegate, defer, delete candidate, and needs clarification. Do not delete tasks. End with one question only: "Do you want me to approve follow-ups, prep the meeting deeper, or clean the task list first?" Keep this concise and action-oriented. Do not create a broad report.',document_vault:'Answer from saved documents/memory. Name the most relevant documents or chunks and summarize what matters.',lead_intelligence:'Use the GOALL Agency lead intelligence standard for business lead research. Qualify the company by employee base, growth signals, operational complexity, public presence, decision-maker clarity, and sales opportunity. Structure verifiable prospect data and recommend the next practical outreach step. Do not guess.'};
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
  const sourceId=payload.savedTranscriptId||payload.id||payload.transcriptId||payload.sourceId||title;
  const memory=await recentMemoryContext(title+' '+transcript.slice(0,1000));
  const system=[VAL_SYSTEM_PROMPT,'You process transcripts for VAL. Your job is to prevent commitments from leaking.','Extract every unresolved promise, next step, follow-up, owner action, waiting-for item, meeting prep need, and task implied by the conversation.','If someone says they will send, review, schedule, introduce, decide, follow up, check, draft, prepare, update, research, or circle back, that belongs in actionItems unless it was explicitly completed in the transcript.','If a follow-up message should be sent after the meeting, include it in followupDrafts and also create a matching actionItems entry unless another action item already covers it.','Do not invent work. Do not create tasks for completed items. When due timing is unclear, use null.','Return strict JSON with keys: summary, actionItems, decisions, people, memoryUpdates, followupDrafts.','actionItems must be an array of objects with title, dueDate, notes, priority, contactName, person, evidence.','Every action item title should start with a verb and be clear enough to execute without reopening the transcript.',memory?'Relevant saved memory:\n'+memory:''].filter(Boolean).join('\n\n');
  const raw=await callValModel({
    system,
    user:'Transcript title: '+title+'\n\nTranscript:\n'+transcript.slice(0,30000),
    maxTokens:1800,
    temperature:0.2,
    json:true,
    meta:{
      routeJobSource:'transcript_processing',
      transcriptId:sourceId,
      transcriptHash:crypto.createHash('sha256').update(String(transcript)).digest('hex').slice(0,16),
      requestReason:'process_transcript'
    }
  });
  let parsed={};
  try{parsed=JSON.parse(raw);}catch(e){parsed={summary:raw,actionItems:[],decisions:[],people:[],memoryUpdates:[],followupDrafts:[]};}
  const createdTasks=[];
  const createdDrafts=[];
  const taskItems=Array.isArray(parsed.actionItems)?parsed.actionItems.slice(0,18):[];
  const rawFollowupDrafts=(Array.isArray(parsed.followupDrafts)?parsed.followupDrafts:[]).slice(0,8);
  const followupItems=rawFollowupDrafts.map(f=>({title:f.title||f.task||('Send follow-up'+(f.recipient||f.contactName||f.person?' to '+(f.recipient||f.contactName||f.person):'')),contactName:f.contactName||f.person||f.recipient||'',dueDate:f.dueDate||null,notes:[f.reason||'',f.subject?'Subject: '+f.subject:'',f.message||f.body||''].filter(Boolean).join('\n'),priority:f.priority||'high',evidence:f.evidence||'Follow-up draft created from transcript'}));
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
  for(const f of rawFollowupDrafts){
    const body=f.message||f.body||'';
    if(!body.trim()) continue;
    createdDrafts.push(await saveInternalDraft({draftType:'follow_up',provider:'internal',subject:f.subject||('Follow-up: '+title),body,status:'draft',sourceContext:{source:'transcript_processing',transcriptId:sourceId,recipient:f.recipient||f.email||'',person:f.person||f.contactName||'',reason:f.reason||''}}));
  }
  if(Array.isArray(parsed.memoryUpdates)){
    for(const m of parsed.memoryUpdates.slice(0,12)){
      const text=typeof m==='string'?m:(m.text||m.summary||JSON.stringify(m));
      await saveMemoryItem({kind:'transcript_insight',summary:title,rawText:text,importance:3,metadata:{title,source:'transcript_processing'}});
    }
  }
  let meetingMatch=payload.meetingMatch||null;
  if(!meetingMatch){
    try{
      meetingMatch=await linkTranscriptToBestMeeting({id:sourceId,title,rawText:transcript,metadata:payload.metadata||payload,createdAt:payload.timestamp||payload.createdAt||new Date().toISOString()});
    }catch(e){console.log('Transcript meeting match skipped:',e.message);}
  }
  console.log(`Transcript processed: title="${title}" actionItems=${taskItems.length} tasksCreated=${createdTasks.length} draftsCreated=${createdDrafts.length} meetingMatched=${!!meetingMatch}`);
  return {analysis:parsed,createdTasks,createdDrafts,meetingMatch,counts:{actionItemsExtracted:taskItems.length,tasksCreated:createdTasks.length,draftsCreated:createdDrafts.length,meetingMatched:meetingMatch?1:0}};
}
app.post('/api/val/transcripts',async(req,res)=>{try{const body=req.body||{};const transcriptText=body.transcript||body.rawText||body.text||'';console.log('Transcript received:',body.title||body.type||'untitled');const saved=await saveTranscript({...body,transcript:transcriptText});const transcriptRecord={id:saved.id,title:body.title||saved.type,rawText:transcriptText,metadata:body,createdAt:body.timestamp||body.createdAt||new Date().toISOString()};const meetingMatch=await linkTranscriptToBestMeeting(transcriptRecord).catch(e=>{console.log('Transcript link failed:',e.message);return null;});if(body&&body.process!==false)return res.json({ok:true,...saved,...await processTranscriptPayload({...body,transcript:transcriptText,savedTranscriptId:saved.id,meetingMatch})});res.json({ok:true,...saved,meetingMatch});}catch(e){console.error('Transcript save/process error:',e.message);res.status(500).json({error:e.message});}});
app.post('/api/val/transcripts/process',async(req,res)=>{try{const body=req.body||{};const transcriptText=body.transcript||body.rawText||body.text||'';const title=body.title||'Processed transcript';const saved=await saveTranscript({type:'processed_transcript',title,transcript:transcriptText,metadata:{source:body.source||'manual_process'},importance:3});const transcriptRecord={id:saved.id,title,rawText:transcriptText,metadata:body,createdAt:body.timestamp||body.createdAt||new Date().toISOString()};const meetingMatch=await linkTranscriptToBestMeeting(transcriptRecord).catch(e=>{console.log('Transcript link failed:',e.message);return null;});res.json({ok:true,...saved,...await processTranscriptPayload({...body,transcript:transcriptText,title,savedTranscriptId:saved.id,meetingMatch})});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/conversations',async(req,res)=>{try{res.json({ok:true,...await saveConversation(req.body||{})});}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/val/conversations',async(req,res)=>{try{if(DEMO_MODE){const state=demoState(req,res);const rows=[...(state.savedConversations||[]),{id:'demo-chat-1',title:'Morning Relationship Briefing',source:'chat',metadata:{demo:true},created_at:demoIso(0,8,0),updated_at:demoIso(0,8,12)},{id:'demo-chat-2',title:'Pipeline Priorities Review',source:'chat',metadata:{demo:true},created_at:demoIso(-1,15,30),updated_at:demoIso(-1,15,48)},{id:'demo-chat-3',title:'Meeting Follow-Up Drafts',source:'chat',metadata:{demo:true},created_at:demoIso(-2,10,0),updated_at:demoIso(-2,10,25)}];return res.json(rows.slice(0,Number(req.query.limit)||25));}await valDbReady;if(pgPool){const r=await dbQuery('select id,title,source,metadata,created_at,updated_at from val_conversations where user_id=$1 order by updated_at desc limit $2',[VAL_USER_ID,Number(req.query.limit)||25]);return res.json(r.rows);}res.json(valStore().conversations.slice(0,Number(req.query.limit)||25));}catch(e){res.status(500).json({error:e.message});}});
app.get('/api/val/conversations/:id/messages',async(req,res)=>{try{if(DEMO_MODE){const state=demoState(req,res);const sets={'demo-chat-1':[{role:'user',content:'What needs my attention today?',created_at:demoIso(0,8,0)},{role:'assistant',content:withDemoCta('Marcus needs the pilot memo before the 2 PM demo. Elena needs the scope revision. Jordan has a warm intro offer that should not sit.'),created_at:demoIso(0,8,1)}],'demo-chat-2':[{role:'user',content:'Show me pipeline risk.',created_at:demoIso(-1,15,30)},{role:'assistant',content:withDemoCta('HealthBridge is the risk. The expansion is not blocked by value. It is blocked by sponsor fatigue and implementation load.'),created_at:demoIso(-1,15,31)}],'demo-chat-3':[{role:'user',content:'Draft the follow-ups.',created_at:demoIso(-2,10,0)},{role:'assistant',content:withDemoCta('I would queue three drafts: Marcus pilot memo, Elena revised scope, and Jordan one-paragraph intro ask.'),created_at:demoIso(-2,10,1)}]};return res.json(state.savedConversationMessages?.[req.params.id]||sets[req.params.id]||[]);}await valDbReady;if(pgPool){const r=await dbQuery('select role,content,metadata,created_at from val_messages where conversation_id=$1 order by created_at asc',[req.params.id]);return res.json(r.rows);}res.json(valStore().messages.filter(m=>m.conversationId===req.params.id));}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/val/meeting-briefing',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const input=req.body||{};
      const meeting={...input,id:input.eventId||input.id,title:input.title||input.summary||'',source:input.source||'demo',attendees:Array.isArray(input.attendees)?input.attendees:[]};
      const state=demoState(req,res);
      const attendees=inferAttendeesFromEvent(meeting);
      const nameText=attendees.map(a=>a.name||a.email).join(', ') || 'attendees unclear';
      const relatedTasks=(state.tasks||[]).filter(t=>!t.completed&&[meeting.title,nameText].some(v=>String(v||'').toLowerCase().includes(String(t.contactName||'').toLowerCase()))).slice(0,4);
      const transcriptContext=(state.transcripts||[]).filter(t=>String(t.title||'').toLowerCase().includes(String(meeting.title||'').split(' ')[0]?.toLowerCase()||'')).slice(0,2);
      const briefing=[
        `What matters: ${meeting.title||'This meeting'} is tied to active revenue, relationship momentum, or an open promise.`,
        `Attendees: ${nameText}.`,
        relatedTasks.length?`Open loops: ${relatedTasks.map(t=>t.title).join('; ')}.`:'Open loops: ask what would make this conversation useful and listen for the next concrete owner.',
        'Suggested posture: be clear, concise, and move toward one specific next step.',
        `After the call: VAL would draft the follow-up, create any tasks, and keep the relationship visible.`
      ].join('\n\n');
      return res.json({ok:true,meeting:{...meeting,attendees},gmailContext:state.emails.slice(0,3),transcriptContext,taskContext:relatedTasks,memoryContext:['Demo memory: VAL tracks promises, relationship context, meeting notes, and open loops.'],contactNotes:[],briefing,openLoops:relatedTasks.map(t=>t.title),suggestedQuestions:['What would make this a clear win by the end of the call?','Who else needs to be involved before this moves?','What should I send after we hang up?'],recommendedFollowUps:['Send concise recap','Create next-step task','Update opportunity notes']});
    }
    const input=req.body||{};
    let meeting={...input,id:input.eventId||input.id,title:input.title||input.summary||'',source:input.source||'unknown',attendees:Array.isArray(input.attendees)?input.attendees:[]};
    if(meeting.source==='google'&&meeting.id){
      const token=await getGoogleToken();
      if(token){
        const r=await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(meeting.id)}?maxAttendees=50`,{headers:{Authorization:`Bearer ${token}`}});
        const full=await readJsonResponse(r);
        if(r.ok) meeting={...mapGoogleEvent(full),eventId:full.id};
      }
    }
    const attendees=inferAttendeesFromEvent(meeting);
    const ghlQuery=[meeting.title,meeting.summary,...attendees.flatMap(a=>[a.name,a.email])].filter(Boolean).join(' ');
    const [gmail,transcripts,tasks,memory,ghlContext]=await Promise.all([
      fetchGmailMessages({query:gmailMeetingQuery(meeting),maxResults:12}).catch(e=>({emails:[],error:e.message})),
      matchingTranscriptContext(meeting,5).catch(()=>[]),
      matchingTaskContext(meeting,12).catch(()=>[]),
      recentMemoryContext(ghlQuery).catch(()=>''),
      ghlPlatformContext(ghlQuery,{appointments:[meeting]},{limit:10,opportunityLimit:20,conversationLimit:8,notesLimit:6,taskLimit:6}).catch(()=>'')
    ]);
    const openLoops=tasks.map(t=>t.title).slice(0,8);
    const context=[
      'Meeting: '+(meeting.title||meeting.summary||'(No title)'),
      attendees.length?'Attendees: '+attendees.map(a=>a.name||a.email).join(', '):'Attendees: unclear',
      gmail.emails?.length?'Recent Gmail context:\n'+gmail.emails.slice(0,5).map(e=>`- ${e.subject} from ${e.from?.email||e.from?.name||'unknown'}: ${e.snippet||e.bodyPreview||''}`).join('\n'):'',
      transcripts.length?'Transcript context:\n'+transcripts.map(t=>`- ${t.title}: ${t.summary}`).join('\n'):'',
      tasks.length?'Open tasks:\n'+tasks.map(t=>`- ${t.title}`).join('\n'):'',
      memory?'Memory:\n'+memory:'',
      ghlContext?'GHL platform context:\n'+ghlContext:''
    ].filter(Boolean).join('\n\n');
    const briefing=await callValModel({system:[VAL_SYSTEM_PROMPT,'Create a concise meeting briefing from only the supplied context. Include what matters, risks, open loops, suggested questions, and follow-up recommendations.'].join('\n\n'),user:context,maxTokens:1200,temperature:0.25,meta:{requestReason:'meeting_briefing'}});
    res.json({ok:true,meeting:{...meeting,attendees},gmailContext:gmail.emails||[],gmailError:gmail.error||'',transcriptContext:transcripts,taskContext:tasks,memoryContext:memory?memory.split('\n\n').slice(0,6):[],ghlContext:ghlContext?ghlContext.split('\n\n').slice(0,8):[],contactNotes:ghlContext?ghlContext.split('\n\n').slice(0,6):[],briefing,openLoops,suggestedQuestions:[],recommendedFollowUps:[]});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/relationships/review',async(req,res)=>{
  try{
    if(DEMO_MODE){
      const relationships=demoState(req,res).relationships||[];
      return res.json({ok:true,windowDays:Number(req.query.windowDays)||7,total:relationships.length,highestPriority:relationships.slice(0,3),relationships,summary:{needsNurture:3,atRisk:1,hiddenOpportunity:2},recommendedNextAction:relationships[0]?.recommendedAction||'Review your highest-priority relationship.'});
    }
    const windowDays=Math.min(Math.max(Number(req.query.windowDays)||7,1),90);
    res.json(await buildRelationshipReview({windowDays}));
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});
app.post('/api/relationships/actions',async(req,res)=>{
  try{
    const action=String(req.body.action||'').trim();
    const contact=req.body.contact||{};
    if(!contact.name&&!contact.email) return res.status(400).json({ok:false,error:'Missing contact'});
    if(action==='draft_message'){
      const draft=await saveInternalDraft({draftType:'relationship_outreach',provider:'internal',subject:req.body.subject||contact.draftOutreach?.subject||`Follow-up with ${contact.name||contact.email}`,body:req.body.body||contact.draftOutreach?.body||draftRelationshipOutreach(contact).body,sourceContext:{source:'relationship_review',contact}});
      return res.json({ok:true,draft});
    }
    if(action==='create_task'){
      const task={id:uuid('task'),title:req.body.title||contact.recommendedAction||`Follow up with ${contact.name||contact.email}`,contactName:contact.name||contact.email||'',dueDate:req.body.dueDate||null,notes:req.body.notes||`Created from Relationship Review. Score: ${contact.score||'unknown'}`,details:[{text:'Created from Relationship Review',ts:new Date().toISOString()}],completed:false,createdAt:new Date().toISOString()};
      await saveTask(task);
      return res.json({ok:true,task});
    }
    if(['mark_vip','snooze','not_important'].includes(action)){
      await saveMemoryItem({kind:'relationship_preference',summary:`${action}: ${contact.name||contact.email}`,rawText:JSON.stringify({action,contact,until:req.body.until||''}),importance:action==='mark_vip'?4:2,metadata:{source:'relationship_review',action,contact}});
      return res.json({ok:true,status:'saved'});
    }
    if(action==='brainstorm'){
      const evidence=(contact.evidence||[]).map(e=>`- [${e.type}] ${e.summary}`).join('\n');
      const content=await callValModel({system:[VAL_SYSTEM_PROMPT,'Brainstorm specific, evidence-based ways to strengthen one relationship. Do not invent facts. Give practical value-add ideas, useful introductions, follow-up topics, strategic conversations, and collaboration ideas.'].join('\n\n'),user:`Contact: ${contact.name||contact.email}\nScore: ${contact.score||''}\nRecommended action: ${contact.recommendedAction||''}\nEvidence:\n${evidence||'No evidence supplied.'}`,maxTokens:900,temperature:0.35,meta:{contactId:contact.id||contact.contactId||'',requestReason:'relationship_brainstorm'}});
      return res.json({ok:true,content});
    }
    res.status(400).json({ok:false,error:'Unsupported action'});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post('/api/val/intelligence',async(req,res)=>{
  try{
    const action=req.body.action||'what_now',query=req.body.query||'',dashboard=req.body.dashboard||{},tasks=Array.isArray(req.body.tasks)?req.body.tasks:[];
    if(DEMO_MODE){
      const s=demoState(req,res);
      const top=s.relationships?.[0];
      let content=`Recommended next move: ${top?.recommendedAction||'Start with the highest-priority relationship.'}\n\nVAL is weighing meetings, unread messages, open tasks, draft queue, and active pipeline together. In this demo, the sharpest move is to protect the Marcus deal first, then close the Elena scope loop, then use Jordan's warm intro while it is still fresh.`;
      if(action==='executive_review'||/review/i.test(action))content='Executive review: your biggest leverage is not another meeting. It is finishing the three promises already in motion: Marcus pilot memo, Elena scope revision, and Jordan intro language. Priya needs care, not pressure. That is the difference between velocity and sprawl.';
      if(action==='relationship_radar'||/relationship/i.test(action))content='Relationship review: Marcus, Elena, and Jordan need attention now. Marcus is revenue-sensitive. Elena is influence-sensitive. Jordan is momentum-sensitive. Priya is trust-sensitive, so handle her with patience before expansion.';
      return res.json({ok:true,action,content:withDemoCta(content),demo:true});
    }
    const contextQuery=`${action} ${query} ${JSON.stringify(dashboard).slice(0,2500)}`;
    const [memory,ghlContext]=await Promise.all([
      recentMemoryContext(`${action} ${query}`),
      ghlPlatformContext(contextQuery,dashboard,{limit:10,opportunityLimit:35,conversationLimit:10,notesLimit:6,taskLimit:6}).catch(()=>'')
    ]);
    const system=[
      VAL_SYSTEM_PROMPT,
      'Use saved memory, dashboard data, GHL CRM context, GHL notes, GHL opportunities, GHL tasks, and the requested action. Be specific, practical, and decisive.',
      memory?'Relevant saved memory:\n'+memory:'',
      ghlContext?'Platform-wide GHL MCP context:\n'+ghlContext:''
    ].filter(Boolean).join('\n\n');
    const user=[
      'Requested VAL action: '+action,
      'Instruction: '+actionPrompt(action),
      query?'User query: '+query:'',
      'Dashboard JSON: '+JSON.stringify(dashboard).slice(0,9000),
      'Tasks JSON: '+JSON.stringify(tasks).slice(0,9000)
    ].filter(Boolean).join('\n\n');
    res.json({ok:true,action,ghlContextAvailable:!!ghlContext,content:await callValModel({system,user,maxTokens:1800,temperature:0.35,meta:{requestReason:'val_intelligence:'+action}})});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/val/chat',async(req,res)=>{
  try{
    const messages=Array.isArray(req.body.messages)?req.body.messages:[],lastUser=[...messages].reverse().find(m=>m.role==='user')?.content||'',memoryQuery=messages.slice(-10).map(m=>m.content||'').join('\n').slice(-6000),dashboard=req.body.dashboard||{};
    if(DEMO_MODE){
      const s=demoState(req,res);
      const q=lastUser.toLowerCase();
      let content='Here is what I see in this demo VAL: Marcus needs a pilot memo before the 2 PM demo, Elena is waiting on a clearer first-30-days scope, Priya has a renewal risk because her team feels stretched, and Jordan offered a warm intro that should be used while it is still fresh.';
      if(/meeting|prep|calendar|today|next/i.test(q))content='For today, prep the Marcus demo first. The procurement owner and onboarding load are the two issues that could slow the deal. Then tighten Elena’s first-30-days scope before her investor prep. The useful move is not more activity. It is making each conversation easier to advance.';
      else if(/relationship|radar|who matters|priority/i.test(q))content='Highest-priority relationships right now: Marcus Chen because there is an active deal and a time-sensitive ask, Elena Brooks because she can influence capital and referrals, and Jordan Lee because a warm intro offer is fresh. Priya matters too, but the posture there should be care before expansion.';
      else if(/task|todo|to do|priority/i.test(q))content='Task priority is clear: send Marcus the pilot memo, send Elena the revised first-30-days scope, then review Priya’s renewal risk. The board update can wait. The Northstar intro path is valuable, but it needs one clean paragraph, not a long explanation.';
      else if(/draft|follow/i.test(q))content='I would draft three things: the Marcus pilot memo, Elena’s revised scope reply, and Jordan’s one-paragraph intro ask. In a real VAL account, those would sit in the Approval Queue so you can approve or edit before anything goes out.';
      else if(/reset/i.test(q))content='You can reset this demo any time with the demo reset control. That clears changes made during this visit and restores the sample meetings, tasks, drafts, emails, relationships, and pipeline.';
      content=withDemoCta(content);
      return res.json({message:{role:'assistant',content},demo:true});
    }
    if(isGoallTestContactRequest(lastUser)){
      const result=await createOrUpdateGoallTestContact();
      return res.json({message:{role:'assistant',content:goallTestContactSummary(result)},ghlContact:result,ghlActionExecuted:true});
    }
    const [memory,ghlContext]=await Promise.all([
      recentMemoryContext(lastUser+'\n'+memoryQuery),
      ghlPlatformContext(lastUser+'\n'+memoryQuery,dashboard,{limit:10,opportunityLimit:35,conversationLimit:10,notesLimit:6,taskLimit:6}).catch(()=>'')
    ]);
    const system=[
      VAL_SYSTEM_PROMPT,
      'Use dashboard context, platform-wide GHL CRM context, GHL contact notes, GHL opportunities, GHL tasks, GHL conversations, and saved memory when relevant. Do not pretend to know facts that are not present.',
      'When Recent saved VAL memory contains knowledge_document, processed_transcript, or transcript entries, the text after the colon is available source content. Use it directly. Do not say the document or transcript text is not visible unless no relevant memory entries are present.',
      'When Platform-wide GHL MCP context is present, treat it as current CRM source context across contacts, opportunities, tasks, conversations, and notes.',
      memory?'Recent saved VAL memory:\n'+memory:'',
      ghlContext?'Platform-wide GHL MCP context:\n'+ghlContext:''
    ].filter(Boolean).join('\n\n');
    const content=await callOpenAIResponses({system,messages,maxTokens:1900,temperature:0.7,meta:{requestReason:'val_chat'}});
    res.json({message:{role:'assistant',content:content||'I could not process that.'},ghlContextAvailable:!!ghlContext});
  }catch(e){res.status(500).json({error:e.message});}
});

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
