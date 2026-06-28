const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
const commandCenter=fs.readFileSync(path.join(root,'command-center.js'),'utf8');

test('executive briefing endpoint distills engine outputs without model reasoning',()=>{
  assert.match(server,/app\.get\('\/api\/executive-briefing'/);
  assert.match(server,/async function buildExecutiveBriefing/);
  assert.match(server,/listAgencyMoves/);
  assert.match(server,/listRelationshipProfiles/);
  assert.match(server,/executiveThemeFromMoves/);
  assert.match(server,/highestLeverageMove/);
  assert.match(server,/people/);
  assert.match(server,/momentum/);
  assert.match(server,/valNoticed/);
  assert.match(server,/quietlyHandled/);
  assert.match(server,/alsoImportant/);
  assert.match(server,/onboardingReflection/);
  assert.match(server,/readyForYou/);
  const start=server.indexOf('async function buildExecutiveBriefing');
  const end=server.indexOf('function executiveBriefingChatContext',start);
  const body=server.slice(start,end);
  assert.doesNotMatch(body,/callValModel|callOpenAIResponses/);
});

test('executive briefing preserves Michele book/editor separation',()=>{
  assert.match(server,/if\(isBookEditorProject\(\)\)return res\.json\(\{ok:true,bookMode:true/);
  assert.match(commandCenter,/if\(typeof isBookEditorMode==='function'&&isBookEditorMode\(\)\)return Promise\.resolve\(null\)/);
  assert.match(commandCenter,/executiveBriefingHtml\(bookMode\)/);
  assert.match(commandCenter,/if\(bookMode\)return ''/);
});

test('dashboard renders relationship-first executive briefing panel',()=>{
  assert.match(commandCenter,/var executiveBriefingState=/);
  assert.match(commandCenter,/function loadExecutiveBriefing/);
  assert.match(commandCenter,/\/api\/executive-briefing/);
  assert.match(commandCenter,/function executiveBriefingHtml/);
  assert.match(commandCenter,/People Create Velocity/);
  assert.match(commandCenter,/Highest Leverage Move/);
  assert.match(commandCenter,/Also Important/);
  assert.match(commandCenter,/Quietly Handled/);
  assert.match(commandCenter,/VAL Noticed/);
  assert.match(commandCenter,/readyForYou/);
  assert.match(dashboard,/\.executive-briefing-panel/);
  assert.match(dashboard,/\.eb-primary/);
});

test('executive briefing visibly reflects Teach VAL onboarding',()=>{
  assert.match(server,/function teachValOnboardingReflection/);
  assert.match(server,/listTeachValCoreMemory/);
  assert.match(server,/VAL learned \$\{memories\.length\} reviewed onboarding truth/);
  assert.match(server,/People now front of mind/);
  assert.match(server,/Projects now being watched/);
  assert.match(server,/Hold front and center/);
  assert.match(server,/Knowledge Increased/);
  assert.match(server,/Onboarding memory is active in VAL/);
  assert.match(commandCenter,/Array\.isArray\(b\.readyForYou\)/);
});

test('chat receives executive briefing source context for why questions',()=>{
  assert.match(server,/executiveBriefingChatContext/);
  assert.match(server,/Executive Briefing source context/);
  assert.match(server,/what VAL is worried about/);
  assert.match(server,/relationship velocity/);
});
