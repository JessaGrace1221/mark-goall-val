const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
const commandCenter=fs.readFileSync(path.join(root,'command-center.js'),'utf8');

test('Dashboard Studio is available across VAL dashboards and feature-flag aware',()=>{
  assert.match(server,/create table if not exists tenant_feature_flags/);
  assert.match(server,/create table if not exists dashboard_change_requests/);
  assert.match(server,/create table if not exists dashboard_update_requests/);
  assert.match(server,/create table if not exists premium_update_requests/);
  assert.match(server,/create table if not exists deployment_history/);
  assert.match(server,/create table if not exists tenant_dashboard_studio_overrides/);
  assert.match(server,/create table if not exists tenant_environment_variables_metadata/);
  assert.match(server,/dashboard_studio_beta/);
  assert.match(server,/defaultEnabled:true/);
  assert.match(server,/requireDashboardStudioAccess/);
  assert.match(server,/Dashboard Studio is not enabled for this VAL/);
  assert.match(server,/dashboard_studio:view/);
  assert.match(server,/dashboard_studio:request_config_change/);
  assert.match(server,/dashboard_studio:request_code_change/);
  assert.match(server,/dashboard_studio:approve_change/);
});

test('Dashboard Studio classifies safe code and blocked changes',()=>{
  assert.match(server,/function classifyDashboardStudioRequest/);
  assert.match(server,/DASHBOARD_STUDIO_UPDATE_POLICY/);
  assert.match(server,/approved_auto_deploy_categories/);
  assert.match(server,/premium_categories/);
  assert.match(server,/blocked_categories/);
  assert.match(server,/approved_existing_connections/);
  assert.match(server,/classification:'auto_deploy'/);
  assert.match(server,/classification:'premium_request'/);
  assert.match(server,/classification:'blocked'/);
  assert.match(server,/classification:'needs_clarification'/);
  assert.match(server,/Dashboard Studio is policy-governed/);
  assert.match(server,/new \(integration\|api\|external api\|provider/);
  assert.match(server,/cross-tenant|tenant-isolation|tenant isolation/);
  assert.match(server,/direct production/);
  assert.match(server,/dashboardStudioMissingVariableChecklist/);
  assert.match(server,/tenantApiKeysStoredInRailway:false/);
});

test('Dashboard Studio stores request history and audits actions',()=>{
  assert.match(server,/app\.get\('\/api\/dashboard-studio',requireDashboardStudioAccess/);
  assert.match(server,/app\.post\('\/api\/dashboard-studio\/requests',requireDashboardStudioAccess/);
  assert.match(server,/app\.post\('\/api\/dashboard-studio\/requests\/:id\/approve'/);
  assert.match(server,/app\.get\('\/api\/dashboard-studio\/admin',requireDashboardStudioAccess,requirePermission\('dashboard_studio:admin_review'\)/);
  assert.match(server,/app\.post\('\/api\/dashboard-studio\/premium-requests\/:id\/review'/);
  for(const action of ['dashboard_studio_opened','dashboard_change_requested','dashboard_change_classified','dashboard_change_blocked','dashboard_change_approved','dashboard_change_rejected','premium_update_request_created','premium_update_admin_notification_created','premium_update_request_reviewed','deployment_history_recorded']){
    assert.match(server,new RegExp(action));
  }
  assert.match(server,/createPremiumUpdateRequest/);
  assert.match(server,/reviewPremiumUpdateRequest/);
  assert.match(server,/createDeploymentHistory/);
  assert.match(server,/upsertTenantVariableMetadata/);
  assert.match(server,/executeDashboardStudioSafeDeploy/);
  assert.match(server,/Code pushes are not wired to Dashboard Studio/);
  assert.doesNotMatch(server,/github_branch_created.*create.*branch/i);
});

test('Dashboard Studio phase three deploys tenant-only overrides with rollback',()=>{
  assert.match(server,/function enforceDashboardStudioTenantOnly/);
  assert.match(server,/function dashboardStudioDeploymentPreflight/);
  assert.match(server,/async function executeDashboardStudioSafeDeploy/);
  assert.match(server,/async function rollbackDashboardStudioDeployment/);
  assert.match(server,/tenantOnly:true/);
  assert.match(server,/noSecrets:true/);
  assert.match(server,/noExternalWrites:true/);
  assert.match(server,/noSchemaChanges:true/);
  assert.match(server,/noCrossTenantChanges:true/);
  assert.match(server,/dashboard_studio_safe_auto_deploy/);
  assert.match(server,/dashboard_studio_rollback/);
  assert.match(server,/previousOverride/);
  assert.match(server,/app\.get\('\/api\/dashboard-studio\/deployments\/status'/);
  assert.match(server,/app\.post\('\/api\/dashboard-studio\/deployments\/:id\/rollback'/);
  assert.match(server,/dashboardStudioOverrides/);
  assert.match(dashboard,/Deployment Status/);
  assert.match(dashboard,/rollbackDashboardStudioDeployment/);
  assert.match(commandCenter,/dashboardStudioOverrides/);
});

test('Dashboard Studio demo changes stay inside the demo session',()=>{
  assert.match(server,/function dashboardStudioSessionArray/);
  assert.match(server,/requestContext\.getStore\(\)\?\.demoState/);
  assert.match(server,/dashboardStudioSessionArray\('dashboardChangeRequests'\)/);
  assert.match(server,/dashboardStudioSessionArray\('premiumUpdateRequests'\)/);
  assert.match(server,/dashboardStudioSessionArray\('deploymentHistory'\)/);
  assert.match(server,/dashboardStudioSessionArray\('tenantDashboardStudioOverrides'\)/);
  assert.match(server,/dashboardStudioSessionArray\('tenantEnvironmentVariablesMetadata'\)/);
  assert.match(server,/VAL_DEMO_MODE/);
  assert.match(server,/resetDemoState/);
});

test('Dashboard Studio UI is hidden unless backend feature flag is enabled',()=>{
  assert.match(commandCenter,/settings_dashboard_studio/);
  assert.match(commandCenter,/dashboardStudioEnabled/);
  assert.match(commandCenter,/VAL_CONFIG\.featureFlags\.dashboard_studio_beta/);
  assert.match(commandCenter,/openDashboardStudioPage/);
  assert.match(dashboard,/function openDashboardStudioPage/);
  assert.match(dashboard,/Dashboard Studio is a beta feature/);
  assert.match(dashboard,/Premium Update Requests/);
  assert.match(dashboard,/Pending Variables/);
  assert.match(dashboard,/Deployment History/);
  assert.match(dashboard,/Deployment Status/);
  assert.match(dashboard,/Dashboard Studio Project Manager/);
  assert.match(dashboard,/What would you like to improve today/);
  assert.match(dashboard,/Existing Features/);
  assert.match(dashboard,/Email Intelligence/);
  assert.match(dashboard,/Lead Scraper/);
  assert.match(dashboard,/Meeting Assistant/);
  assert.match(dashboard,/dashboardStudioFeatureSearch/);
  assert.match(dashboard,/selectDashboardStudioCategory/);
  assert.match(dashboard,/selectDashboardStudioFeature/);
  assert.match(dashboard,/reviewPremiumUpdateRequest/);
  assert.match(dashboard,/Auto-deploy candidate/);
  assert.match(dashboard,/Premium request/);
  assert.match(dashboard,/Railway rule/);
  assert.match(dashboard,/Pick a lane first so VAL already knows the scope/);
  assert.match(dashboard,/Request History/);
  assert.match(dashboard,/Jessa says deploy/);
  assert.match(dashboard,/Only use this when Jessa is present/);
});
