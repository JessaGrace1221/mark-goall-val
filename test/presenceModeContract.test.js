const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

test('presence mode contract defines proactive noticing and confirmation boundaries',()=>{
  assert.match(server,/const PRESENCE_MODE_CONTRACT=/);
  assert.match(server,/coreRule:'VAL may be proactive with evidence-backed insight, but conservative with consequences\.'/);
  for(const allowed of ['save_evidence','extract_observations','update_memory','update_relationship_timeline','create_draft','prepare_meeting_brief','suggest_task','classify_urgency','mark_possible_follow_up']){
    assert.match(server,new RegExp(`'${allowed}'`));
  }
  for(const risky of ['send_email','send_text','invite_attendee','book_meeting_with_attendee','delete_information','move_crm_stage','spend_money','publish_content','share_transcript','change_user_settings']){
    assert.match(server,new RegExp(`'${risky}'`));
  }
  for(const warning of ['scope_drift','unanswered_question','missed_buying_signal','relationship_tension','timeline_risk','budget_risk','promise_made','unclear_owner','similar_past_project_warning']){
    assert.match(server,new RegExp(`'${warning}'`));
  }
});

test('presence classifier routes external commands to confirmation required',()=>{
  assert.match(server,/function classifyPresenceIntent/);
  assert.match(server,/function presenceIntentAction/);
  assert.match(server,/requiresConfirmation=PRESENCE_MODE_CONTRACT\.confirmationRequired\.includes\(action\)/);
  assert.match(server,/intent='confirm_required'/);
  assert.match(server,/confirmationReason:requiresConfirmation\?'This command could affect someone else/);
  assert.match(server,/\bbook_meeting_with_attendee\b/);
  assert.match(server,/\bsend_email\b/);
});

test('presence sessions become evidence and use the observation pipeline',()=>{
  assert.match(server,/app\.post\('\/api\/presence\/session'/);
  assert.match(server,/presenceSessionPayload/);
  assert.match(server,/type:'voice_session'/);
  assert.match(server,/sourceType:'voice_session'/);
  assert.match(server,/processTranscriptPayload\(\{source:`presence_mode:\$\{session\.mode\}`/);
  assert.match(server,/saveMemoryItem\(\{kind:'voice_session'/);
  assert.match(server,/presence_session_saved/);
  assert.match(server,/if\(isBookEditorProject\(\)\)return res\.json\(\{ok:true,bookMode:true/);
});

test('presence chat asks before consequences and receives the contract prompt',()=>{
  assert.match(server,/presenceModeEnabledFromRequest/);
  assert.match(server,/presenceIntent\?\.requiresConfirmation/);
  assert.match(server,/I can prepare that, but I need your approval before anything external happens\./);
  assert.match(server,/presenceContractPrompt\(\)/);
  assert.match(server,/Meeting warnings must be short and calm/);
});
