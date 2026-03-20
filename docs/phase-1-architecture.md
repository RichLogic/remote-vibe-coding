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

### 2. Browser Coding Surface

The browser is the main phase-1 client.

It should feel closer to `Codex` than to RemoteLab:

- transcript-first center pane
- session rail for switching context
- approvals as a first-class side surface
- diff/log/file context as support panels, not as the product center

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

Phase 1 needs a minimal host contract:

- `GET /api/health`
- `GET /api/bootstrap`

`/api/bootstrap` should give the browser the current product defaults, a lightweight session list, sample transcript data, and approval cards.

## What phase 1 does not do yet

- real `Codex` process launch
- Flutter client
- hard sandboxing
- multi-executor abstraction
- rich diff/file browser beyond the shell contract
