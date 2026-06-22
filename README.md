# Mark GOALL VAL

VAL dashboard for Mark Bierman and the GOALL sales call-center workflow.

Primary purpose:
- show active GHL pipeline opportunities
- surface caller/contact context from GHL
- read recent GHL contact notes, including phone-call transcript notes
- help Mark understand each call, caller, potential client, risk, and next action quickly
- support GOALL lead intelligence and prospect research
- run independent employer and strategic-partner prospecting workflows

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
- optional `GHL_PARTNER_PIPELINE_ID` (otherwise exact name `GOALL Strategic Partners` is used)
- optional `GHL_PARTNER_STAGE_ID` (otherwise exact name `New Limitless Lead Added` is used)

Strategic partner custom fields are discovered by name when present in GHL. Supported fields include Partner Type, Organization Size, Potential Reach, Partnership Fit Score, Reason For Score, Recommended Outreach Angle, Source URLs, and Date Added. Matching `GHL_FIELD_*` variables can be used to pin exact custom-field IDs.

GHL MCP architecture:
- GHL access is centralized in `services/ghlMcpService.js`.
- The server creates one shared `ghlMcp` service instance and all legacy `ghl`, `ghlStrict`, and `ghlTry` helpers route through it.
- The shared service resolves the active user's saved GHL API key, Location ID, and MCP URL credential at call time, with env vars only as fallback.
- Platform-wide VAL context is built through `ghlPlatformContext`, which pulls contacts, opportunities, tasks, notes, and conversations for chat, dashboard intelligence, relationship review, meeting prep, email context, and lead scraping.
- Contact notes still use GHL endpoints underneath the shared service because transcript/call-note history is critical CRM context.

Manual verification:
- `GET /api/debug/ghl-mcp-context?q=<contact or company>` should return `configured: true`, the active `locationId`, counts for contacts/opportunities/tasks/notes/conversations, and a `textPreview`.
- `POST /api/val/chat` with a GHL-related question should return `ghlContextAvailable: true` when GHL credentials are configured.
- `POST /api/val/intelligence` for actions such as `daily_command`, `task_intelligence`, `relationship_radar`, `auto_followups`, or `pre_meeting_brief` should return `ghlContextAvailable: true`.
- `POST /api/val/meeting-briefing` should include a `ghlContext` array in the response when related GHL data is available.
- Lead preview/import routes should continue to work because they still use the same `ghl`/`ghlStrict` surface, now backed by the shared service.
