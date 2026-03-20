# remote-vibe-coding

`remote-vibe-coding` is a browser-first remote coding surface for local coding agents.

The first shipped direction is intentionally narrow:

- `Codex` is the first and only executor in phase 1
- desktop web is the primary client
- the product is transcript-first instead of terminal-emulator-first
- the default security profile is `repo-write`
- network is disabled by default and can be escalated per action or per session
- `full-host` remains available, but only as an explicit high-trust setting

## Repo layout

- `apps/host` — local host service, session policy surface, and API
- `apps/web` — browser UI shell for the coding-first experience
- `docs/phase-1-architecture.md` — current product and technical blueprint

## Local development

```bash
npm install
npm run dev:host
npm run dev:web
```

Host defaults to `http://localhost:8787`.
Web defaults to `http://localhost:5173`.

## Current scope

This repo currently ships the phase-1 runtime foundation:

- a formal architecture/design document
- a host service that bridges into the real Codex app-server protocol
- a browser shell that can create sessions, send prompts, render thread history, and surface approval requests

It still does not ship Cloudflare access, Flutter, or the full long-running orchestration model yet.
