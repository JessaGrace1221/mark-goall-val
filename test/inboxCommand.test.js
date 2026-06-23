const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

test('adds Inbox Command provider abstraction and natural language search',()=>{
  assert.match(server,/const emailProviders=\{/);
  assert.match(server,/gmail:\{async search/);
  assert.match(server,/outlook:\{async search/);
  assert.match(server,/function gmailQueryFromInboxCommand/);
  assert.match(server,/async function runInboxCommand/);
  assert.match(server,/app\.post\('\/api\/email\/inbox-command'/);
});

test('Inbox Command supports safe draft actions without direct sending',()=>{
  assert.match(server,/async function inboxCommandAction/);
  assert.match(server,/draftType:'email_reply'/);
  assert.match(server,/draftType:'email_forward'/);
  assert.match(server,/requiresApproval:true/);
  assert.doesNotMatch(server,/gmail\/v1\/users\/me\/messages\/send/);
});

test('Inbox Command is available in Email AI and global chat',()=>{
  assert.match(dashboard,/Inbox Command/);
  assert.match(dashboard,/function runInboxCommand/);
  assert.match(dashboard,/function inboxCommandAction/);
  assert.match(dashboard,/\/api\/email\/inbox-command/);
  assert.match(server,/if\(inboxCommandIntent\(lastUser\)\)/);
  assert.match(server,/inboxCommand:inbox/);
});
