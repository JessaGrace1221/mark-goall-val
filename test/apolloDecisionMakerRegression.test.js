'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

test('Apollo decision-maker lookup is staged like manual search',()=>{
  assert.match(server,/APOLLO_PEOPLE_SEARCH_PAGES/);
  assert.match(server,/APOLLO_PEOPLE_SEARCH_PER_PAGE/);
  assert.match(server,/include_similar_titles[\s\S]+true/);
  assert.match(server,/\/mixed_companies\/search/);
  assert.match(server,/q_organization_name/);
  assert.match(server,/organization_ids\[\]/);
  assert.match(server,/company keyword/);
});

test('Apollo decision-maker lookup does not default to HQ location filtering',()=>{
  const start=server.indexOf('async function lookupApolloDecisionMaker');
  const end=server.indexOf('\nasync function enrichProspectWithApollo',start);
  const body=server.slice(start,end);
  assert.doesNotMatch(body,/organization_locations\[\]/);
  assert.doesNotMatch(body,/lead\.state\).*organization_locations/);
});
