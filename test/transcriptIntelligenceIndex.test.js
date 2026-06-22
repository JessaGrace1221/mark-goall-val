const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'command-center.js'),'utf8');

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
