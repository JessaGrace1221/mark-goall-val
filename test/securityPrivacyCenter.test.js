const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
const commandCenter=fs.readFileSync(path.join(root,'command-center.js'),'utf8');

test('security center has tenant-scoped audit and support structures',()=>{
  assert.match(server,/create table if not exists security_audit_logs/);
  assert.match(server,/tenant_id text not null/);
  assert.match(server,/create table if not exists tenant_support_access/);
  assert.match(server,/function auditLog/);
  assert.match(server,/support_access_granted/);
  assert.match(server,/support_access_revoked/);
});

test('oauth token secrets are encrypted and not exposed as frontend status',()=>{
  assert.match(server,/const OAUTH_SECRET_FIELDS=\['access_token','refresh_token','id_token'\]/);
  assert.match(server,/function encryptOAuthTokens/);
  assert.match(server,/function decryptOAuthTokens/);
  assert.match(server,/ENCRYPTION_KEY is required to save OAuth tokens in production/);
  assert.match(server,/publicOAuthTokens/);
  assert.doesNotMatch(dashboard,/refresh_token/);
});

test('rbac protects security and data control endpoints',()=>{
  assert.match(server,/const SECURITY_ROLE_PERMISSIONS/);
  assert.match(server,/function requirePermission/);
  assert.match(server,/requirePermission\('security:view'\)/);
  assert.match(server,/requirePermission\('audit:view'\)/);
  assert.match(server,/requirePermission\('data:export'\)/);
  assert.match(server,/requirePermission\('data:delete'\)/);
});

test('security privacy ui is available under settings navigation',()=>{
  assert.match(commandCenter,/settings_security/);
  assert.match(commandCenter,/Security & Privacy/);
  assert.match(commandCenter,/openSecurityPrivacyPage/);
  assert.match(dashboard,/function openSecurityPrivacyPage/);
  assert.match(dashboard,/Connected Accounts/);
  assert.match(dashboard,/Data Sources/);
  assert.match(dashboard,/Active Sessions/);
  assert.match(dashboard,/Login History/);
  assert.match(dashboard,/Audit Log/);
  assert.match(dashboard,/Support Access/);
});

test('sensitive actions create audit events',()=>{
  assert.match(server,/email_searched/);
  assert.match(server,/email_forward_draft_created/);
  assert.match(server,/draft_created/);
  assert.match(server,/transcript_opened/);
  assert.match(server,/transcript_processed/);
  assert.match(server,/calendar_event_created/);
  assert.match(server,/oauth_account_connected/);
  assert.match(server,/oauth_account_disconnected/);
});
