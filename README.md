# Mark GOALL VAL

VAL dashboard for Mark Bierman and the GOALL sales call-center workflow.

Primary purpose:
- show active GHL pipeline opportunities
- surface caller/contact context from GHL
- read recent GHL contact notes, including phone-call transcript notes
- help Mark understand each call, caller, potential client, risk, and next action quickly
- support GOALL lead intelligence and prospect research

Key endpoints:
- `GET /dashboard`
- `GET /api/pipeline`
- `GET /api/ghl/contacts/:id/notes`
- `POST /api/val/chat`
- `POST /api/val/intelligence`
- `POST /api/val/transcripts`

Important setup:
- `GHL_KEY`
- `GHL_LOC`
- `OPENAI_KEY`
- `DATABASE_URL`
- optional `GHL_CALENDAR_ID`
- optional `GHL_OPPORTUNITY_PIPELINE_ID`
- optional `GHL_OPPORTUNITY_STAGE_ID`
- optional `ROCKETREACH_API_KEY`
- optional `OUTSCRAPER_API_KEY`

The official GHL MCP server can cover much of the CRM context, but contact notes still use the GHL REST endpoint because contact notes are essential for the phone-call transcript workflow.
