const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'command-center.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

test('creates the six transcript intelligence staging tables',()=>{
  for(const table of ['transcripts','transcript_participants','transcript_summaries','transcript_tasks','transcript_contact_updates','transcript_action_log']){
    assert.match(server,new RegExp(`create table if not exists ${table} \\(`));
  }
});

test('saves raw transcripts before legacy storage and stages tasks before promotion',()=>{
  const saveStart=server.indexOf('async function saveTranscript(payload)');
  const rawSave=server.indexOf('await saveTranscriptIndexRaw(payload,indexId)',saveStart);
  const legacySave=server.indexOf("insert into val_transcripts",saveStart);
  assert.ok(rawSave>saveStart&&rawSave<legacySave,'raw index save must happen first');
  const processStart=server.indexOf('async function processTranscriptPayload(payload)');
  const stage=server.indexOf('await saveStagedTranscriptTask(staged)',processStart);
  const promote=server.indexOf('promoteTranscriptTask(staged)',stage);
  assert.ok(stage>processStart&&promote>stage,'task must be staged before promotion');
});

test('requires evidence, confidence, review state, and action traceability',()=>{
  assert.match(server,/source_quote text not null/);
  assert.match(server,/match_confidence numeric not null/);
  assert.match(server,/needs_review boolean not null/);
  assert.match(server,/logTranscriptAction\(sourceId,'failed_action'/);
  assert.match(server,/Ambiguous match:/);
});

test('exposes inbox, detail, and review queue UI',()=>{
  assert.match(ui,/Transcript Intelligence/);
  assert.match(ui,/Review Queue/);
  assert.match(ui,/Participants & Match Confidence/);
  assert.match(ui,/Action Log/);
  assert.match(ui,/Approve & Create/);
});

test('stores meeting recap templates and renders transcript recap drafts from them',()=>{
  assert.match(server,/create table if not exists val_templates \(/);
  assert.match(server,/DEFAULT_MEETING_RECAP_TEMPLATE/);
  assert.match(server,/app\.get\('\/api\/val\/templates\/:templateKey'/);
  assert.match(server,/app\.put\('\/api\/val\/templates\/:templateKey'/);
  assert.match(server,/saveMeetingRecapDraft/);
  assert.match(server,/renderMeetingRecapTemplate/);
  assert.match(server,/draftType:'meeting_recap'/);
  assert.match(server,/htmlBody:rendered\.htmlBody/);
});

test('exposes drafts and settings templates navigation',()=>{
  assert.match(ui,/\['drafts','✎','Drafts'\]/);
  assert.match(ui,/\['settings_templates','▤','Templates'\]/);
  assert.match(ui,/settings_templates:'openTemplatesPage'/);
  assert.match(ui,/drafts:'openDraftsPage'/);
  assert.match(dashboard,/function openTemplatesPage/);
  assert.match(dashboard,/function openDraftsPage/);
  assert.match(dashboard,/meetingRecapSubjectTemplate/);
  assert.match(dashboard,/api\/val\/templates\/meeting_recap/);
  assert.match(dashboard,/api\/val\/drafts/);
});
