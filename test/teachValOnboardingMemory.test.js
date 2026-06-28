'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');

test('Teach VAL commit promotes onboarding into core memory and evidence',()=>{
  assert.match(server,/async function promoteTeachValOnboardingToCoreMemory/);
  assert.match(server,/await saveMemoryItem\(\{/);
  assert.match(server,/kind:`teach_val_/);
  assert.match(server,/sourceType:'teach_val_onboarding'/);
  assert.match(server,/await saveEvidenceItem\(\{/);
  assert.match(server,/runObservationEngine\(evidence,\{candidates:teachValEvidenceCandidates\(included\),replace:true\}\)/);
  assert.match(server,/promotion=await promoteTeachValOnboardingToCoreMemory\(\{session,imports,items:included,payload\}\)/);
  assert.match(server,/res\.json\(\{ok:true,payload,webhook,promotion,memory/);
});

test('Teach VAL onboarding categories map into universal observation types',()=>{
  for(const type of ['relationship_signal','risk','preference','opportunity','need','idea']){
    assert.match(server,new RegExp(`'${type}'`));
  }
  assert.match(server,/function teachValObservationType/);
  assert.match(server,/function teachValEvidenceCandidates/);
  assert.match(server,/function teachValMemoryImportance/);
});
