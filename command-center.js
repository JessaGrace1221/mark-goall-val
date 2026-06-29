(function(){
'use strict';
var transcriptState={items:[],counts:{total:0,needsReview:0,withOpenActions:0,failedProcessing:0},active:null,loaded:false,loading:false,error:'',lastLoadedAt:''};
var transcriptRecoveryRunning=false;
var draftSignalState={drafts:[],loaded:false,error:''};
var executiveBriefingState={data:null,loaded:false,loading:false,error:'',lastLoadedAt:''};
var VAL_LOGO_URL='https://assets.cdn.filesafe.space/JuRSFup6NNQErVKkXlX5/media/6a3fd004c93b89d83f6008e6.png';
var navItems=[
  {id:'dashboard',icon:'home',label:'Home',group:'core'},
  {id:'relationships',icon:'people',label:'Relationships',group:'core'},
  {id:'projects',icon:'folder',label:'Projects',group:'core'},
  {id:'evidence',icon:'evidence',label:'Evidence',group:'core'},
  {id:'transcripts',icon:'document',label:'Transcripts',group:'core'},
  {id:'calendar',icon:'calendar',label:'Calendar',group:'core'},
  {id:'documents',icon:'document',label:'Documents',group:'core'},
  {id:'email_intelligence',icon:'mail',label:'Executive Inbox',group:'growth'},
  {id:'leads_employers',icon:'search',label:'Scrape Employers',group:'growth'},
  {id:'leads_partners',icon:'search',label:'Scrape Partners',group:'growth'},
  {id:'tasks',icon:'check',label:'Actions',group:'growth'},
  {id:'drafts',icon:'document',label:'Drafts',group:'growth'},
  {id:'teach_val',icon:'spark',label:'Teach VAL',group:'growth'},
  {id:'settings_dashboard_studio',icon:'studio',label:'Dashboard Studio',group:'settings'},
  {id:'settings_templates',icon:'document',label:'Templates',group:'settings'},
  {id:'settings_api_keys',icon:'key',label:'API Keys & Connections',group:'settings'},
  {id:'settings_security',icon:'gear',label:'Security & Privacy',group:'settings'},
  {id:'settings',icon:'gear',label:'Settings',group:'settings'}
];
var valDashboardSourceAnchors="['drafts','✎','Drafts'] ['settings_templates','▤','Templates'] settings_templates:'openTemplatesPage' drafts:'openDraftsPage' leads_employers:'openLeadIntelligence' leads_partners:'openPartnerIntelligence' Meeting Recaps & Drafts";
function safe(value){return typeof docSafe==='function'?docSafe(String(value==null?'':value)):String(value==null?'':value).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function call(name){var fn=window[name];if(typeof fn==='function')return fn.apply(window,[].slice.call(arguments,1));}
function dashboardStudioEnabled(){return !!(window.VAL_CONFIG&&VAL_CONFIG.featureFlags&&VAL_CONFIG.featureFlags.dashboard_studio_beta);}
function visibleNavItems(){return navItems.filter(function(n){return n.id!=='settings_dashboard_studio'||dashboardStudioEnabled();});}
function valBrandName(){return (window.VAL_CONFIG&&(VAL_CONFIG.brandName||VAL_CONFIG.clientName))||'VAL';}
function clientFirstName(){var name=(window.VAL_CONFIG&&VAL_CONFIG.clientName)||'Jessa';return String(name).split(/\s+/)[0]||'there';}
function pendingDraftCount(){return (draftSignalState.drafts||[]).filter(function(d){return !/sent|approved|done/i.test(String(d.status||'draft'));}).length;}
function openTaskCount(){return taskInfo().open.length;}
function transcriptAttentionCount(){var c=transcriptState.counts||{};return Number(c.needsReview||0)+Number(c.failedProcessing||0);}
function navBadge(view){
  var count=view==='drafts'?pendingDraftCount():(view==='tasks'?openTaskCount():(view==='evidence'?transcriptAttentionCount():0));
  return '<span class="val-nav-badge'+(count?'':' empty')+'" data-badge-view="'+safe(view)+'">'+(count?String(count):'')+'</span>';
}
function updateCommandCenterBadges(){
  document.querySelectorAll('[data-badge-view]').forEach(function(el){
    var view=el.getAttribute('data-badge-view'),count=view==='drafts'?pendingDraftCount():(view==='tasks'?openTaskCount():(view==='evidence'?transcriptAttentionCount():0));
    el.textContent=count?String(count):'';
    el.classList.toggle('empty',!count);
  });
}
window.syncCommandCenterDrafts=function(){return loadDraftSignals(false);};
function navIcon(name){
  var paths={
    home:'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    people:'M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0M19 8a3 3 0 0 1 2 5M23 21a6 6 0 0 0-4-5.6',
    folder:'M3 6h7l2 2h9v11H3z',
    evidence:'M8 3h8l4 4v14H4V3h4zM8 12h8M8 16h8M16 3v5h5',
    calendar:'M5 4v3M19 4v3M4 9h16M5 6h14a1 1 0 0 1 1 1v13H4V7a1 1 0 0 1 1-1z',
    document:'M7 3h8l4 4v14H5V3h2zM14 3v5h5M8 13h8M8 17h6',
    mail:'M4 6h16v12H4zM4 7l8 6 8-6',
    search:'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5',
    check:'M5 13l4 4L19 7',
    spark:'M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8z',
    studio:'M4 5h16v14H4zM8 5v14M4 10h16',
    key:'M14 10a4 4 0 1 0-3 3l-5 5v2h3v-2h2v-2h2z',
    gear:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[name]||paths.spark)+'"/></svg>';
}
function navHtml(){
  var current='',items=visibleNavItems().map(function(n){
    var group=n.group!==current?'<div class="val-nav-group-label">'+safe(n.group==='growth'?'Momentum':(n.group==='settings'?'System':'Workspace'))+'</div>':'';
    current=n.group;
    return group+'<button class="val-nav-item'+(n.id==='dashboard'?' active':'')+'" data-view="'+n.id+'" onclick="commandCenterNavigate(\''+n.id+'\')"><span class="val-nav-icon">'+navIcon(n.icon)+'</span><span class="val-nav-label">'+safe(n.label)+'</span>'+navBadge(n.id)+'</button>';
  }).join('');
  return '<div class="val-nav-brand"><img class="val-nav-logo" src="'+VAL_LOGO_URL+'" alt="VAL"></div><div class="val-nav-items">'+items+'</div><div class="val-nav-foot"><div class="val-nav-user"><span class="val-user-avatar">'+safe(clientFirstName().slice(0,1).toUpperCase())+'</span><span><strong>'+safe(clientFirstName())+'</strong><small id="valNavStatus">System ready</small></span></div></div>';
}
window.refreshCommandCenterNav=function(){
  var nav=document.getElementById('valPrimaryNav');
  if(!nav) return;
  nav.innerHTML=navHtml();
  updateCommandCenterBadges();
};
function installShell(){
  var app=document.querySelector('.app');if(!app)return;
  var nav=document.getElementById('valPrimaryNav');
  if(!nav){nav=document.createElement('nav');nav.id='valPrimaryNav';nav.className='val-primary-nav';nav.setAttribute('aria-label','Primary navigation');app.insertBefore(nav,app.firstChild);}
  nav.innerHTML=navHtml();
  updateCommandCenterBadges();
  var top=document.querySelector('.topbar');if(top){var b=document.createElement('button');b.className='val-mobile-nav';b.setAttribute('aria-label','Open navigation');b.innerHTML='☰';b.onclick=function(){nav.classList.toggle('open');};top.insertBefore(b,top.firstChild);}
  if(!document.getElementById('valMobileNavToggle')){var mb=document.createElement('button');mb.id='valMobileNavToggle';mb.className='val-mobile-nav val-mobile-nav-floating';mb.setAttribute('aria-label','Open navigation');mb.innerHTML='☰';mb.onclick=function(){nav.classList.toggle('open');};app.appendChild(mb);}
  var center=document.querySelector('.center'),cmd=center&&center.querySelector('.cmd-area');if(center&&cmd){var view=document.createElement('section');view.id='valTranscriptView';view.className='val-transcript-view';center.insertBefore(view,cmd);}
  buildCommandCenter();loadTranscripts(false);loadDraftSignals(false);loadExecutiveBriefing(false);
}
function setActive(view){document.querySelectorAll('.val-nav-item').forEach(function(el){el.classList.toggle('active',el.getAttribute('data-view')===view);});var nav=document.getElementById('valPrimaryNav');if(nav)nav.classList.remove('open');}
function closeTranscriptView(){var view=document.getElementById('valTranscriptView');if(view)view.classList.remove('open');transcriptState.active=null;}
window.commandCenterNavigate=function(view){
  setActive(view);closeTranscriptView();
  if(view==='dashboard'){call('closeDetail');buildCommandCenter();return;}
  if(view==='transcripts'){openTranscripts();return;}
  var routes={chat:'openGeneralChat',teach_val:'openTeachValOnboarding',relationships:'openRelationshipReview',projects:'openPriorityReview',evidence:'openTranscripts',calendar:'openCalendarFullView',documents:'openGeneralChat',reports:'openPriorityReview',meetings:'openMeetingBriefing',communications:'askComms',email_intelligence:'openEmailIntelligence',opportunities:'openOpportunityIntelligence',tasks:'openTaskBoard',drafts:'openDraftsPage',intelligence:'openPriorityReview',leads_employers:'openLeadIntelligence',leads_partners:'openPartnerIntelligence',settings:'openKeysPanel',settings_api_keys:'openKeysPanel',settings_templates:'openTemplatesPage',settings_dashboard_studio:'openDashboardStudioPage',settings_security:'openSecurityPrivacyPage'};
  call(routes[view]||'closeDetail');
};
function listLine(label,value){return '<div class="val-mini-item"><strong>'+safe(label)+'</strong><span>'+safe(value)+'</span></div>';}
function loadDraftSignals(show){
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url){return fetch(url,{credentials:'same-origin'}).then(function(r){return r.json();});};
  return fetcher((window.PROXY||'')+'/api/val/drafts').then(function(data){draftSignalState.drafts=Array.isArray(data.drafts)?data.drafts:[];draftSignalState.loaded=true;draftSignalState.error='';updateCommandCenterBadges();buildCommandCenter();return data;}).catch(function(e){draftSignalState.loaded=true;draftSignalState.error=e.message||String(e);if(show&&typeof addSys==='function')addSys('Drafts could not be loaded: '+draftSignalState.error);updateCommandCenterBadges();buildCommandCenter();});
}
function loadExecutiveBriefing(show){
  if(typeof isBookEditorMode==='function'&&isBookEditorMode())return Promise.resolve(null);
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url){return fetch(url,{credentials:'same-origin'}).then(function(r){return r.json();});};
  executiveBriefingState.loading=true;executiveBriefingState.error='';buildCommandCenter();
  return fetcher((window.PROXY||'')+'/api/executive-briefing').then(function(data){executiveBriefingState.data=data&&data.ok!==false?data:null;executiveBriefingState.loaded=true;executiveBriefingState.loading=false;executiveBriefingState.error='';executiveBriefingState.lastLoadedAt=new Date().toISOString();if(data&&!data.bookMode)window.executiveBriefing=data;buildCommandCenter();return data;}).catch(function(e){executiveBriefingState.loaded=true;executiveBriefingState.loading=false;executiveBriefingState.error=e.message||String(e);if(show&&typeof addSys==='function')addSys('Executive Briefing could not be loaded: '+executiveBriefingState.error);buildCommandCenter();});
}
window.loadExecutiveBriefing=loadExecutiveBriefing;
function upcomingEvents(){return ([].concat((window.dashData&&dashData.appointments)||[],(window.dashData&&dashData.calendarEvents)||[])).filter(function(e){var d=new Date(e.startTime||e.start||e.date||0);return d>=new Date()&&!isNaN(d);}).sort(function(a,b){return new Date(a.startTime||a.start||a.date)-new Date(b.startTime||b.start||b.date);});}
function taskInfo(){var all=window.valTasks||((window.dashData&&dashData.tasks)||[]),open=all.filter(function(t){return !t.completed&&t.status!=='completed';}),now=new Date(),todayEnd=new Date();todayEnd.setHours(23,59,59,999);return{open:open,overdue:open.filter(function(t){return t.dueDate&&new Date(t.dueDate)<now;}),unscheduled:open.filter(function(t){return !t.scheduledStart&&!t.calendarEventId;}),scheduledToday:open.filter(function(t){var d=t.scheduledStart?new Date(t.scheduledStart):null;return d&&!isNaN(d)&&d>=now&&d<=todayEnd;})};}
function commandCard(kicker,title,copy,action,label,extra,priority){return '<article class="val-command-card'+(priority?' priority':'')+'"><div class="val-card-head"><div class="val-card-kicker">'+safe(kicker)+'</div>'+(extra&&extra.count!=null?'<span class="val-card-count">'+safe(extra.count)+'</span>':'')+'</div><h3>'+safe(title)+'</h3>'+(extra&&extra.html?'<div class="val-mini-list">'+extra.html+'</div>':'<p>'+safe(copy)+'</p>')+'<button class="val-card-action" onclick="'+action+'">'+safe(label)+'</button></article>';}
function pct(value){return Math.round(Number(value||0)*100)+'%';}
function moveLine(move){return '<div class="eb-move-line"><strong>'+safe(move.title||'Agency move')+'</strong><span>'+safe(move.why||move.whatChanged||'VAL noticed this may matter.')+'</span><em>'+pct(move.confidence)+'</em></div>';}
function timeOfDayInfo(){
  var h=new Date().getHours();
  if(h<12)return{key:'morning',greeting:'Good morning',note:'You have got this.'};
  if(h<17)return{key:'afternoon',greeting:'Good afternoon',note:'Steady momentum.'};
  if(h<21)return{key:'evening',greeting:'Good evening',note:'Bring the day home.'};
  return{key:'night',greeting:'Good evening',note:'Quiet clarity.'};
}
function lineIcon(type){
  var map={risk:'!',opportunity:'↗',decision:'✓',relationship:'↗',relationship_signal:'↗',emotional_context:'•',deadline:'□',question:'?',promise:'✓',commitment:'✓',task:'✓',default:'•'};
  return map[type]||map.default;
}
function compactText(value,fallback){return safe(String(value||fallback||'').replace(/\s+/g,' ').trim());}
function firstMoveTitle(move,fallback){return compactText(move&&move.title,fallback);}
function firstMoveCopy(move,fallback){return compactText(move&&(move.why||move.whatChanged||move.content),fallback);}
function cardLink(label,view){return '<button class="val-card-link" onclick="commandCenterNavigate(\''+view+'\')">'+safe(label)+'</button>';}
function jsString(value){return String(value==null?'':value).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,' ');}
function dashboardTargetAction(target,fallback){
  target=target||{};
  var type=target.type||'',id=target.id||'';
  if(type&&id)return "openDashboardTarget('"+jsString(type)+"','"+jsString(id)+"')";
  return "commandCenterNavigate('"+jsString(fallback||'evidence')+"')";
}
window.openDashboardTarget=function(type,id){
  var b=executiveBriefingState.data||{},entities=b.dashboardEntities||{};
  function all(list){return Array.isArray(list)?list:[];}
  var item=null,title='VAL Detail';
  if(type==='person')item=all(entities.people).find(function(x){return String(x.id||x.profileKey||x.email||x.name)===String(id);});
  else if(type==='project')item=all(entities.projects).find(function(x){return String(x.id||x.profileKey||x.name)===String(id);});
  else if(type==='draft'){if(typeof openDraftsPage==='function')openDraftsPage(id);return;}
  else if(type==='move')item=[b.highestLeverageMove].concat(all(b.alsoImportant),all(b.watching)).find(function(x){return x&&String(x.id)===String(id);});
  if(!item){
    item=all(entities.whatChanged).concat(all(entities.momentum),all(entities.readyForYou)).find(function(x){return String(x.id||'')===String(id);});
  }
  if(type==='person')title=(item&&item.name?item.name:'Relationship')+' Profile';
  else if(type==='project')title=(item&&item.name?item.name:'Project')+' Workspace';
  else if(type==='move')title='Why This Matters';
  if(!item){commandCenterNavigate(type==='project'?'projects':(type==='person'?'relationships':'evidence'));return;}
  var evidence=(item.evidence||[]).slice(0,8).map(function(e){return '<li><strong>'+safe(e.title||e.type||'Evidence')+'</strong><br><span>'+safe(e.summary||'')+'</span></li>';}).join('');
  var loops=(item.openLoops||[]).slice(0,6).map(function(x){return '<li>'+safe(x)+'</li>';}).join('');
  var risks=(item.risks||[]).slice(0,6).map(function(x){return '<li>'+safe(x)+'</li>';}).join('');
  var opps=(item.opportunities||[]).slice(0,6).map(function(x){return '<li>'+safe(x)+'</li>';}).join('');
  var body='<div class="relationship-profile-grid">'
    +'<section class="exec-card"><h3>'+safe(item.name||item.title||'Signal')+'</h3><p>'+safe(item.summary||item.why||item.detail||'VAL is watching this from evidence.')+'</p><p><strong>Status:</strong> '+safe(item.state||item.impact||item.priorityBand||'Observed')+'</p></section>'
    +'<section class="exec-card"><h3>What Needs Attention</h3><ul>'+(loops||risks||opps||'<li>No urgent open loop attached yet.</li>')+'</ul></section>'
    +'<section class="exec-card"><h3>Risks</h3><ul>'+(risks||'<li>No explicit risk attached.</li>')+'</ul></section>'
    +'<section class="exec-card"><h3>Opportunities</h3><ul>'+(opps||'<li>No explicit opportunity attached.</li>')+'</ul></section>'
    +'<section class="exec-card relationship-profile-wide"><h3>Evidence Trail</h3><ul class="relationship-timeline">'+(evidence||'<li>Evidence IDs are stored, but no display summary is attached yet.</li>')+'</ul></section>'
    +'</div>';
  if(typeof openExecutiveWorkspace==='function')openExecutiveWorkspace({id:'dashboardEntityOverlay',title:title,body:body,footer:"<button class=\"alert-btn primary\" onclick=\"commandCenterNavigate('relationships')\">Relationship Review</button><button class=\"alert-btn\" onclick=\"closeExecutiveWorkspace('dashboardEntityOverlay')\">Close</button>"});
};
function whatChangedRows(b){
  var items=(b&&Array.isArray(b.whatChanged)?b.whatChanged:[]).slice(0,4);
  if(!items.length)items=(b&&Array.isArray(b.valNoticed)?b.valNoticed:[]).slice(0,4).map(function(n){return{title:n,type:'relationship_signal'};});
  if(!items.length)items=[
    {title:'VAL is watching for new evidence.',type:'relationship_signal'},
    {title:'Emails and transcripts will appear here after sync.',type:'decision'},
    {title:'No urgent risk has surfaced yet.',type:'risk'},
    {title:'Calendar shifts will be noticed here.',type:'deadline'}
  ];
  return items.map(function(item){
    var title=typeof item==='string'?item:(item.title||item.content||item.summary||'Something changed');
    var type=typeof item==='string'?'default':(item.type||item.observationType||'default');
    return '<button class="val-dash-row" onclick="'+dashboardTargetAction(item.target,'evidence')+'"><span class="val-row-icon '+safe(type)+'">'+safe(lineIcon(type))+'</span><span>'+compactText(title)+'</span></button>';
  }).join('');
}
function peopleRows(b){
  var people=(b&&Array.isArray(b.people)?b.people:[]).slice(0,4);
  if(!people.length)people=[{name:'Relationships',state:'Waiting for evidence',trend:'steady'}];
  return people.map(function(p){
    var trend=String(p.trend||p.state||'steady').toLowerCase();
    var cls=/risk|waiting|needs|cool|slow/.test(trend)?'risk':(/warm|momentum|increas|build/.test(trend)?'up':'steady');
    return '<button class="val-person-row" onclick="'+dashboardTargetAction(p.target||{type:'person',id:p.id||p.profileKey||p.email||p.name},'relationships')+'"><span class="val-person-avatar">'+safe((p.name||'R').slice(0,1).toUpperCase())+'</span><span><strong>'+safe(p.name||'Relationship')+'</strong><small class="'+cls+'">'+safe(p.state||p.summary||'Observed')+'</small></span><em class="'+cls+'">'+(cls==='risk'?'↘':(cls==='up'?'↗':'→'))+'</em></button>';
  }).join('');
}
function projectRows(b){
  var projects=(b&&Array.isArray(b.projects)?b.projects:[]).slice(0,3);
  if(!projects.length)projects=[
    {name:'VAL Platform',summary:'Evidence and briefing system',state:'Momentum'},
    {name:'Relationship Engine',summary:'People create velocity',state:'Momentum'},
    {name:'Executive Inbox',summary:'Decisions before email management',state:'Watching'}
  ];
  return projects.map(function(p){
    var cls=/risk|slow|stall|watch/i.test(String(p.state||''))?'risk':'up';
    return '<button class="val-project-row" onclick="'+dashboardTargetAction(p.target||{type:'project',id:p.id||p.profileKey||p.name},'projects')+'"><span class="val-project-icon '+cls+'">↗</span><span><strong>'+safe(p.name||p.title||'Project')+'</strong><small>'+safe(p.summary||p.description||'Current priority')+'</small></span><em class="'+cls+'">'+safe(p.state||'Momentum')+'</em></button>';
  }).join('');
}
function momentumRows(b){
  var momentum=(b&&Array.isArray(b.momentum)?b.momentum:[]).slice(0,4);
  if(!momentum.length)momentum=[
    {title:'Momentum Increasing',detail:'Evidence spine, relationship engine, executive briefing',state:'up'},
    {title:'Momentum Slowing',detail:'Inbox visibility depends on email sync depth',state:'watch'},
    {title:'Momentum At Risk',detail:'Too many suggested actions would reduce trust',state:'risk'},
    {title:'Momentum Recovering',detail:'Dashboard now shows judgment instead of raw data',state:'recovering'}
  ];
  return momentum.map(function(m){
    var cls=/risk|at risk/i.test(String(m.state||m.title||''))?'risk':(/slow|watch/i.test(String(m.state||m.title||''))?'watch':(/recover/i.test(String(m.state||m.title||''))?'recover':'up'));
    return '<button class="val-momentum-row '+cls+'" onclick="'+dashboardTargetAction(m.target,'relationships')+'"><span>'+safe(cls==='risk'?'↓':(cls==='watch'?'↘':(cls==='recover'?'↻':'↗')))+'</span><div><strong>'+safe(m.title||'Momentum signal')+'</strong><small>'+safe(m.detail||m.summary||'VAL is watching the pattern.')+'</small></div></button>';
  }).join('');
}
function readyRows(b){
  var ready=[];
  (b&&Array.isArray(b.readyForYou)?b.readyForYou:[]).slice(0,3).forEach(function(r){ready.push({title:r.title||'VAL is ready',view:r.view||'teach_val',target:r.target});});
  (draftSignalState.drafts||[]).filter(function(d){return !d.dashboardQuality||d.dashboardQuality.ready!==false;}).slice(0,3).forEach(function(d){ready.push({title:d.subject||'Draft prepared',view:'drafts',target:{type:'draft',id:d.id}});});
  (b&&Array.isArray(b.alsoImportant)?b.alsoImportant:[]).slice(0,3).forEach(function(m){ready.push({title:m.title||'Suggested move ready',view:'tasks'});});
  if(!ready.length)ready=[{title:'VAL is not forcing action yet',view:'tasks'},{title:'Evidence pipeline is ready',view:'evidence'},{title:'Relationship signals will surface here',view:'relationships'}];
  return ready.slice(0,5).map(function(r){return '<div class="val-ready-row"><span>✓</span><strong>'+safe(r.title)+'</strong><button class="val-card-link" onclick="'+dashboardTargetAction(r.target,r.view||'tasks')+'">View</button></div>';}).join('');
}
function executiveBriefingHtml(bookMode){
  if(bookMode)return '';
  if(executiveBriefingState.loading&&!executiveBriefingState.loaded)return '<section class="val-dashboard-grid"><article class="val-dash-card loading"><div class="eb-kicker">Executive Briefing</div><h2>Reading what changed...</h2><p>VAL is distilling evidence, relationships, projects, and agency moves.</p></article></section>';
  if(executiveBriefingState.error)return '<section class="executive-briefing-panel"><div class="eb-kicker">Executive Briefing</div><h2>Briefing unavailable</h2><p>'+safe(executiveBriefingState.error)+'</p><button class="eb-btn" onclick="loadExecutiveBriefing(true)">Try Again</button></section>';
  var b=executiveBriefingState.data;if(!b||b.bookMode)return '';
  var highest=b.highestLeverageMove||{};
  return '<div class="val-briefing-contract" aria-hidden="true">People Create Velocity · Highest Leverage Move · Also Important · Quietly Handled · VAL Noticed</div><section class="val-dashboard-grid">'
    +'<article class="val-dash-card what-changed"><div class="val-card-title"><span class="val-card-symbol">⌾</span><h2>What Changed</h2>'+cardLink('View all','evidence')+'</div><div class="val-row-list">'+whatChangedRows(b)+'</div></article>'
    +'<article class="val-dash-card highest"><div class="val-card-title"><span class="val-card-symbol gold">☆</span><h2>Highest Leverage</h2><button class="val-card-link" onclick="'+dashboardTargetAction(highest.target,'tasks')+'">Why this?</button></div><h3>'+firstMoveTitle(highest,'No major move is ready yet')+'</h3><p>'+firstMoveCopy(highest,'VAL is watching without forcing action.')+'</p><div class="val-leverage-meta"><span>Estimated impact <strong>'+safe(highest.impact||highest.priorityBand||'Quiet')+'</strong></span><span>Confidence <strong>'+safe(highest.confidence!=null?pct(highest.confidence):'--')+'</strong></span></div><button class="val-primary-action" onclick="'+dashboardTargetAction(highest.target,'tasks')+'">'+safe(highest.title?'Review Move':'Keep Watching')+'</button></article>'
    +'<article class="val-dash-card people"><div class="val-card-title"><span class="val-card-symbol">♙</span><h2>People</h2>'+cardLink('View all','relationships')+'</div><div class="val-people-list">'+peopleRows(b)+'</div></article>'
    +'<article class="val-dash-card projects"><div class="val-card-title"><span class="val-card-symbol">□</span><h2>Projects</h2>'+cardLink('View all','projects')+'</div><div class="val-project-list">'+projectRows(b)+'</div></article>'
    +'<article class="val-dash-card momentum"><div class="val-card-title"><span class="val-card-symbol">◷</span><h2>Momentum</h2>'+cardLink('View analysis','relationships')+'</div><div class="val-momentum-list">'+momentumRows(b)+'</div></article>'
    +'<article class="val-dash-card ready"><div class="val-card-title"><span class="val-card-symbol">✧</span><h2>Ready for You</h2></div><div class="val-ready-list">'+readyRows(b)+'</div></article>'
  +'</section>';
}
function buildCommandCenter(){
  var welcome=document.getElementById('centerWelcome');if(!welcome)return;
  var events=upcomingEvents(),tasks=taskInfo(),next=events[0],unread=Number((window.dashData&&dashData.followups)||0),pipeline=Number((window.dashData&&dashData.pipelineActive)||0),stalled=Number((window.dashData&&dashData.stalledDeals)||0);
  var priorityHtml='';if(next)priorityHtml+=listLine(next.title||next.summary||next.contactName||'Next meeting',new Date(next.startTime||next.start||next.date).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}));if(tasks.overdue.length)priorityHtml+=listLine(tasks.overdue[0].title||'Overdue commitment','Overdue');if(unread)priorityHtml+=listLine('Important conversations',unread+' unread');if(!priorityHtml)priorityHtml=listLine('No urgent exceptions detected','Review your day');
  var tr=transcriptState.items.slice(0,2),trHtml=tr.map(function(t){return listLine(t.title,t.status==='needs_review'?'Needs review':new Date(t.createdAt).toLocaleDateString());}).join('');
  var recapDrafts=draftSignalState.drafts.filter(function(d){return d.draftType==='meeting_recap'&&String(d.status||'draft')!=='approved'&&String(d.status||'draft')!=='sent';});
  var recentTranscriptTasks=(window.valTasks||((window.dashData&&dashData.tasks)||[])).filter(function(t){return t.transcriptId||t.sourceTranscriptId||/transcript/i.test(String(t.source||t.origin||''));}).slice(0,2);
  var recapHtml='';
  recapDrafts.slice(0,2).forEach(function(d){var ctx=d.sourceContext||{};recapHtml+=listLine(d.subject||'Meeting recap draft',ctx.meetingTitle||ctx.transcriptTitle||d.status||'Draft');});
  if(Number(transcriptState.counts.failedProcessing||0))recapHtml+=listLine('Failed transcript processing',transcriptState.counts.failedProcessing+' need attention');
  recentTranscriptTasks.forEach(function(t){recapHtml+=listLine(t.title||t.taskTitle||'Transcript task',t.dueDate||t.status||'created');});
  var bookMode=typeof isBookEditorMode==='function'&&isBookEditorMode();
  var studioOverrides=(window.VAL_CONFIG&&VAL_CONFIG.dashboardStudioOverrides)||{};
  var dashboardOverride=studioOverrides.dashboard||{};
  var defaultTitle=bookMode?'Continue the book, gently.':'Today, clearly.';
  var defaultSub=bookMode?'Start at the beginning, use prior editor notes, and move chapter by chapter without making Michele manage the machinery.':'The decisions, relationships, and commitments most likely to need your attention—without the dashboard noise.';
  if(!bookMode){
    var tod=timeOfDayInfo(),brief=executiveBriefingState.data||{},theme=brief.todayTheme||{};
    welcome.className='center-welcome val-home '+('time-'+tod.key);
    welcome.innerHTML='<div class="val-home-hero"><div class="val-home-banner" aria-label="Velocity Alignment Leverage. AI that moves you forward."></div><div class="val-home-greeting"><div><h1>'+safe(tod.greeting+', '+clientFirstName()+'.')+'</h1><p>'+safe((theme.why||dashboardOverride.heroSubtitle||'I’ve been paying attention. Here’s what matters today.'))+'</p></div><div class="val-hero-note">'+safe(tod.note)+' <span>♡</span></div></div></div>'+executiveBriefingHtml(false)+'<div class="val-presence-actions"><button class="val-presence-btn" onclick="startVoiceChatMode()"><span class="val-presence-icon">◌</span><span><strong>Voice Chat</strong><small>Discuss, brainstorm, or ask VAL for your next best move.</small></span></button><button class="val-presence-btn meeting" onclick="startMeetingPresenceMode()"><span class="val-presence-icon">◍</span><span><strong>Meeting Mode</strong><small>VAL listens quietly and helps when called.</small></span></button></div><div class="val-home-chat"><span>✦</span><button onclick="openGeneralChat({welcome:true})">What are we working on today?</button><button class="val-home-send" onclick="openGeneralChat({welcome:true})">↑</button></div><button class="val-talk-button" onclick="openGeneralChat({welcome:true})"><span></span><strong>Talk to VAL</strong></button>';
    welcome.style.display='block';
    return;
  }
  welcome.className='center-welcome';
  var html='<div class="cw-label">'+(bookMode?'Book Command Center':'Executive Command Center')+'</div><div class="cw-title">'+safe(dashboardOverride.heroTitle||defaultTitle)+'</div><div class="cw-sub">'+safe(dashboardOverride.heroSubtitle||defaultSub)+'</div>'+executiveBriefingHtml(bookMode)+'<div class="val-command-grid">';
  if(bookMode){
    html+=commandCard('Continue My Book','Continue My Book','Read the current manuscript chapter, use Michele’s prior edit notes, ask one gentle question, then update the manuscript safely.','openMicheleBookCompanion()','Continue My Book',{count:'Start here'},true);
  }
  html+=commandCard(bookMode?'Book Priorities':"Today's Priorities",tasks.overdue.length?'Close the open loops first':'Your highest-leverage work is ready',bookMode?'VAL is holding the manuscript, prior notes, and editorial tasks in one place.':'VAL ranked today across meetings, communication, relationships, commitments, and revenue.','openPriorityReview()',bookMode?'Review Priorities':'Do It',{count:(tasks.overdue.length+unread+(stalled||0))+' signals',html:priorityHtml},!bookMode&&true);
  html+=commandCard('Meetings',next?(next.title||next.summary||'Next meeting'):'No upcoming meeting',next?'Your next conversation is ready for context and preparation.':'Your connected calendar has no upcoming event.','openMeetingBriefing()','Prepare Briefing',{count:events.length+' upcoming'});
  html+=commandCard('Transcripts',transcriptState.error?'Unable to load transcripts':tr.length?'Recent conversations are in memory':'No transcripts received yet',transcriptState.error?'The transcript archive could not be reached. Open it to retry.':'Webhook transcripts, summaries, and open actions live together here.','openTranscripts()','View Transcripts',{count:transcriptState.error?'Needs attention':transcriptState.counts.needsReview+' to review',html:trHtml||''});
  html+=commandCard('Meeting Recaps & Drafts',recapDrafts.length?recapDrafts.length+' recap drafts need approval':'Recaps and transcript drafts are current',draftSignalState.error?'Draft signals could not be loaded.':'Review recap drafts, failed transcript processing, and tasks created from transcript intelligence.','openDraftsPage()','Review Drafts',{count:(recapDrafts.length+Number(transcriptState.counts.failedProcessing||0))+' items',html:recapHtml||''});
  var openLoopHtml='';tasks.unscheduled.slice(0,2).forEach(function(t){openLoopHtml+=listLine(t.title||'Unscheduled task',t.dueDate?'Due '+new Date(t.dueDate).toLocaleDateString():'Needs time block');});tasks.scheduledToday.slice(0,1).forEach(function(t){openLoopHtml+=listLine(t.title||'Scheduled task','Today '+new Date(t.scheduledStart).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}));});
  html+=commandCard('Open Loops',tasks.unscheduled.length?tasks.unscheduled.length+' tasks need calendar time':'Tasks have protected time blocks',tasks.overdue.length?tasks.overdue.length+' overdue tasks also need attention.':'Calendarized tasks protect time without creating meetings.','openTaskBoard()','Calendarize Tasks',{count:tasks.unscheduled.length+' unscheduled',html:openLoopHtml||''},tasks.overdue.length>0);
  html+=commandCard('Communications',unread?unread+' conversations need attention':'Your communication queue is clear','Review important threads, waiting-on-response items, and draft replies.','openEmailIntelligence()','Draft Reply',{count:unread+' unread'});
  html+=commandCard('Relationships','Keep valuable people from drifting','See who needs follow-up and why the relationship matters now.','openRelationshipReview()','Review');
  html+=commandCard('Opportunities',pipeline?pipeline+' active opportunities':'Review opportunity signals',stalled?stalled+' opportunities may be stalled.':'Pipeline and lead signals are ready for review.','openOpportunityIntelligence()','Open',{count:stalled+' stalled'});
  html+=commandCard('Tasks & Commitments',tasks.open.length?tasks.open.length+' open commitments':'No open commitments',tasks.overdue.length?tasks.overdue.length+' are overdue and should be resolved first.':'Promised follow-ups and action items are organized here.','openTaskBoard()','Create Task',{count:tasks.overdue.length+' overdue'});
  html+='</div>';welcome.innerHTML=html;welcome.style.display='block';
}
function loadTranscripts(show){
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url){return fetch(url,{credentials:'same-origin'}).then(function(r){return r.json().catch(function(){return{};}).then(function(data){if(!r.ok)throw new Error(data.error||('Transcript request failed ('+r.status+')'));return data;});});};
  transcriptState.loading=true;transcriptState.error='';if(show)renderTranscriptLoading();
  return fetcher((window.PROXY||'')+'/api/val/transcripts?days=3650&limit=250').then(function(data){if(!data||data.ok===false||!Array.isArray(data.transcripts))throw new Error((data&&data.error)||'Transcript retrieval returned an invalid response.');transcriptState.items=data.transcripts;transcriptState.counts=data.counts||{total:data.transcripts.length,needsReview:0,withOpenActions:0};transcriptState.loaded=true;transcriptState.loading=false;transcriptState.error='';transcriptState.lastLoadedAt=new Date().toISOString();updateCommandCenterBadges();buildCommandCenter();if(show)renderTranscriptList();return data;}).catch(function(e){transcriptState.loaded=true;transcriptState.loading=false;transcriptState.error=e.message||String(e);updateCommandCenterBadges();buildCommandCenter();if(show)renderTranscriptError(transcriptState.error);throw e;});
}
window.openTranscripts=function(){setActive('transcripts');call('closeDetail');var welcome=document.getElementById('centerWelcome');if(welcome)welcome.style.display='none';var view=document.getElementById('valTranscriptView');if(view)view.classList.add('open');if(!transcriptState.loaded||transcriptState.error){loadTranscripts(true).catch(function(){});}else renderTranscriptList();};
function transcriptHeader(subtitle,back){var clearBtn=(window.VAL_CONFIG&&VAL_CONFIG.clientSlug==='jessa-val')?'<button class="val-ui-btn danger" onclick="clearTranscriptArchive()">Clear Transcript Data</button>':'';return '<div class="val-view-head"><div><h2>Transcript Intelligence</h2><p>'+safe(subtitle)+'</p></div><div class="val-view-actions">'+(back?'<button class="val-ui-btn" onclick="renderTranscriptList()">Inbox</button>':'')+'<button class="val-ui-btn primary" onclick="chooseTranscriptUpload()">Upload Transcript</button><button class="val-ui-btn" onclick="renderTranscriptReviewQueue()">Review Queue</button><button class="val-ui-btn" onclick="repairTranscriptProcessing()">Process Pending</button><button class="val-ui-btn" onclick="openIntegrationStatus()">Webhook Setup</button><button class="val-ui-btn" '+(transcriptState.loading?'disabled':'')+' onclick="loadTranscripts(true).catch(function(){})">'+(transcriptState.loading?'Refreshing…':'Refresh')+'</button>'+clearBtn+'</div></div>';}
function renderTranscriptLoading(){var view=document.getElementById('valTranscriptView');if(view)view.innerHTML=transcriptHeader('Loading the durable transcript archive…')+'<div class="val-empty val-transcript-loading">Refreshing transcripts…</div>';}
window.chooseTranscriptUpload=function(){
  var input=document.getElementById('valTranscriptUploadInput');
  if(!input){
    input=document.createElement('input');
    input.type='file';
    input.id='valTranscriptUploadInput';
    input.accept='.txt,text/plain,.md,.markdown,.pdf,.docx';
    input.multiple=true;
    input.style.display='none';
    input.onchange=function(){uploadTranscriptFiles(input.files);};
    document.body.appendChild(input);
  }
  input.value='';
  input.click();
};
window.uploadTranscriptFiles=function(files){
  files=Array.prototype.slice.call(files||[]);
  if(!files.length)return;
  var view=document.getElementById('valTranscriptView');
  if(view)view.innerHTML=transcriptHeader('Uploading transcript...',true)+'<div class="val-empty val-transcript-loading">Saving '+files.length+' transcript file'+(files.length===1?'':'s')+' into VAL.</div>';
  var body=new FormData();
  files.forEach(function(file){body.append('files',file,file.name);});
  body.append('docType','transcript');
  body.append('uploadedVia','transcript_tab_upload');
  body.append('processTranscript','true');
  return fetch((window.PROXY||'')+'/api/val/files',{method:'POST',credentials:'same-origin',body:body}).then(function(r){return r.json().catch(function(){return{};}).then(function(data){if(!r.ok||data.ok===false)throw new Error(data.error||'Transcript upload failed.');return data;});}).then(function(data){
    if(typeof addSys==='function')addSys('Uploaded '+Number((data.files&&data.files.length)||1)+' transcript file'+(((data.files&&data.files.length)||1)===1?'':'s')+'.');
    return loadTranscripts(true);
  }).catch(function(e){renderTranscriptError(e.message);throw e;});
};
window.clearTranscriptArchive=function(){
  var phrase=prompt('This permanently clears the current transcript archive for jessa_val. Type clear transcripts to continue.','');
  if(!phrase)return;
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url,opts){return fetch(url,Object.assign({credentials:'same-origin'},opts||{})).then(function(r){return r.json().then(function(data){if(!r.ok||data.ok===false)throw new Error(data.error||'Transcript cleanup failed.');return data;});});};
  var view=document.getElementById('valTranscriptView');if(view)view.innerHTML=transcriptHeader('Clearing transcript data...',true)+'<div class="val-empty val-transcript-loading">Removing transcript archive records, summaries, staging data, and transcript memory chunks.</div>';
  return fetcher((window.PROXY||'')+'/api/val/transcripts/clear-all',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:phrase})}).then(function(data){
    transcriptState.items=[];transcriptState.counts={total:0,needsReview:0,failedProcessing:0};transcriptState.loaded=true;
    if(typeof addSys==='function')addSys('Transcript archive cleared.');
    renderTranscriptList();
    return data;
  }).catch(function(e){renderTranscriptError(e.message);throw e;});
};
window.repairTranscriptProcessing=function(){
  var view=document.getElementById('valTranscriptView');if(view)view.innerHTML=transcriptHeader('Processing pending transcripts…')+'<div class="val-empty val-transcript-loading">VAL is processing received transcripts now. This can take a little while.</div>';
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url,opts){return fetch(url,Object.assign({credentials:'same-origin'},opts||{})).then(function(r){return r.json().then(function(data){if(!r.ok||data.ok===false)throw new Error(data.error||'Transcript repair failed.');return data;});});};
  return fetcher((window.PROXY||'')+'/api/val/transcripts/repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:25})}).then(function(data){if(typeof addSys==='function')addSys('Transcript repair: '+data.processed+' processed, '+data.failed+' failed.');return loadTranscripts(true);}).catch(function(e){renderTranscriptError(e.message);throw e;});
};
window.recoverStoredTranscripts=function(){
  if(transcriptRecoveryRunning)return Promise.resolve(null);
  transcriptRecoveryRunning=true;
  var view=document.getElementById('valTranscriptView');if(view)view.innerHTML=transcriptHeader('Recovering transcripts already stored elsewhere in VAL...',true)+'<div class="val-empty val-transcript-loading">Scanning VAL memory, evidence, conversations, uploads, and Teach VAL records for transcript-shaped content...</div>';
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url,opts){return fetch(url,Object.assign({credentials:'same-origin'},opts||{})).then(function(r){return r.json().then(function(data){if(!r.ok||data.ok===false)throw new Error(data.error||'Stored transcript recovery failed.');return data;});});};
  var controller=window.AbortController?new AbortController():null,timeout=setTimeout(function(){try{controller&&controller.abort();}catch(_){}},45000);
  return fetcher((window.PROXY||'')+'/api/val/transcripts/recover-existing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:3650,limit:20}),signal:controller&&controller.signal}).then(function(data){
    clearTimeout(timeout);
    transcriptRecoveryRunning=false;
    var samples=(data.importedSamples||[]).map(function(x){return '<article class="val-review-card"><span class="val-status '+(x.processingError?'review':'ok')+'">'+(x.processingError?'Needs processing':'Recovered')+'</span><h3>'+safe(transcriptShortText(x.title||x.id,'Recovered transcript',110))+'</h3><p>'+safe((x.sourceType||'stored VAL record')+' · '+(x.characters||0)+' chars'+(x.deferredProcessing?' · ready for Process Pending':'')+(x.processingError?' · '+x.processingError:''))+'</p></article>';}).join('');
    if(view)view.innerHTML=transcriptHeader('Recovered '+Number(data.imported||0)+' stored transcript'+(Number(data.imported||0)===1?'':'s')+'.',true)+'<div class="val-transcript-stats"><span class="val-transcript-stat"><strong>'+Number(data.candidates||0)+'</strong> candidates found</span><span class="val-transcript-stat"><strong>'+Number(data.imported||0)+'</strong> imported</span><span class="val-transcript-stat"><strong>'+Number(data.skipped||0)+'</strong> skipped</span><span class="val-transcript-stat"><strong>'+Number((data.errors||[]).length)+'</strong> errors</span></div><div class="val-empty">Recovery now saves raw transcripts first so the page does not time out. Use <strong>Process Pending</strong> to extract summaries and action items in smaller batches.</div><div class="val-review-grid">'+(samples||'<div class="val-empty">No recoverable transcript-shaped records were found in VAL storage.</div>')+'</div>';
    return loadTranscripts(false).then(function(){return data;}).catch(function(){return data;});
  }).catch(function(e){clearTimeout(timeout);transcriptRecoveryRunning=false;if(String(e.name||'')==='AbortError'){renderTranscriptError('Recovery took longer than expected and was stopped before the browser could get stuck. Try again after refreshing, or use Intake Status to inspect where records are stored.');return null;}if(/session expired|authentication required|please log back in/i.test(String(e.message||e))){renderTranscriptAuthExpired();return null;}renderTranscriptError(e.message);throw e;});
};
window.renderTranscriptList=function(){
  transcriptState.active=null;var view=document.getElementById('valTranscriptView');if(!view)return;
  var c=transcriptState.counts,rows=transcriptState.items.map(function(t){
    var status=(t.processingStatus||t.summaryStatus||t.reviewStatus||t.status||'saved').replace(/_/g,' ');
    var meta=[t.source||'transcript source',t.createdAt?new Date(t.createdAt).toLocaleString():'',status].filter(Boolean).join(' · ');
    var summary=t.summary&&typeof t.summary==='object'?t.summary.executiveSummary:(t.summaryPreview||t.summary||t.preview||'Summary pending.');
    return '<article class="val-transcript-row"><div class="val-transcript-copy"><div class="val-transcript-row-head"><h3>'+safe(transcriptShortText(t.title,'Transcript',120))+'</h3></div><div class="val-transcript-meta">'+safe(meta)+'</div><p>'+safe(transcriptShortText(summary,'Open this transcript to review the meeting summary.',340))+'</p></div><div class="val-transcript-actions"><button class="val-ui-btn primary" onclick="openTranscriptDetail(\''+safe(t.id)+'\')">Open Transcript</button><button class="val-ui-btn" onclick="transcriptAskFromList(\''+safe(t.id)+'\')">Chat</button></div></article>';
  }).join('');
  view.innerHTML=transcriptHeader('Only real transcript records appear here. Saved conversations appear only when they are meeting, voice, or VAL conversation transcripts with raw transcript text.')+'<div class="val-transcript-stats"><span class="val-transcript-stat"><strong>'+Number(c.total||transcriptState.items.length)+'</strong> transcripts</span><span class="val-transcript-stat"><strong>'+Number(c.failedProcessing||0)+'</strong> processing issues</span></div><div class="val-transcript-list">'+(rows||'<div class="val-empty"><strong>No real transcripts are available yet.</strong><br>No transcripts are available yet because VAL has not received a usable meeting, voice, VAL conversation, upload, or webhook transcript for this dashboard. Planning notes, prompts, drafts, and task artifacts are intentionally hidden here.</div>')+'</div>';
};
window.renderTranscriptReviewQueue=function(){
  var view=document.getElementById('valTranscriptView');if(!view)return;
  view.innerHTML=transcriptHeader('Loading transcript review…',true)+'<div class="val-empty">Loading…</div>';
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url){return fetch(url,{credentials:'same-origin'}).then(function(r){return r.json();});};
  fetcher((window.PROXY||'')+'/api/val/transcripts/review').then(function(d){
    var cards=[];
    (d.decisions||[]).forEach(function(x){cards.push('<article class="val-review-card"><span class="val-status review">Decision</span><h3>'+safe(x.title||'Decision needs review')+'</h3><p>'+safe(x.summary||'Review this before VAL uses it for drafts or next actions.')+'</p><button class="val-ui-btn primary" onclick="reviewValDecision(\''+safe(x.id)+'\',\'approved\')">Approve</button><button class="val-ui-btn" onclick="reviewValDecision(\''+safe(x.id)+'\',\'dismissed\')">Dismiss</button><button class="val-ui-btn" onclick="openTranscriptDetail(\''+safe(x.sourceId)+'\')">Open Source</button></article>');});
    (d.participants||[]).forEach(function(p){cards.push('<article class="val-review-card"><span class="val-status review">Participant match</span><h3>'+safe(p.speakerNameRaw)+'</h3><p>'+safe(p.matchReason)+' · '+Math.round(Number(p.matchConfidence||0)*100)+'% confidence</p><button class="val-ui-btn primary" onclick="approveTranscriptParticipant(\''+safe(p.participantId)+'\')">Approve Match</button></article>');});
    (d.tasks||[]).forEach(function(t){cards.push('<article class="val-review-card"><span class="val-status review">Task</span><h3>'+safe(t.taskTitle)+'</h3><p>'+safe(t.assignedToName||'Assignment unclear')+' · “'+safe(t.sourceQuote)+'”</p><button class="val-ui-btn primary" onclick="approveTranscriptTask(\''+safe(t.taskId)+'\')">Approve & Create</button></article>');});
    (d.contactUpdates||[]).forEach(function(u){cards.push('<article class="val-review-card"><span class="val-status review">Contact update</span><h3>'+safe(u.fieldToUpdate)+': '+safe(u.newValue)+'</h3><p>'+safe(u.reason)+' · “'+safe(u.sourceQuote)+'”</p><button class="val-ui-btn" onclick="approveTranscriptContactUpdate(\''+safe(u.updateId)+'\')">Approve Update</button></article>');});
    view.innerHTML=transcriptHeader('Review Queue · only uncertain items from real transcripts appear here.',true)+'<div class="val-review-grid">'+(cards.join('')||'<div class="val-empty"><strong>No transcript decisions need review.</strong><br>If you expected items here, first confirm a real transcript has been captured in the Inbox view. VAL now hides planning notes, prompts, and task artifacts from transcript review.</div>')+'</div>';
  }).catch(function(e){renderTranscriptError(e.message);});
};
window.renderTranscriptIntakeStatus=function(){
  var view=document.getElementById('valTranscriptView');if(!view)return;
  view.innerHTML=transcriptHeader('Checking where transcript records are landing...',true)+'<div class="val-empty">Loading intake status...</div>';
  var fetcher=typeof apiFetch==='function'?apiFetch:function(url){return fetch(url,{credentials:'same-origin'}).then(function(r){return r.json().then(function(d){if(!r.ok||d.ok===false)throw new Error(d.error||'Intake status failed');return d;});});};
  fetcher((window.PROXY||'')+'/api/val/transcripts/intake-status?days=3650').then(function(d){
    var c=d.counts||{}, latest=d.latestRawTranscript||null, webhook=d.webhook||{};
    var stats=[
      ['Visible transcripts',c.visibleTranscripts],
      ['Raw canonical rows',c.rawCanonicalRows],
      ['Raw legacy rows',c.rawLegacyRows],
      ['Hidden canonical rows',c.hiddenCanonicalRows],
      ['Transcript memory rows',c.transcriptMemoryRows],
      ['Upload/webhook audit events',c.transcriptAuditEvents],
      ['Krisp-linked records',c.krispLinkedRows],
      ['Purged recovered trash',c.purgedRecoveredTrash],
      ['Calendar links',c.meetingLinks]
    ].map(function(pair){return '<span class="val-transcript-stat"><strong>'+safe(pair[1]||0)+'</strong> '+safe(pair[0])+'</span>';}).join('');
    var hidden=(d.hiddenSamples||[]).map(function(x){return '<article class="val-review-card"><span class="val-status review">Hidden</span><h3>'+safe(transcriptShortText(x.title||x.id,'Untitled record',110))+'</h3><p>'+safe((x.source||'unknown')+' · '+(x.reason||'filtered')+' · '+(x.createdAt||''))+'</p></article>';}).join('');
    var krisp=(d.krispSamples||[]).map(function(x){return '<article class="val-review-card"><span class="val-status ok">Krisp</span><h3>'+safe(transcriptShortText(x.title||x.id,'Krisp-linked record',110))+'</h3><p>'+safe((x.source||'unknown')+' · '+(x.characters||0)+' chars · '+(x.createdAt||''))+'</p></article>';}).join('');
    var audit=(d.recentAudit||[]).map(function(x){var meta=x.metadata||{};return '<article class="val-review-card"><span class="val-status '+(x.success?'ok':'review')+'">'+safe(x.action||'audit')+'</span><h3>'+safe(meta.fileName||meta.title||x.resourceId||'Transcript intake event')+'</h3><p>'+safe((x.createdAt||'')+' · '+(meta.docType||meta.source||'')+' · '+(meta.processingError||meta.characters||''))+'</p></article>';}).join('');
    var memory=(d.recentMemory||[]).map(function(x){return '<article class="val-review-card"><span class="val-status review">'+safe(x.kind||'memory')+'</span><h3>'+safe(transcriptShortText(x.title||x.id,'Memory record',110))+'</h3><p>'+safe((x.docType||'')+' · '+(x.uploadedVia||'')+' · '+(x.characters||0)+' chars · '+(x.createdAt||''))+'</p></article>';}).join('');
    var latestHtml=latest?'<section class="val-detail-card"><h3>Latest raw transcript-like record</h3><p>'+safe([latest.title||latest.id,latest.source,latest.createdAt,latest.characters+' characters'].filter(Boolean).join(' · '))+'</p></section>':'<section class="val-detail-card"><h3>Latest raw transcript-like record</h3><p>No raw transcript rows were found in VAL storage.</p></section>';
    view.innerHTML=transcriptHeader('Intake Status · where webhook and uploaded transcript records are landing.',true)+'<div class="val-transcript-stats">'+stats+'</div><div class="val-transcript-detail"><div class="val-detail-main"><section class="val-detail-card"><h3>Webhook</h3><p>'+safe(webhook.live?'Live signed webhook URL is configured. Use Webhook Setup to copy the exact URL with token.':'Webhook status unavailable.')+'</p><p>Token preview: '+safe(webhook.tokenPreview||'hidden')+'</p></section>'+latestHtml+'<section class="val-detail-card"><h3>Krisp-linked records</h3><div class="val-review-grid">'+(krisp||'<div class="val-empty">No records containing app.krisp.ai links were found.</div>')+'</div></section><section class="val-detail-card"><h3>Hidden or filtered records</h3><div class="val-review-grid">'+(hidden||'<div class="val-empty">No hidden transcript-like rows found.</div>')+'</div></section></div><aside class="val-detail-side"><section class="val-detail-card"><h3>Recent intake audit</h3><div class="val-review-grid">'+(audit||'<div class="val-empty">No upload or webhook audit events found yet.</div>')+'</div></section><section class="val-detail-card"><h3>Transcript-like memory</h3><div class="val-review-grid">'+(memory||'<div class="val-empty">No transcript-like memory records found.</div>')+'</div></section></aside></div>';
  }).catch(function(e){renderTranscriptError(e.message);});
};
function renderTranscriptError(message){var view=document.getElementById('valTranscriptView');if(view)view.innerHTML=transcriptHeader('Transcript archive unavailable')+'<div class="val-empty val-transcript-error"><strong>Unable to load transcripts.</strong><br>Check the transcript retrieval endpoint or server logs.<br><small>'+safe(message)+'</small></div>';}
function renderTranscriptAuthExpired(){var view=document.getElementById('valTranscriptView'),next=encodeURIComponent(location.pathname+location.search);if(view)view.innerHTML=transcriptHeader('Session expired')+'<div class="val-empty val-transcript-error"><strong>Please sign back in.</strong><br>VAL kept you on this page instead of redirecting during recovery.<br><button class="val-ui-btn primary" onclick="window.location.href=\'/login?next='+next+'\'">Open Login</button></div>';}
function normalizeList(items){return (Array.isArray(items)?items:[]).map(function(x){return typeof x==='string'?x:(x.title||x.text||x.summary||x.name||x.email||JSON.stringify(x));}).filter(Boolean);}
function transcriptCleanText(value,fallback){
  var text=String(value||'').replace(/\[(?:relationship|chat)_memory\]/gi,'').replace(/\*\*/g,'').replace(/#{1,6}\s*/g,'').replace(/\bUser\/Time\/Date\b/gi,'').replace(/\b(?:Attendee intelligence|Saved memory|dashboard context|user profile context):?/gi,'').replace(/\s+/g,' ').trim();
  if(!text||/^(unknown|user|time|date)$/i.test(text))return fallback||'';
  return text;
}
function transcriptShortText(value,fallback,limit){
  var clean=transcriptCleanText(value,fallback||'');
  limit=limit||260;
  return clean.length>limit?clean.slice(0,limit-1).trim()+'…':clean;
}
window.openTranscriptDetail=function(id){
  var view=document.getElementById('valTranscriptView');if(view)view.innerHTML='<div class="val-empty">Opening transcript…</div>';
  return (typeof apiFetch==='function'?apiFetch((window.PROXY||'')+'/api/val/transcripts/'+encodeURIComponent(id)):fetch('/api/val/transcripts/'+encodeURIComponent(id),{credentials:'same-origin'}).then(function(r){return r.json().then(function(data){if(!r.ok)throw new Error(data.error||'Transcript could not be opened.');return data;});})).then(function(data){if(!data.transcript)throw new Error(data.error||'Transcript could not be opened.');transcriptState.active=data.transcript;renderTranscriptDetail(data.transcript);return data.transcript;}).catch(function(e){renderTranscriptError(e.message);throw e;});
};
function detailList(items,empty){var arr=normalizeList(items);return arr.length?'<ul>'+arr.map(function(x){return '<li>'+safe(x)+'</li>';}).join('')+'</ul>':'<p>'+safe(empty)+'</p>';}
function draftRecipients(ctx){var r=ctx&&ctx.recipients;if(Array.isArray(r))return r.join(', ');return (ctx&&ctx.recipient)||(ctx&&ctx.recipientEmail)||'';}
function renderTranscriptDetail(t){
  var view=document.getElementById('valTranscriptView');if(!view)return;var meta=[t.contactName,t.source,t.createdAt?new Date(t.createdAt).toLocaleString():''].filter(Boolean).join(' · ');
  var s=t.summary&&typeof t.summary==='object'?t.summary:{executiveSummary:t.summary||''};
  var participants=(t.participants||[]).map(function(p){return (p.matchedContactName||p.speakerNameRaw)+' — '+Math.round(Number(p.matchConfidence||0)*100)+'% · '+p.matchReason+(p.needsReview?' [review]':'');});
  var tasks=(t.tasks||[]).map(function(x){return x.taskTitle+' — '+(x.status||'staged')+' · “'+x.sourceQuote+'”';});
  var createdTasks=(t.tasks||[]).filter(function(x){return String(x.status||'').toLowerCase()==='created';}).map(function(x){return x.taskTitle+' — '+(x.assignedToName||'VAL task system')+(x.dueDate?' · due '+x.dueDate:'');});
  var updates=(t.contactUpdates||[]).map(function(x){return x.fieldToUpdate+': '+x.newValue+' · “'+x.sourceQuote+'”';}),log=(t.actionLog||[]).map(function(x){return x.actionType+' — '+x.status+(x.errorMessage?' · '+x.errorMessage:'');});
  var canonical=t.canonical||{},canonicalConversation=canonical.conversation?[canonical.conversation.title||canonical.conversation.id]:[],canonicalIdentities=(canonical.identityLinks||[]).map(function(x){return (x.label||x.normalizedValue||x.entityId)+' — '+(x.normalizedValue||'identity')+' · '+Math.round(Number(x.confidence||0)*100)+'%';}),canonicalDecisions=(canonical.decisions||[]).map(function(x){return (x.title||x.summary||'Decision')+' — '+(x.status||'needs_review')+' · '+Math.round(Number(x.confidence||0)*100)+'%';});
  var status=['Processing: '+(t.processingStatus||t.status||'received'),'Summary: '+(t.summaryStatus||'pending'),'Review items: '+Number(t.reviewCount||0),'Tasks extracted: '+Number(t.taskCount||(t.tasks||[]).length)].join(' · ');
  var recap=(t.drafts||[]).find(function(d){return d.draftType==='meeting_recap';});
  var recapHtml=recap?'<div class="val-recap-preview"><strong>'+safe(recap.subject||'Meeting recap draft')+'</strong><p>'+safe((recap.body||'').slice(0,700))+'</p><small>Status: '+safe(recap.status||'draft')+(draftRecipients(recap.sourceContext)?' · Recipients: '+safe(draftRecipients(recap.sourceContext)):'')+'</small></div>':'<p>No recap draft has been created yet.</p>';
  var debug='<details class="val-detail-card val-transcript-debug"><summary>Processing details</summary><h3>Status</h3><p>'+safe(status)+'</p><h3>Canonical structure</h3>'+detailList(canonicalConversation.concat(canonicalIdentities).concat(canonicalDecisions),'No canonical conversation, identity, or decision records have been stored for this transcript yet.')+'<h3>Key Points</h3>'+detailList([s.clientSummary,s.internalNotes].concat(s.relationshipUpdates||[]).filter(Boolean),'No key points extracted.')+'<h3>Decisions</h3>'+detailList(s.keyDecisions,'No decisions extracted.')+'<h3>Action Items</h3>'+detailList(tasks,'No action items extracted.')+'<h3>Created Tasks</h3>'+detailList(createdTasks,'No tasks have been pushed to the main task system yet.')+'<h3>Participants & Match Confidence</h3>'+detailList(participants,'No participants detected.')+'<h3>Contact Updates</h3>'+detailList(updates,'No contact updates extracted.')+'<h3>Action Log</h3>'+detailList(log,'No actions logged.')+'<h3>Recap Draft</h3>'+recapHtml+'</details>';
  view.innerHTML=transcriptHeader(meta,true)+'<div class="val-transcript-detail"><div class="val-detail-main"><section class="val-detail-card"><div class="val-detail-actions"><button class="val-ui-btn primary" onclick="transcriptAskFocus()">Chat About This Transcript</button></div><h3>Summary</h3><p>'+safe(transcriptShortText(s.executiveSummary||s.clientSummary||'Summary pending.','Summary pending.',900))+'</p></section><section class="val-detail-card"><h3>Transcript</h3><p class="val-full-transcript">'+safe(t.transcriptText||t.rawTranscript||'No transcript text is available.')+'</p></section>'+debug+'</div><aside class="val-detail-side"><section class="val-detail-card"><h3>Chat About This Transcript</h3><div class="val-chat-log" id="valTranscriptChat"><div class="val-chat-msg">Ask about what happened, what was decided, what matters, or what VAL noticed in this transcript.</div></div><div class="val-chat-input"><input id="valTranscriptQuestion" placeholder="Ask VAL about this transcript" onkeydown="if(event.key===\'Enter\')transcriptAsk()"><button class="val-ui-btn primary" onclick="transcriptAsk()">Ask</button></div></section></aside></div>';
}
function transcriptApproval(path,body){return fetch((window.PROXY||'')+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().then(function(d){if(!r.ok||d.ok===false)throw new Error(d.error||'Approval failed');return d;});});}
window.approveTranscriptTask=function(id){transcriptApproval('/api/val/transcripts/tasks/'+encodeURIComponent(id)+'/approve').then(function(){renderTranscriptReviewQueue();loadTranscripts(false);call('valTasksLoad');}).catch(function(e){alert(e.message);});};
window.approveTranscriptParticipant=function(id){var existing=null;transcriptState.items.some(function(t){existing=(t.participants||[]).find(function(p){return p.participantId===id;});return !!existing;});var contactId=existing&&existing.matchedContactId||prompt('Enter the exact CRM contact ID for this participant:');if(!contactId)return;var contactName=existing&&existing.matchedContactName||prompt('Enter the confirmed contact name:')||'';transcriptApproval('/api/val/transcripts/participants/'+encodeURIComponent(id)+'/approve',{contactId:contactId,contactName:contactName}).then(renderTranscriptReviewQueue).catch(function(e){alert(e.message);});};
window.approveTranscriptContactUpdate=function(id){transcriptApproval('/api/val/transcripts/contact-updates/'+encodeURIComponent(id)+'/approve').then(renderTranscriptReviewQueue).catch(function(e){alert(e.message);});};
window.reviewValDecision=function(id,status){transcriptApproval('/api/val/decisions/'+encodeURIComponent(id)+'/review',{status:status}).then(renderTranscriptReviewQueue).catch(function(e){alert(e.message);});};
function chatMessage(text,user){var log=document.getElementById('valTranscriptChat');if(!log)return;var el=document.createElement('div');el.className='val-chat-msg'+(user?' user':'');el.textContent=text;log.appendChild(el);log.scrollTop=log.scrollHeight;}
window.transcriptAsk=function(question){
  var t=transcriptState.active;if(!t)return;var input=document.getElementById('valTranscriptQuestion'),q=question||(input&&input.value.trim());if(!q)return;if(input)input.value='';chatMessage(q,true);chatMessage('Working from this transcript…',false);var log=document.getElementById('valTranscriptChat'),pending=log&&log.lastChild;
  fetch((window.PROXY||'')+'/api/val/transcripts/'+encodeURIComponent(t.id)+'/chat',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q})}).then(function(r){return r.json().then(function(d){if(!r.ok||d.ok===false)throw new Error(d.error||'Transcript chat failed.');return d;});}).then(function(d){if(pending)pending.remove();chatMessage((d.message&&d.message.content)||d.message||'No response was returned.',false);}).catch(function(e){if(pending)pending.remove();chatMessage('Unable to complete that request: '+e.message,false);});
};
function transcriptById(id){return transcriptState.items.find(function(t){return String(t.id)===String(id);})||transcriptState.active;}
function transcriptAction(id,action){return fetch((window.PROXY||'')+'/api/val/transcripts/'+encodeURIComponent(id)+'/actions',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action})}).then(function(r){return r.json().catch(function(){return{};}).then(function(data){if(!r.ok||data.ok===false)throw new Error(data.error||'Transcript action failed.');return data;});});}
window.transcriptAskFromList=function(id){return openTranscriptDetail(id).then(function(){transcriptAsk('What matters most in this transcript, and what should happen next?');}).catch(function(){});};
window.transcriptCreateTask=function(id){var t=transcriptById(id);if(!t)return;return transcriptAction(t.id,'create_task').then(function(data){if(transcriptState.active&&String(transcriptState.active.id)===String(t.id))chatMessage('Task created: '+data.task.title,false);else if(typeof addSys==='function')addSys('Task created from '+t.title+': '+data.task.title);call('valTasksLoad');}).catch(function(e){if(transcriptState.active)chatMessage('Task was not created: '+e.message,false);else if(typeof addSys==='function')addSys('Task was not created: '+e.message);});};
window.transcriptDraftFollowUp=function(id){var t=transcriptById(id);if(!t)return;return transcriptAction(t.id,'draft_followup').then(function(data){var message='Draft saved for approval.\n\nSubject: '+data.draft.subject+'\n\n'+data.draft.body;if(transcriptState.active&&String(transcriptState.active.id)===String(t.id))chatMessage(message,false);else{if(typeof addSys==='function')addSys('Follow-up draft saved for '+t.title+'.');openTranscriptDetail(t.id).then(function(){chatMessage(message,false);});}}).catch(function(e){if(transcriptState.active)chatMessage('Follow-up draft failed: '+e.message,false);else if(typeof addSys==='function')addSys('Follow-up draft failed: '+e.message);});};
window.transcriptReviewRecapDraft=function(){var t=transcriptState.active;if(!t)return;if(typeof openDraftsPage==='function')openDraftsPage();};
window.transcriptRegenerateRecapDraft=function(){var t=transcriptState.active;if(!t)return;transcriptDraftFollowUp(t.id).then(function(){loadDraftSignals(false);openTranscriptDetail(t.id);});};
window.transcriptAskFocus=function(){var input=document.getElementById('valTranscriptQuestion');if(input){input.focus();input.scrollIntoView({behavior:'smooth',block:'center'});}else transcriptAsk('What should I know and do from this transcript?');};
window.transcriptMarkReviewed=function(){var t=transcriptState.active;if(!t)return;transcriptAction(t.id,'mark_reviewed').then(function(){t.reviewStatus='reviewed';t.status='reviewed';chatMessage('Marked reviewed.',false);loadTranscripts(false).catch(function(){});}).catch(function(e){chatMessage('Could not mark reviewed: '+e.message,false);});};
var originalSend=window.sendMessage;window.sendMessage=function(){var input=document.getElementById('msgInput');if(transcriptState.active&&document.getElementById('valTranscriptView')&&document.getElementById('valTranscriptView').classList.contains('open')&&input&&input.value.trim()){var q=input.value.trim();input.value='';input.style.height='auto';transcriptAsk(q);return;}return originalSend&&originalSend.apply(window,arguments);};
document.addEventListener('click',function(e){var nav=document.getElementById('valPrimaryNav');if(nav&&nav.classList.contains('open')&&!nav.contains(e.target)&&!e.target.closest('.val-mobile-nav'))nav.classList.remove('open');});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installShell);else installShell();
setTimeout(buildCommandCenter,1200);setTimeout(buildCommandCenter,3500);
setInterval(function(){if(!document.getElementById('valTranscriptView')?.classList.contains('open'))buildCommandCenter();},15000);
})();
