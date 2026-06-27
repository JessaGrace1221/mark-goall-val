const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dashboard=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
const commandCenter=fs.readFileSync(path.join(root,'command-center.js'),'utf8');

test('calendarized tasks use a separate scheduling layer',()=>{
  assert.match(server,/create table if not exists val_task_calendar_blocks/);
  assert.match(server,/scheduled_start timestamptz/);
  assert.match(server,/calendar_event_id text/);
  assert.match(server,/unique \(tenant_id,user_id,task_id\)/);
  assert.match(server,/mergeTaskCalendarBlocks/);
});

test('task calendar blocks are private busy events without attendees or meeting links',()=>{
  assert.match(server,/transparency:'opaque'/);
  assert.match(server,/visibility:'private'/);
  assert.match(server,/attendees:\[\]/);
  assert.match(server,/showAs:'busy'/);
  assert.doesNotMatch(server,/conferenceDataVersion=1/);
});

test('calendarize is idempotent and completion keeps calendar evidence',()=>{
  assert.match(server,/if\(existing\?\.calendarEventId\)/);
  assert.match(server,/updateTaskBlock\(task/);
  assert.match(server,/createTaskBlock\(task/);
  assert.match(server,/DONE: \$\{raw\}/);
  assert.match(server,/app\.post\('\/api\/val\/tasks\/:id\/calendarize'/);
  assert.match(server,/app\.post\('\/api\/val\/tasks\/:id\/complete'/);
});

test('task UI exposes scheduling controls and status',()=>{
  assert.match(dashboard,/function taskScheduleLabel/);
  assert.match(dashboard,/Calendarize Tasks/);
  assert.match(dashboard,/calendarizeTask/);
  assert.match(dashboard,/Reschedule/);
  assert.match(dashboard,/Scheduled /);
});

test('task detail panel opens above workspace modal and shows transcript evidence',()=>{
  assert.match(dashboard,/id='taskDetailPanel'/);
  assert.match(dashboard,/z-index:3200/);
  assert.match(dashboard,/d\.sourceQuote/);
  assert.match(dashboard,/Transcript: /);
  assert.match(dashboard,/Source context/);
});

test('right-side action panels open above executive workspace overlays',()=>{
  assert.match(dashboard,/id='approvalQueuePanel'[\s\S]*?z-index:3200/);
  assert.match(dashboard,/id='docDetailPanel'[\s\S]*?z-index:3200/);
  assert.match(dashboard,/id='docDetailPanel'[\s\S]*?max-width:94vw/);
});

test('command center highlights open loops needing calendar time',()=>{
  assert.match(commandCenter,/Open Loops/);
  assert.match(commandCenter,/unscheduled/);
  assert.match(commandCenter,/scheduledToday/);
  assert.match(commandCenter,/Calendarize Tasks/);
});
