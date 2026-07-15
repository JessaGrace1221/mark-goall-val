'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

test('GOALL call-center metrics endpoint is read-only and account-aware',()=>{
  assert.match(server,/app\.get\('\/api\/goall\/call-center-metrics'/);
  assert.match(server,/resolvedGhlAccounts\(\)/);
  assert.match(server,/fetchGoallMetricRowsForAccount\(account,start,end\)/);
  assert.match(server,/ghlTryForAccount\(account,'GET',`\/conversations\/search/);
  const routeStart=server.indexOf("app.get('/api/goall/call-center-metrics'");
  const routeEnd=server.indexOf("\napp.get('/api/pipeline'",routeStart);
  const route=server.slice(routeStart,routeEnd);
  assert.doesNotMatch(route,/ghlStrict\('POST'|ghlStrict\('PUT'|ghlStrict\('DELETE'|ghlForAccount\(account,'POST'|ghlForAccount\(account,'PUT'|ghlForAccount\(account,'DELETE'/);
});

test('GOALL call-center metrics exposes the three dashboard slices',()=>{
  assert.match(server,/agentDashboard:\{/);
  assert.match(server,/ownerDashboard:\{/);
  assert.match(server,/revenueDashboard:\{/);
  assert.match(server,/hiddenRevenue:true/);
  assert.match(server,/meetingToEnrollmentRate/);
  assert.match(server,/averageRevenuePerEnrollment/);
});

test('GOALL call-center outcome normalization matches transcript outcomes',()=>{
  assert.match(server,/meeting_scheduled/);
  assert.match(server,/info_requested/);
  assert.match(server,/voicemail/);
  assert.match(server,/not_interested/);
  assert.match(server,/no_answer/);
  assert.match(server,/appointment_booked_yes_or_no/);
  assert.match(server,/type_no_show/);
  assert.match(server,/vm followup/);
  assert.match(server,/unsubscribe/);
  assert.match(server,/function goallNeedsDisposition/);
  assert.match(server,/function goallCustomDispositionNotExposed/);
  assert.match(server,/dispositionCompleteness/);
  assert.match(server,/customDispositionVisibility/);
  assert.match(server,/function goallDispositionQuality/);
  assert.match(server,/byAttemptTag/);
  assert.match(server,/function fetchGhlCallMessagesForAccount/);
  assert.match(server,/\/conversations\/messages\/export\?\$\{qs\.toString\(\)\}/);
  assert.match(server,/channel:'Call'/);
  assert.match(server,/customDispositionExposed:false/);
});

test('GOALL call-center metrics uses GHL conversation and contact field mapping',()=>{
  assert.match(server,/lastMessageDate\|\|value\?\.lastManualMessageDate/);
  assert.match(server,/fetchGhlCustomFieldMapForAccount\(account\)/);
  assert.match(server,/fetchGhlUserMapForAccount\(account\)/);
  assert.match(server,/\/users\/search\?\$\{qs\.toString\(\)\}/);
  assert.match(server,/callMessages\.length\?callMessages:conversations/);
  assert.match(server,/enrichGoallConversationForAccount\(account,conversation,fieldMap,userMap\)/);
  assert.match(server,/assigned_caller_first_name/);
  assert.match(server,/const assignedToName=userMap\.get/);
  assert.match(server,/canonicalGoallCallerName\(contactFields\.assignedCallerFirstName,userMap\)/);
  assert.match(server,/contactCallOutcomes/);
  assert.match(server,/String\(o\.status\|\|''\)\.toLowerCase\(\)==='won'/);
});

test('dashboard loads GOALL call-center metrics into live context',()=>{
  assert.match(dashboard,/HOOK_GOALL_CALL_CENTER = PROXY\+'\/api\/goall\/call-center-metrics'/);
  assert.match(dashboard,/fetchJSON\(HOOK_GOALL_CALL_CENTER\)/);
  assert.match(dashboard,/dashData\.goallCallCenterOwner/);
  assert.match(dashboard,/GOALL call center today/);
  assert.match(dashboard,/id="scCallCenterVal"/);
  assert.match(dashboard,/renderCallCenterDashboard\(callCenterMetrics\)/);
  assert.match(dashboard,/function askCallCenter\(\)/);
  assert.match(dashboard,/need disposition/);
  assert.match(dashboard,/disposition hidden/);
  assert.match(dashboard,/disposition completeness/);
  assert.match(dashboard,/Custom disposition API visibility/);
  assert.match(dashboard,/Needs disposition by agent/);
  assert.match(dashboard,/Needs disposition by attempt tag/);
});
