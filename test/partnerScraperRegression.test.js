'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
const nav=fs.readFileSync(path.join(root,'command-center.js'),'utf8');

test('navigation exposes independent employer and partner modes',()=>{
  assert.match(nav,/Scrape Employers/);
  assert.match(nav,/Scrape Partners/);
  assert.match(nav,/leads_employers:'openLeadIntelligence'/);
  assert.match(nav,/leads_partners:'openPartnerIntelligence'/);
  assert.match(dashboard,/Would this company benefit from GOALL\?/);
  assert.match(dashboard,/Could this organization help GOALL reach many employers\?/);
});

test('partner workflow has separate preview and approval endpoints',()=>{
  assert.match(server,/\/api\/val\/partners\/discover-preview/);
  assert.match(server,/\/api\/val\/partners\/import-approved/);
  assert.match(dashboard,/pendingPartnerImport/);
  assert.match(dashboard,/Push approved partners to CRM/);
});

test('partner scoring uses the required 100 point weights and potential reach',()=>{
  assert.match(server,/Audience \$\{audienceSize\}\/30/);
  assert.match(server,/employer access \$\{employerAccess\}\/25/);
  assert.match(server,/trust\/credibility \$\{trustCredibility\}\/20/);
  assert.match(server,/ease of partnership \$\{easeOfPartnership\}\/15/);
  assert.match(server,/growth potential \$\{growthPotential\}\/10/);
  assert.match(server,/function partnerPotentialReach/);
  assert.ok(dashboard.includes("sortPartnerReview(\\'potentialReach\\')"));
});

test('partner CRM writes are locked to the strategic partner destination',()=>{
  assert.match(server,/GHL_PARTNER_PIPELINE_NAME[^\n]+GOALL Strategic Partners/);
  assert.match(server,/GHL_PARTNER_STAGE_NAME[^\n]+New Limitless Lead Added/);
  assert.match(server,/async function getPartnerOpportunityTarget/);
  assert.match(server,/pipelineId:target\.pipelineId,pipelineStageId:target\.stageId/);
  assert.match(server,/tags:\['partner','GOALL Strategic Partner'/);
});

test('every employer CRM path adds the Employer tag',()=>{
  assert.match(server,/\[automation\.automationTag,'Employer','GOALL Lead','Limitless Leads'\]/);
  assert.match(server,/\[tag,'Employer'\]/);
  assert.match(server,/\[discovered\.tag\|\|'limitless_enrich','Employer'\]/);
});

test('partner dedupe includes email phone website company and LinkedIn',()=>{
  const start=server.indexOf('function leadDuplicateNeedles');
  const end=server.indexOf('\nasync function findExistingGhlLeadDuplicate',start);
  const body=server.slice(start,end);
  assert.match(body,/p\.email/);
  assert.match(body,/p\.phone/);
  assert.match(body,/leadDomain\(p\.website/);
  assert.match(body,/normalizeCompanyForMatch/);
  assert.match(body,/linkedinPersonalUrl\|\|p\.linkedinCompanyUrl/);
  assert.match(server,/await findExistingGhlLeadDuplicate\(p\)/);
});

test('partner custom fields include reach score reasoning sources and date',()=>{
  for(const key of ['partner_type','organization_size','potential_reach','partnership_fit_score','reason_for_score','source_urls','date_added']){
    assert.match(server,new RegExp(`${key}:`));
  }
  assert.match(server,/GOALL Strategic Partner Prospecting/);
  assert.match(server,/preferredFreshnessMonths:12/);
  assert.match(server,/supportingSourcesPreferred:2/);
});
