# JARVIS Independent Agent — V114

A browser-based JARVIS command centre with a real server-side agent runtime. The stable dashboard design is preserved; V114 focuses on polishing the UI and turning the Agent panel into an executable, approval-gated agent.

## What V114 adds

### Independent agent runtime
- Mission planning and execution through `/api/agent/run`.
- Optional model-provider planning through an OpenAI-compatible `chat/completions` endpoint.
- Deterministic fallback planner when no model provider is configured.
- Safe local actions can run automatically.
- External actions pause for approval before they can send or publish anything.
- Persistent missions, tasks, notes, memory, approvals, activity and schedules.
- Agent state is stored server-side in `server/data/agent-state.json` and is ignored by Git.

### Agent tools
- Web research adapter
- Weather adapter
- Persistent notes / memory
- Persistent task creation
- Gmail sending through the existing OAuth connection
- WhatsApp Business sending through the existing Cloud API connection
- Canva design creation through the existing OAuth connection

### Frontend polish
- Cleaner card hierarchy and controls
- Better focus/hover states
- More consistent HUD spacing and typography
- Agent panel now runs missions instead of only displaying a mock plan
- Live mission status polling
- Approval buttons are connected to the real backend approval queue
- Existing JARVIS reactor/UI remains intact

## Architecture

```text
Browser
  │
  ▼
JARVIS Dashboard
  │
  ▼
Node / Express Agent Runtime
  ├── Planner
  ├── Tool Executor
  ├── Persistent Memory
  ├── Task Queue
  ├── Approval Gate
  └── Integrations
       ├── Gmail
       ├── Canva
       └── WhatsApp Business
```

The agent is deliberately **approval-gated** for external side effects. It can research, create local notes/tasks and build a mission automatically, but sending messages or changing an external service requires an explicit approval request.

## Model provider

The runtime is provider-neutral. Set these on the backend host if you want model-driven planning:

```env
AI_BASE_URL=https://your-compatible-provider.example/v1
AI_API_KEY=your-secret-key
AI_MODEL=your-model
```

The model receives a constrained planning prompt and is only allowed to return the tool names defined by JARVIS. If these variables are missing, JARVIS still works using its deterministic planner.

**Never put `AI_API_KEY` in the HTML or commit it to GitHub.**

## Run locally

1. Install a current Node.js release.
2. Copy `server/.env.example` to `server/.env`.
3. Add only the integrations you actually want.
4. From the repository root:

```bash
npm start
```

5. Open the local JARVIS URL shown by the server.

## GitHub deployment

GitHub is suitable for the source repository. Do not put secrets in the repository.

For a complete deployment:

- Host the repository/backend on a Node-capable host.
- Set the environment variables in that host's secret/environment settings.
- Point `PUBLIC_ORIGIN` at the production URL.
- Register the production OAuth callback URLs with Google and Canva.
- Keep `server/data/agent-state.json` out of Git; it is already covered by `.gitignore`.

GitHub Pages alone can host the static HTML, but it cannot run the Node agent backend or securely hold OAuth/API secrets.

## Main API

- `GET /api/health` — runtime health
- `GET /api/agent/state` — complete agent state
- `GET /api/agent/memory` — memory and notes
- `POST /api/agent/memory` — add memory
- `POST /api/agent/plan` — create a mission plan
- `POST /api/agent/run` — run a mission
- `POST /api/agent/approve` — approve/deny an external action
- `GET /api/tasks` / `POST /api/tasks` — task queue
- `GET /api/schedules` / `POST /api/schedules` — scheduled mission records
- `GET /api/web/search` — web-search adapter
- `GET /api/weather` — weather adapter

Existing integration routes remain available for Gmail, Canva and WhatsApp Business.

## Security notes

- Secrets stay server-side.
- External actions are approval-gated.
- Browser camera/location features still require browser permission.
- The agent does not get unrestricted access to the user's computer simply because the project is on GitHub; computer-level actions require a separate integration/runtime.
