const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

test('gmail fetch uses 48 hour inbox freshness and sorts newest first',()=>{
  assert.match(server,/query='in:inbox newer_than:2d'/);
  assert.match(server,/const recentQuery=force\?'in:inbox newer_than:2d':'in:inbox newer_than:2d'/);
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

test('email intelligence UI has manual refresh and visible sync metadata',()=>{
  assert.match(dashboard,/Refresh Gmail/);
  assert.match(dashboard,/function refreshGmailNow/);
  assert.match(dashboard,/function renderEmailSyncStatus/);
  assert.match(dashboard,/Last successful sync/);
  assert.match(dashboard,/\/api\/email\/gmail\/refresh/);
});
