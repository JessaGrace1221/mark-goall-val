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
});

test('dashboard loads GOALL call-center metrics into live context',()=>{
  assert.match(dashboard,/HOOK_GOALL_CALL_CENTER = PROXY\+'\/api\/goall\/call-center-metrics'/);
  assert.match(dashboard,/fetchJSON\(HOOK_GOALL_CALL_CENTER\)/);
  assert.match(dashboard,/dashData\.goallCallCenterOwner/);
  assert.match(dashboard,/GOALL call center today/);
});
