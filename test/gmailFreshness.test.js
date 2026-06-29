const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

test('gmail fetch uses a 14-day active inbox window and sorts newest first',()=>{
  assert.match(server,/query='in:inbox newer_than:14d'/);
  assert.match(server,/const recentQuery=force\?'in:inbox newer_than:14d':'in:inbox newer_than:14d'/);
  assert.match(server,/sortEmailsNewestFirst/);
  assert.match(server,/internalDate/);
});

test('gmail refresh retries rejected access tokens and exposes sync status',()=>{
  assert.match(server,/async function gmailFetchJson/);
  assert.match(server,/response\.status===401&&googleTokens\.refresh_token/);
  assert.match(server,/lastSuccessfulSyncAt/);
  assert.match(server,/lastFetchedCount/);
  assert.match(server,/lastAnalyzedCount/);
  assert.match(server,/app\.post\('\/api\/email\/gmail\/refresh'/);
});

test('executive inbox UI has manual refresh and visible sync metadata',()=>{
  assert.match(dashboard,/Executive Inbox/);
  assert.match(dashboard,/Needs My Attention/);
  assert.match(dashboard,/Drafts/);
  assert.match(dashboard,/Rules/);
  assert.match(dashboard,/function selectEmailAt/);
  assert.match(dashboard,/onclick="selectEmailAt\(\$\{i\}\)"/);
  assert.match(dashboard,/list\.addEventListener\('click'/);
  assert.match(dashboard,/function renderSelectedEmailDetail/);
  assert.match(dashboard,/renderEmailDetail\(emailIntel\.selected\)/);
  assert.match(dashboard,/function markEmailNotImportant/);
  assert.match(dashboard,/function setEmailActionStatus/);
  assert.match(dashboard,/function saveInlineEmailRule/);
  assert.match(dashboard,/emailRulePanel/);
  assert.match(dashboard,/function saveManualEmailRule/);
  assert.match(dashboard,/Refresh Inbox/);
  assert.match(dashboard,/function refreshGmailNow/);
  assert.match(dashboard,/function renderEmailSyncStatus/);
  assert.match(dashboard,/Last successful sync/);
  assert.match(dashboard,/Evidence:/);
  assert.match(dashboard,/\/api\/email\/gmail\/refresh/);
});

test('executive inbox prepares approval drafts for reply-worthy and warm intro emails',()=>{
  assert.match(server,/function emailShouldPrepareDraft/);
  assert.match(server,/function buildEmailReplyDraft/);
  assert.match(server,/function emailDraftStableId/);
  assert.match(server,/prepareEmailDraftIfNeeded/);
  assert.match(server,/Warm introduction opportunity asks for reply language/);
  assert.match(server,/intro\|introduction\|referral\|connect you/);
  assert.match(server,/source:'executive_inbox_auto_draft'/);
  assert.match(server,/email\.preparedDraft=draft/);
  assert.match(dashboard,/Draft waiting for approval/);
  assert.match(dashboard,/Review Prepared Draft/);
});

test('executive inbox actions report inline and rules avoid native confirm flow',()=>{
  assert.match(dashboard,/Follow-up tracked/);
  assert.match(dashboard,/Task created/);
  assert.match(dashboard,/Rule saved/);
  assert.match(dashboard,/VAL is saving this rule/);
  assert.doesNotMatch(dashboard,/Confirm automation rule\\\\n/);
  assert.match(server,/mode==='vip_priority'/);
  assert.match(server,/mode==='draft_reply'/);
  assert.match(server,/mode==='track_response'/);
});

test('email sync captures evidence before actions and does not auto-create tasks',()=>{
  assert.match(server,/async function saveEmailEvidence/);
  assert.match(server,/async function runObservationEngine/);
  assert.match(server,/runObservationEngine\(evidence,\{candidates:emailObservationCandidates\(email\),replace:true\}\)/);
  assert.match(server,/sourceType=email\.provider==='outlook'\?'outlook_email':'gmail_email'/);
  for(const type of ['reply_needed','pricing_question','meeting_request','document_request','spam','newsletter','receipt']){
    assert.match(server,new RegExp(`'${type}'`));
  }
  const syncStart=server.indexOf('async function emailIntelligencePayload');
  const evidenceWrite=server.indexOf('const evidenceResults=await saveEmailEvidenceBatch(emails)',syncStart);
  const logOnly=server.indexOf("actionType:'classified'",evidenceWrite);
  const firstTaskSave=server.indexOf('await saveTask',syncStart);
  assert.ok(evidenceWrite>syncStart,'email sync should write evidence');
  assert.ok(logOnly>evidenceWrite,'email sync should log classification after evidence capture');
  assert.ok(firstTaskSave<0||firstTaskSave>server.indexOf("app.post('/api/email/actions'",syncStart),'email sync should not save tasks directly');
});
