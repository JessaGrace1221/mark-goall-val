'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

test('relationship ingestion establishes and enforces owner identity',()=>{
  assert.match(server,/function relationshipOwnerIdentity/);
  assert.match(server,/ADMIN_EMAIL/);
  assert.match(server,/ADMIN_NAME/);
  assert.match(server,/VAL_OWNER_ALIASES/);
  assert.match(server,/filter\(person=>!isOwnerRelationship\(person,owner\)\)/);
  assert.match(server,/!isOwnerRelationship\(p,owner\)/);
});

test('emails and meetings attribute evidence to external participants',()=>{
  assert.match(server,/function relationshipEmailParticipants/);
  assert.match(server,/relationshipEmailParticipants\(email\).*filter\(person=>!isOwnerRelationship/s);
  assert.match(server,/inferAttendeesFromEvent\(ev\)\.forEach/);
  assert.match(server,/if\(isOwnerRelationship\(\{name:cleanName,email:cleanEmail\},owner\)/);
});

test('tracking notifications and preference memory are not relationship evidence',()=>{
  assert.match(server,/mailsuite\|mailtrack\|email tracking\|tracking notification/);
  assert.match(server,/memory\.filter\(m=>m&&m\.kind!==\'relationship_preference\'\)/);
});

test('identity resolution merges exact email name and company signals',()=>{
  assert.match(server,/existing\.email===cleanEmail/);
  assert.match(server,/normalizeContextName\(existing\.name\)===normalizedName/);
  assert.match(server,/normalizeContextName\(existing\.company\)===normalizedCompany/);
  assert.match(server,/new Set\(people\.values\(\)\)/);
});

test('all relationship actions are wired with readable hierarchy',()=>{
  for(const action of ['draft_message','create_task','brainstorm','mark_vip','snooze','not_important'])assert.ok(dashboard.includes(`relationshipAction('${action}')`)||dashboard.includes(`action:'${action}'`));
  assert.match(dashboard,/showRelationshipProfile\(\)/);
  assert.match(dashboard,/relationship-actions/);
  assert.match(dashboard,/relationship-action-panel/);
  assert.match(dashboard,/relationship-profile-grid/);
});

test('VIP snooze and not-important preferences alter review visibility',()=>{
  assert.match(server,/p\.manualVip=pref\.action===\'mark_vip\'/);
  assert.match(server,/p\.notImportant=pref\.action===\'not_important\'/);
  assert.match(server,/p\.snoozedUntil=pref\.action===\'snooze\'/);
  assert.match(server,/!p\.notImportant&&\(!p\.snoozedUntil/);
});

test('null contacts cannot crash production relationship ingestion',()=>{
  assert.match(server,/if\(!p\|\|p\.name===\'Unknown\'\) continue/);
});

test('relationship contrast rules load after the shared command center stylesheet',()=>{
  const sharedStyles=dashboard.search(/<link rel="stylesheet" href="\/command-center\.css(?:\?[^\"]*)?">/);
  const contrastStyles=dashboard.indexOf('<style id="relationship-review-contrast">');
  assert.ok(sharedStyles>=0&&contrastStyles>sharedStyles);
  assert.match(dashboard,/\.exec-workspace-modal \.exec-workspace-footer \.alert-btn\{[^}]*color:#172740!important/);
  assert.match(dashboard,/\.exec-workspace-modal #relationshipTabs button\{[^}]*color:#172740!important/);
  assert.match(dashboard,/\.relationship-review-error\{[^}]*color:#7f1d1d!important/);
});
