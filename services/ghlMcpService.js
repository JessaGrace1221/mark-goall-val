const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';
const DEFAULT_VERSION = '2021-07-28';

async function readJsonResponse(response){
  const text = await response.text();
  try{ return text ? JSON.parse(text) : {}; }
  catch(_){ return {raw:text}; }
}

function compactText(value,limit=900){
  return String(value||'').replace(/\s+/g,' ').trim().slice(0,limit);
}

function extractItems(data,...keys){
  for(const key of keys){
    const value=data?.[key];
    if(Array.isArray(value)) return value;
  }
  if(Array.isArray(data?.data)) return data.data;
  if(Array.isArray(data)) return data;
  return [];
}

function createGhlMcpService({
  baseUrl=DEFAULT_BASE_URL,
  apiVersion=DEFAULT_VERSION,
  fallbackApiKey='',
  fallbackLocationId='',
  calendarIds=[],
  resolveSecret,
  getCurrentUser,
  getTenantId,
  inferOwner=()=> '',
  logger=console
}={}){
  if(typeof resolveSecret!=='function') throw new Error('createGhlMcpService requires resolveSecret');

  async function credentials(){
    const [apiKey,locationId,mcpUrl]=await Promise.all([
      resolveSecret('ghl','api_key',fallbackApiKey),
      resolveSecret('ghl','location_id',fallbackLocationId),
      resolveSecret('ghl','mcp_url','')
    ]);
    return {
      apiKey,
      locationId,
      mcpUrl,
      user:getCurrentUser ? getCurrentUser() : null,
      tenantId:getTenantId ? getTenantId() : ''
    };
  }

  function credentialsFromAccount(account={}){
    return {
      apiKey:account.apiKey||account.key||'',
      locationId:account.locationId||account.location_id||'',
      mcpUrl:account.mcpUrl||account.mcp_url||'',
      user:getCurrentUser ? getCurrentUser() : null,
      tenantId:getTenantId ? getTenantId() : '',
      account
    };
  }

  function headersForCredentials(c={}){
    return {
      Authorization:`Bearer ${c.apiKey||''}`,
      Version:apiVersion,
      'Content-Type':'application/json'
    };
  }

  async function headers(){
    return headersForCredentials(await credentials());
  }

  function prepareWithCredentials(path,body,c={}){
    const loc=c.locationId||'';
    let nextPath=String(path||'');
    if(loc){
      const enc=encodeURIComponent(loc);
      nextPath=nextPath
        .replace(/([?&]locationId=)[^&]*/g,`$1${enc}`)
        .replace(/([?&]location_id=)[^&]*/g,`$1${enc}`)
        .replace(/locationId=(&|$)/g,`locationId=${enc}$1`)
        .replace(/location_id=(&|$)/g,`location_id=${enc}$1`)
        .replace(/\/locations\/[^/?#]+/g,`/locations/${enc}`)
        .replace(/\/location\/[^/?#]+/g,`/location/${enc}`)
        .replace(/\/oauth\/[^/?#]+/g,`/oauth/${enc}`)
        .replace(/\/location\/(?=\/|$)/g,`/location/${enc}`)
        .replace(/\/locations\/(?=\/|$)/g,`/locations/${enc}/`);
    }
    let nextBody=body;
    if(loc&&body&&typeof body==='object'&&!Array.isArray(body)){
      nextBody={...body};
      if('locationId' in nextBody) nextBody.locationId=loc;
      if('location_id' in nextBody) nextBody.location_id=loc;
    }
    return {path:nextPath,body:nextBody,credentials:c};
  }

  async function prepare(path,body){
    return prepareWithCredentials(path,body,await credentials());
  }

  function prepareForAccount(path,body,account){
    return prepareWithCredentials(path,body,credentialsFromAccount(account));
  }

  async function request(method,path,body){
    const prepared=await prepare(path,body);
    const r=await fetch(baseUrl+prepared.path,{method,headers:headersForCredentials(prepared.credentials),body:prepared.body?JSON.stringify(prepared.body):undefined});
    return readJsonResponse(r);
  }

  async function requestForAccount(account,method,path,body){
    const prepared=prepareForAccount(path,body,account);
    const r=await fetch(baseUrl+prepared.path,{method,headers:headersForCredentials(prepared.credentials),body:prepared.body?JSON.stringify(prepared.body):undefined});
    return readJsonResponse(r);
  }

  async function requestStrict(method,path,body){
    const prepared=await prepare(path,body);
    const r=await fetch(baseUrl+prepared.path,{method,headers:headersForCredentials(prepared.credentials),body:prepared.body?JSON.stringify(prepared.body):undefined});
    const data=await readJsonResponse(r);
    if(!r.ok){
      const detail=data.message||data.error||data.errorMessage||data.raw||JSON.stringify(data).slice(0,500);
      throw new Error(`GHL ${method} ${path} failed (${r.status}): ${detail}`);
    }
    return data;
  }

  async function requestTry(method,path,body){
    const prepared=await prepare(path,body);
    const r=await fetch(baseUrl+prepared.path,{method,headers:headersForCredentials(prepared.credentials),body:prepared.body?JSON.stringify(prepared.body):undefined});
    const data=await readJsonResponse(r);
    return {ok:r.ok,status:r.status,path:prepared.path,data};
  }

  async function requestTryForAccount(account,method,path,body){
    const prepared=prepareForAccount(path,body,account);
    const r=await fetch(baseUrl+prepared.path,{method,headers:headersForCredentials(prepared.credentials),body:prepared.body?JSON.stringify(prepared.body):undefined});
    const data=await readJsonResponse(r);
    return {ok:r.ok,status:r.status,path:prepared.path,data,account};
  }

  async function isConfigured(){
    const c=await credentials();
    return !!(c.apiKey&&c.locationId);
  }

  async function searchContacts({query='',limit=20,sortBy='date_added',sortDirection='desc'}={}){
    const c=await credentials();
    const qs=new URLSearchParams({locationId:c.locationId||'',limit:String(limit)});
    if(query) qs.set('query',query);
    if(sortBy) qs.set('sortBy',sortBy);
    if(sortDirection) qs.set('sortDirection',sortDirection);
    const data=await request('GET',`/contacts/?${qs.toString()}`);
    return extractItems(data,'contacts').map(contact=>({
      id:contact.id,
      name:contact.contactName||contact.name||[contact.firstName,contact.lastName].filter(Boolean).join(' '),
      email:contact.email||'',
      phone:contact.phone||'',
      company:contact.companyName||contact.businessName||'',
      raw:contact
    }));
  }

  async function getContact(id){
    if(!id) return null;
    const data=await request('GET',`/contacts/${encodeURIComponent(id)}`);
    return data.contact||data;
  }

  async function getContactNotes(id,{limit=20}={}){
    if(!id) return [];
    const data=await request('GET',`/contacts/${encodeURIComponent(id)}/notes`);
    return extractItems(data,'notes','contactNotes').slice(0,limit);
  }

  async function getContactTasks(id,{limit=20}={}){
    if(!id) return [];
    const data=await request('GET',`/contacts/${encodeURIComponent(id)}/tasks`);
    return extractItems(data,'tasks').slice(0,limit);
  }

  async function getConversations({query='',limit=20,status=''}={}){
    const c=await credentials();
    const qs=new URLSearchParams({locationId:c.locationId||'',limit:String(limit)});
    if(query) qs.set('query',query);
    if(status) qs.set('status',status);
    const data=await request('GET',`/conversations/search?${qs.toString()}`);
    return extractItems(data,'conversations');
  }

  async function findOpenOpportunities({status='open',limit=100}={}){
    const c=await credentials();
    return findOpenOpportunitiesForCredentials(c,{status,limit});
  }

  async function findOpenOpportunitiesForAccount(account,{status='open',limit=100}={}){
    return findOpenOpportunitiesForCredentials(credentialsFromAccount(account),{status,limit});
  }

  async function findOpenOpportunitiesForCredentials(c,{status='open',limit=100}={}){
    const encodedLoc=encodeURIComponent(c.locationId||'');
    const encodedStatus=encodeURIComponent(status);
    const attempts=[
      `/opportunities/search?location_id=${encodedLoc}&status=${encodedStatus}&limit=${limit}`,
      `/opportunities/search?locationId=${encodedLoc}&status=${encodedStatus}&limit=${limit}`,
      `/opportunities/search?location_id=${encodedLoc}&limit=${limit}`,
      `/opportunities/search?locationId=${encodedLoc}&limit=${limit}`
    ];
    const results=[];
    for(const path of attempts){
      const prepared=prepareWithCredentials(path,undefined,c);
      const r=await fetch(baseUrl+prepared.path,{method:'GET',headers:headersForCredentials(c)});
      const data=await readJsonResponse(r);
      const opportunities=extractItems(data,'opportunities');
      results.push({path:prepared.path,status:r.status,ok:r.ok,count:opportunities.length,error:r.ok?'':(data?.message||data?.error||data?.raw||'')});
      if(r.ok&&opportunities.length){
        let nextData=data;
        if(!path.includes('status=')){
          const open=opportunities.filter(o=>String(o.status||'').toLowerCase()==='open');
          if(open.length) nextData={...data,opportunities:open,meta:{...(data.meta||{}),total:open.length}};
        }
        return {path:prepared.path,data:nextData,attempts:results,account:c.account};
      }
    }
    const firstOk=results.find(r=>r.ok);
    if(firstOk){
      const prepared=prepareWithCredentials(firstOk.path,undefined,c);
      const r=await fetch(baseUrl+prepared.path,{method:'GET',headers:headersForCredentials(c)});
      return {path:firstOk.path,data:await readJsonResponse(r),attempts:results,account:c.account};
    }
    throw new Error('GHL opportunities search failed: '+results.map(r=>`${r.status} ${r.path}`).join(' | '));
  }

  async function getCalendarEvents(start,end,{selectedCalendarIds=calendarIds}={}){
    const c=await credentials();
    return getCalendarEventsForCredentials(c,start,end,{selectedCalendarIds});
  }

  async function getCalendarEventsForAccount(account,start,end,{selectedCalendarIds=account?.calendarIds||[]}={}){
    return getCalendarEventsForCredentials(credentialsFromAccount(account),start,end,{selectedCalendarIds});
  }

  async function getCalendarEventsForCredentials(c,start,end,{selectedCalendarIds=[]}={}){
    const calendarMap=new Map();
    let ids=(selectedCalendarIds||[]).slice();
    if(!ids.length){
      try{
        const data=await requestForAccount(c.account||c,'GET',`/calendars/?locationId=${encodeURIComponent(c.locationId||'')}`);
        extractItems(data,'calendars').forEach(cal=>{ if(cal.id){ calendarMap.set(String(cal.id),cal.name||cal.title||'GHL Calendar'); ids.push(String(cal.id)); } });
      }catch(e){ logger.error?.('GHL calendar list error:',e.message); }
    }
    ids=Array.from(new Set(ids));
    const range=`locationId=${encodeURIComponent(c.locationId||'')}&startTime=${start.getTime()}&endTime=${end.getTime()}`;
    const calls=ids.length
      ? ids.map(id=>requestForAccount(c.account||c,'GET',`/calendars/events?${range}&calendarId=${encodeURIComponent(id)}`).then(data=>({id,data})))
      : [requestForAccount(c.account||c,'GET',`/calendars/events?${range}`).then(data=>({id:'all',data}))];
    const results=await Promise.allSettled(calls);
    const seen=new Set();
    const events=[];
    results.forEach(result=>{
      if(result.status!=='fulfilled') return;
      const calendarId=result.value.id;
      const list=extractItems(result.value.data,'events','appointments');
      list.forEach(ev=>{
        const key=`${ev.id||ev.appointmentId||ev.startTime||ev.start}-${calendarId}-${c.locationId}`;
        if(seen.has(key)) return;
        seen.add(key);
        events.push({
          id:ev.id||ev.appointmentId,
          title:ev.title||ev.name||ev.summary,
          summary:ev.title||ev.name||ev.summary,
          contactName:ev.contactName||ev.contact?.name,
          contactId:ev.contactId||ev.contact?.id||'',
          startTime:ev.startTime||ev.start,
          endTime:ev.endTime||ev.end,
          status:ev.appointmentStatus||ev.status,
          source:'ghl',
          owner:inferOwner(ev),
          calendarId,
          calendarName:calendarMap.get(String(calendarId))||ev.calendarName||'GHL Calendar',
          accountSlug:c.account?.slug||'default',
          accountLabel:c.account?.label||'GHL',
          raw:ev
        });
      });
    });
    return events;
  }

  async function buildContext(query='',opts={}){
    const text=String(query||'').trim();
    if(!(await isConfigured())) return {configured:false,text:'GHL context unavailable: missing GHL API key or Location ID.',contacts:[],opportunities:[],tasks:[],notes:[],conversations:[]};
    const limit=opts.limit||8;
    const errors=[];
    const [contactsRes,oppsRes,convosRes]=await Promise.allSettled([
      searchContacts({query:text,limit}),
      findOpenOpportunities({status:'open',limit:opts.opportunityLimit||25}),
      getConversations({query:text,limit:opts.conversationLimit||8})
    ]);
    if(contactsRes.status==='rejected') errors.push('contacts: '+contactsRes.reason.message);
    if(oppsRes.status==='rejected') errors.push('opportunities: '+oppsRes.reason.message);
    if(convosRes.status==='rejected') errors.push('conversations: '+convosRes.reason.message);
    const contacts=contactsRes.status==='fulfilled'?contactsRes.value:[];
    const opportunities=oppsRes.status==='fulfilled'?extractItems(oppsRes.value.data,'opportunities'):[];
    const conversations=convosRes.status==='fulfilled'?convosRes.value:[];
    const contactIds=Array.from(new Set([
      ...contacts.map(c=>c.id),
      ...opportunities.map(o=>o.contact?.id||o.contactId).filter(Boolean)
    ])).slice(0,Math.min(6,limit));
    const details=await Promise.allSettled(contactIds.map(async id=>({
      id,
      notes:await getContactNotes(id,{limit:opts.notesLimit||5}).catch(e=>{errors.push(`notes ${id}: ${e.message}`);return [];}),
      tasks:await getContactTasks(id,{limit:opts.taskLimit||5}).catch(e=>{errors.push(`tasks ${id}: ${e.message}`);return [];})
    })));
    const notes=[],tasks=[];
    details.forEach(r=>{
      if(r.status!=='fulfilled') return;
      (r.value.notes||[]).forEach(note=>notes.push({...note,contactId:r.value.id}));
      (r.value.tasks||[]).forEach(task=>tasks.push({...task,contactId:r.value.id}));
    });
    const lines=[
      'GHL CRM context:',
      contacts.length?'Contacts:\n'+contacts.slice(0,limit).map(c=>`- ${c.name||'Unknown'}${c.email?' <'+c.email+'>':''}${c.phone?' | '+c.phone:''}${c.company?' | '+c.company:''}`).join('\n'):'',
      opportunities.length?'Open opportunities:\n'+opportunities.slice(0,limit).map(o=>`- ${o.name||'Opportunity'} | ${o.status||'status unclear'} | ${o.pipelineStage?.name||o.stage?.name||o.stageName||o.pipelineStage||'stage unclear'} | ${o.monetaryValue||o.value||''} | contact ${o.contact?.name||o.contactName||o.contactId||'unclear'}`).join('\n'):'',
      tasks.length?'Contact tasks:\n'+tasks.slice(0,limit).map(t=>`- ${t.title||t.name||t.body||'Task'}${t.dueDate||t.due_date?' | due '+(t.dueDate||t.due_date):''}`).join('\n'):'',
      notes.length?'Contact notes:\n'+notes.slice(0,limit).map(n=>`- ${compactText(n.body||n.note||n.text||n.message||JSON.stringify(n),500)}`).join('\n'):'',
      conversations.length?'Conversations:\n'+conversations.slice(0,limit).map(c=>`- ${c.contactName||c.fullName||c.name||c.contactId||'Contact'} | unread ${c.unreadCount||0} | ${compactText(c.lastMessageBody||c.lastMessage||'',220)}`).join('\n'):'',
      errors.length?'GHL context errors: '+errors.join('; '):''
    ].filter(Boolean).join('\n\n');
    return {configured:true,text:lines,contacts,opportunities,tasks,notes,conversations,errors};
  }

  return {
    credentials,
    credentialsFromAccount,
    headers,
    headersForCredentials,
    prepare,
    prepareForAccount,
    request,
    requestForAccount,
    requestStrict,
    requestTry,
    requestTryForAccount,
    isConfigured,
    searchContacts,
    getContact,
    getContactNotes,
    getContactTasks,
    getConversations,
    findOpenOpportunities,
    findOpenOpportunitiesForAccount,
    getCalendarEvents,
    getCalendarEventsForAccount,
    buildContext
  };
}

module.exports = {createGhlMcpService};
