# Phase 1 Architecture

## Product direction

`remote-vibe-coding` keeps the RemoteLab strengths that matter:

- Cloudflare-backed remote access
- real local executors on the owner machine
- concurrent sessions

It changes the product center of gravity:

- coding session first
- management surfaces second
- transcript fidelity first
- explicit permissions first

## Phase 1 decisions

- Executor: `Codex`
- Primary client: desktop web
- Mobile: deferred until after the browser contract is stable
- Default security profile: `repo-write`
- Default network state: disabled
- Network escalation: `once` or `session`
- `full-host`: available behind an explicit settings toggle
- Session binding: one primary workspace
- Workspace boundary: primary context root, not a hard sandbox
- Out-of-workspace reads/writes: explicit approval required
- Parallel sessions: preserved, but shown as lightweight navigation rather than a manager-first main surface

## Architecture layers

### 1. Agent Host

The host service runs on the owner machine and owns:

- executor lifecycle
- session metadata
- approval requests
- audit logging
- workspace policy
- transport to the browser client
- single-origin serving for the built web shell
- local Cloudflare tunnel orchestration

### 2. Browser Coding Surface

The browser is the main phase-1 client.

It should feel closer to `Codex` than to RemoteLab:

- transcript-first center pane
- session rail for switching context
- approvals as a first-class side surface
- diff/log/file context as support panels, not as the product center

### 2.5. Owner auth boundary

Phase 1 is still single-owner first.

- unauthenticated browser traffic should never land directly on the coding surface
- `/login` is the browser entrypoint for password auth
- long random token links remain a fallback for mobile/open-in-browser flows
- successful auth upgrades the browser into an owner cookie session

### 3. Permission boundary

There are two separate permission layers:

1. host boundary
2. executor-native approvals

The host boundary decides whether the running `Codex` session can access network, request `full-host`, or cross the primary workspace boundary.

Executor-native approvals should still be forwarded to the user instead of being silently auto-approved by the platform.

## UI shape

Phase 1 desktop web layout:

- left rail: sessions
- main pane: transcript, command stream, status events
- right rail: approvals, run metadata, and diff context

The active session remains the center of gravity. Session management should not dominate the screen.

## API shape

Phase 1 now exposes a minimal but real host contract:

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/cloudflare/status`
- `GET /api/sessions/:sessionId`
- `POST /api/cloudflare/connect`
- `POST /api/cloudflare/disconnect`
- `POST /api/sessions`
- `POST /api/sessions/:sessionId/turns`
- `POST /api/sessions/:sessionId/approvals/:approvalId`

The browser uses these routes to create sessions, start turns, read full thread history, respond to Codex approval requests, and manage the local Cloudflare tunnel.

## Cloudflare slice

The first remote-access slice is intentionally narrow:

- when the built web client exists, the host serves it directly from the same origin as the API
- the host can launch `cloudflared` quick tunnels without extra config
- if `~/.cloudflared/config.yml` already maps a hostname to the host port, phase 1 should prefer that named tunnel path and surface the stable hostname in the UI
- if `CLOUDFLARE_TUNNEL_TOKEN` is set, the host uses a managed tunnel instead
- if `CLOUDFLARE_PUBLIC_URL` is set, the browser shows the stable hostname instead of waiting for a quick-tunnel URL
- if the built web client does not exist, the tunnel manager can fall back to the local Vite dev server on `127.0.0.1:5173`
- public access should still be owner-gated by login or token; a tunnel is transport, not auth

## Codex integration choice

Phase 1 does not use `codex exec --json`.

It uses `codex app-server`, because:

- `codex exec` is non-interactive and does not expose the approval flow we need
- `app-server` exposes thread, turn, notification, and approval requests as a formal machine-readable protocol
- this keeps the browser contract closer to the real Codex interaction model

## What phase 1 does not do yet

- Flutter client
- Cloudflare Access auth or owner login flows
- hard sandboxing
- multi-executor abstraction
- rich diff/file browser beyond the shell contract
