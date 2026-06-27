'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const commandCenter=fs.readFileSync(path.join(root,'command-center.js'),'utf8');

test('personal VAL exposes transcripts as a first-class workspace item',()=>{
  assert.match(commandCenter,/\{id:'transcripts',icon:'document',label:'Transcripts',group:'core'\}/);
  assert.match(commandCenter,/if\(view==='transcripts'\)\{openTranscripts\(\);return;\}/);
  assert.match(commandCenter,/window\.openTranscripts=function/);
});

test('intelligence backfill rehydrates existing evidence before dashboard conclusions',()=>{
  assert.match(server,/app\.post\('\/api\/val\/intelligence\/backfill'/);
  assert.match(server,/async function backfillValIntelligence/);
  assert.match(server,/Postgres is not connected/);
  assert.match(server,/backfillTranscriptEvidence/);
  assert.match(server,/backfillEmailEvidence/);
  assert.match(server,/saveEvidenceItem/);
  assert.match(server,/runObservationEngine/);
  assert.match(server,/relationshipReviewFromStoredProfiles/);
  assert.match(server,/buildExecutiveBriefing/);
});

test('transcript migration merges old archive records with the processed transcript index',()=>{
  assert.match(server,/function mergeTranscriptMigrationRecords/);
  assert.match(server,/transcriptMigrationRecordsFromIndex/);
  const start=server.indexOf("app.get('/api/val/transcripts'");
  const end=server.indexOf("app.get('/api/val/transcripts/review'",start);
  const body=server.slice(start,end);
  assert.match(body,/transcriptArchiveRecords\(days,limit\)/);
  assert.match(body,/mergeTranscriptMigrationRecords\(archive,data\)/);
  assert.doesNotMatch(body,/if\(data\.transcripts\.length\)/);
});

test('transcript migration fallback observations quote the evidence instead of vague titles',()=>{
  const start=server.indexOf('function transcriptBackfillCandidates');
  const end=server.indexOf('function transcriptMigrationRecordsFromIndex',start);
  const body=server.slice(start,end);
  assert.match(server,/function transcriptEvidenceSnippet/);
  assert.match(server,/function transcriptFallbackObservationContent/);
  assert.match(server,/Possible risk:/);
  assert.match(server,/Possible opportunity:/);
  assert.doesNotMatch(body,/includes possible risk, concern, blocker, or drift language/);
  assert.doesNotMatch(body,/includes possible opportunity, introduction, referral, partnership, lead, client, or deal language/);
});

test('personal transcript migration can run without touching email or Michele book mode',()=>{
  const start=server.indexOf("app.post('/api/val/transcripts/migrate'");
  const end=server.indexOf("app.post('/api/relationships/actions'",start);
  const body=server.slice(start,end);
  assert.match(body,/isBookEditorProject\(\)/);
  assert.match(body,/backfillTranscriptEvidence/);
  assert.match(body,/executiveBriefingCounts/);
  assert.doesNotMatch(body,/backfillEmailEvidence/);
  assert.doesNotMatch(body,/saveTask\(/);
});

test('email backfill keeps the evidence-first rule',()=>{
  const start=server.indexOf('async function backfillEmailEvidence');
  const end=server.indexOf('async function backfillValIntelligence',start);
  const body=server.slice(start,end);
  assert.match(body,/classifyEmail\(email,rules\)/);
  assert.match(body,/saveEmailEvidenceBatch/);
  assert.doesNotMatch(body,/saveTask\(/);
  assert.doesNotMatch(body,/create_task/);
});

test('relationship review can use stored relationship engine profiles when provider review is empty',()=>{
  assert.match(server,/function relationshipContactFromStoredProfile/);
  assert.match(server,/async function relationshipReviewFromStoredProfiles/);
  assert.match(server,/source:'relationship_profiles'/);
  assert.match(server,/providerReviewErrors/);
  assert.match(server,/stored&&\(stored\.relationshipProfiles\|\|\[\]\)\.length/);
});
