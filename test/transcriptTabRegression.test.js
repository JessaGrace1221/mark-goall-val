'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'command-center.js'),'utf8');
const css=fs.readFileSync(path.join(root,'command-center.css'),'utf8');

test('webhook accepts common transcript payload shapes and validates text',()=>{
  assert.match(server,/function normalizedTranscriptWebhookPayload/);
  for(const field of ['rawText','raw_text','transcriptText','transcript_text','text','content','body','segments','sentences'])assert.ok(server.includes(field));
  assert.match(server,/A usable transcript text field is required/);
  assert.match(server,/\[transcripts\] webhook received/);
  assert.match(server,/\[transcripts\] saved successfully/);
  assert.match(server,/\[transcripts\] save failed/);
});

test('transcript metadata is flattened and processing results are persisted',()=>{
  assert.match(server,/const nested=payload\.metadata&&typeof payload\.metadata===\'object\'/);
  assert.match(server,/function updateTranscriptMetadata/);
  assert.match(server,/reviewStatus:\'needs_review\'/);
  assert.match(server,/processing failed after durable save/);
  assert.match(server,/fallbackTranscriptSummary/);
  assert.match(server,/process_endpoint/);
});

test('retrieval merges dedicated transcript storage with legacy durable memory',()=>{
  assert.match(server,/function transcriptArchiveRecords/);
  assert.match(server,/Promise\.all\(\[recentTranscripts\(days\),recentMemoryItems/);
  assert.match(server,/recoveredFrom:\'val_memory_items\'/);
  assert.match(server,/legacyGroups/);
});

test('transcript titles reject command labels and prefer real topics',()=>{
  assert.match(server,/function transcriptTopicTitleFromText/);
  assert.match(server,/prepare me for\|summarize this past meeting\|meeting prep/);
  assert.match(server,/speaker\|user\|time\|date\|summary\|system\|assistant/);
  assert.match(server,/const topic=transcriptTopicTitleFromText/);
});

test('retrieval returns required fields and accurate counters',()=>{
  for(const field of ['receivedAt','reviewStatus','openActionCount','sourcePayloadMetadata','company','contactName'])assert.ok(server.includes(field));
  assert.match(server,/\['new','unreviewed','needs_review'\]\.includes\(t\.reviewStatus\)/);
  assert.match(server,/Number\(t\.openActionCount\|\|t\.taskCount\|\|0\)>0/);
  assert.match(server,/\[transcripts\] retrieval requested/);
  assert.match(server,/\[transcripts\] retrieval failed/);
});

test('frontend distinguishes loading failure from a successful empty archive',()=>{
  assert.match(ui,/data\.ok===false\|\|!Array\.isArray\(data\.transcripts\)/);
  assert.match(ui,/Unable to load transcripts/);
  assert.match(ui,/Check the transcript retrieval endpoint or server logs/);
  assert.match(ui,/No transcripts have arrived yet/);
  assert.match(ui,/renderTranscriptLoading/);
});

test('refresh reloads the full durable archive and updates counts',()=>{
  assert.match(ui,/api\/val\/transcripts\?days=3650&limit=250/);
  assert.match(ui,/onclick="loadTranscripts\(true\)\.catch/);
  assert.match(ui,/transcriptState\.counts=data\.counts/);
  assert.match(ui,/updateCommandCenterBadges/);
  assert.match(ui,/lastLoadedAt=new Date\(\)\.toISOString/);
});

test('pending transcript repair can reprocess stuck received rows',()=>{
  assert.match(server,/app\.post\('\/api\/val\/transcripts\/repair'/);
  assert.match(server,/processExistingTranscriptRecord/);
  assert.match(server,/processingStatus:'failed',summaryStatus:'fallback_complete'/);
  assert.match(server,/participant_matching/);
  assert.match(ui,/function transcriptHeader/);
  assert.match(ui,/Process Pending/);
  assert.match(ui,/repairTranscriptProcessing/);
  assert.match(ui,/api\/val\/transcripts\/repair/);
});

test('left navigation exposes live transcript, task, and draft badges',()=>{
  assert.match(ui,/function navBadge/);
  assert.match(ui,/data-badge-view/);
  assert.match(ui,/function pendingDraftCount/);
  assert.match(ui,/function openTaskCount/);
  assert.match(ui,/function transcriptAttentionCount/);
  assert.match(ui,/window\.syncCommandCenterDrafts/);
  assert.match(css,/\.val-nav-badge\{/);
  assert.match(css,/\.val-nav-badge\.empty\{display:none\}/);
  assert.match(css,/\.val-nav-label/);
});

test('every transcript card exposes the four required actions',()=>{
  for(const label of ['Open Transcript','Ask VAL','Create Task','Draft Follow-Up'])assert.ok(ui.includes(label));
  assert.match(server,/app\.post\('\/api\/val\/transcripts\/:transcriptId\/actions'/);
  assert.match(server,/action===\'create_task\'/);
  assert.match(server,/action===\'draft_followup\'/);
});

test('transcript cards and errors have readable responsive styling',()=>{
  assert.match(css,/\.val-transcript-actions\{/);
  assert.match(css,/\.val-transcript-error\{/);
  assert.match(css,/\.val-transcript-row\{[^}]*color:#17243a/);
  assert.match(css,/@media\(max-width:900px\)[\s\S]*\.val-transcript-row\{grid-template-columns:1fr\}/);
});
