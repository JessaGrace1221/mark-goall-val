const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'command-center.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');

test('creates transcript intelligence staging and evidence tables',()=>{
  for(const table of ['transcripts','transcript_participants','transcript_summaries','transcript_tasks','transcript_contact_updates','transcript_action_log','evidence_items','evidence_observations','val_evidence_links']){
    assert.match(server,new RegExp(`create table if not exists ${table} \\(`));
  }
  for(const column of ['source_url','occurred_at','captured_at','participants_json','entities_json','metadata_json']){
    assert.match(server,new RegExp(`${column} `));
  }
  for(const type of ['promise','commitment','task','decision','question','need','preference','risk','opportunity','relationship_signal','emotional_context','deadline','follow_up','idea']){
    assert.match(server,new RegExp(`'${type}'`));
  }
  assert.match(server,/evidence_items_source_idx/);
  assert.match(server,/evidence_observations_type_idx/);
  assert.match(server,/val_evidence_links_source_idx/);
  assert.match(server,/val_evidence_links_target_idx/);
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
  assert.match(server,/async function saveEvidenceItem/);
  assert.match(server,/async function saveEvidenceObservation/);
  assert.match(server,/async function runObservationEngine/);
  assert.match(server,/normalizeObservationCandidate/);
  assert.match(server,/saveTranscriptEvidenceObservations/);
  assert.match(server,/runObservationEngine\(evidence,\{candidates,replace:true\}\)/);
  assert.match(server,/async function saveEvidenceLink/);
  assert.match(server,/relationship:'extracted_task'/);
  assert.match(server,/relationship:'created_task'/);
  assert.match(server,/relationship:'created_followup_draft'/);
  assert.match(server,/clearEvidenceLinksForTranscript/);
  assert.match(server,/logTranscriptAction\(sourceId,'failed_action'/);
  assert.match(server,/Ambiguous match:/);
});

test('relationship engine builds living profiles from observations without creating tasks',()=>{
  for(const table of ['relationship_profiles','relationship_timeline_events']){
    assert.match(server,new RegExp(`create table if not exists ${table} \\(`));
  }
  for(const column of ['profile_type','profile_key','last_observed_at','observation_count','open_loops_json','relationship_signals_json','risks_json','opportunities_json','preferences_json']){
    assert.match(server,new RegExp(`${column} `));
  }
  assert.match(server,/async function runRelationshipEngineForObservations/);
  assert.match(server,/async function saveRelationshipProfile/);
  assert.match(server,/async function saveRelationshipTimelineEvent/);
  assert.match(server,/function relationshipTargetsForObservation/);
  assert.match(server,/relationshipObservationIsNoise/);
  assert.match(server,/\['spam','newsletter','receipt'\]/);
  assert.match(server,/clearRelationshipTimelineForEvidence\(evidenceItem\.id\)/);
  assert.match(server,/runRelationshipEngineForObservations\(evidenceItem,observations\)/);
  assert.doesNotMatch(server,/runRelationshipEngineForObservations[\s\S]{0,1200}saveTask/);
});

test('agency engine ranks discerning moves without turning observations into tasks',()=>{
  for(const table of ['agency_moves','agency_move_sources']){
    assert.match(server,new RegExp(`create table if not exists ${table} \\(`));
  }
  for(const column of ['move_type','why','confidence','importance_score','agency_level','priority_band','what_changed','if_ignored','source_observation_ids','source_evidence_ids']){
    assert.match(server,new RegExp(`${column} `));
  }
  for(const move of ['draft_reply','send_follow_up','schedule_meeting','send_document','answer_question','review_risk','close_open_loop','wait','ignore','update_project','protect_relationship']){
    assert.match(server,new RegExp(`'${move}'`));
  }
  for(const band of ['top_recommended','also_important','quiet','watching','ignored']){
    assert.match(server,new RegExp(`'${band}'`));
  }
  assert.match(server,/async function runAgencyEngineForObservations/);
  assert.match(server,/function agencyMovePlanForObservation/);
  assert.match(server,/function agencyMoveTitleForObservation/);
  assert.match(server,/function agencyContentSubject/);
  assert.doesNotMatch(server,/title:'Review relationship or project risk'/);
  assert.match(server,/function agencyImportance/);
  assert.match(server,/function agencyPriorityBand/);
  assert.match(server,/async function saveAgencyMove/);
  assert.match(server,/async function saveAgencyMoveSource/);
  assert.match(server,/clearAgencyMovesForEvidence\(evidenceItem\.id\)/);
  assert.match(server,/runAgencyEngineForObservations\(evidenceItem,observations\)/);
  assert.match(server,/if\(topCount>3\)item\.plan\.priorityBand='also_important'/);
  assert.match(server,/moveType:'ignore'/);
  assert.match(server,/moveType:'wait'/);
  assert.doesNotMatch(server,/runAgencyEngineForObservations[\s\S]{0,2500}saveTask/);
});

test('exposes inbox, detail, and review queue UI',()=>{
  assert.match(ui,/Transcript Intelligence/);
  assert.match(ui,/Review Queue/);
  assert.match(ui,/Saved conversations/);
  assert.match(ui,/Chat About This Transcript/);
  assert.match(ui,/Processing details/);
  assert.match(ui,/Approve & Create/);
});

test('transcript detail defaults to summary, transcript, and transcript-specific chat',()=>{
  for(const label of ['Summary','Transcript','Chat About This Transcript','Processing details']){
    assert.ok(ui.includes(label),`missing ${label}`);
  }
  assert.match(ui,/api\/val\/transcripts\/'\+encodeURIComponent\(t\.id\)\+'\/chat/);
  assert.match(server,/app\.post\('\/api\/val\/transcripts\/:transcriptId\/chat'/);
  assert.match(server,/Do not say you need an email, document, Gmail, Drive, or external source/);
  assert.match(server,/function cleanTranscriptForUi/);
  assert.match(server,/function cleanTranscriptSummaryForUi/);
  assert.match(server,/function cleanTranscriptTitleForUi/);
  assert.match(server,/transcript\.drafts=\(await listDrafts\(\)\)\.filter/);
  assert.match(server,/req\.query\.transcriptId/);
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
  assert.match(ui,/Meeting Recaps & Drafts/);
  assert.match(dashboard,/Related|Transcript:|Meeting:|Recipients:/);
});
