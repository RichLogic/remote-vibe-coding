# Queued Follow-Up Turns

## Problem

The current coding flow assumes exactly one user prompt per active runtime turn.

Today:

- the web composer blocks submit while `activeTurnId` is present in `apps/web/src/app.tsx`
- `POST /api/coding/sessions/:sessionId/turns` in `apps/host/src/routes/coding-routes.ts` always tries to start a turn immediately
- `turn/completed` handling in `apps/host/src/app/codex-notification-handler.ts` only moves the session back to `idle` or `needs-approval`

There is no durable "next turn" concept. If the user thinks of a new requirement while Codex is still working, the host has nowhere to store it and nothing that will automatically continue after the current turn finishes.

## Goal

Add a message-append flow for coding sessions:

- while a coding turn is active, the user can submit another prompt
- the host stores that prompt as a queued follow-up turn
- when the current turn finishes normally, the host automatically starts the next queued turn
- queued turns survive page refresh

## Scope

Phase 1 scope:

- coding sessions only
- FIFO queue per coding session
- prompt plus attachment support
- automatic start only after a normal `turn/completed`
- queue inspection and cancel from the selected session view

Out of scope for phase 1:

- changing the currently running turn in place
- reordering queued turns
- editing a queued turn after enqueue
- auto-start after manual stop
- auto-start after `error` or `stale`
- chat conversation parity

Chat can reuse the same abstraction later, but it should not be bundled into the first cut because the current branch already has chat-specific work in progress.

## Current Constraints

### 1. Turn start is shared

`apps/host/src/app/turn-start-service.ts` already gives us the shared primitive we want:

- validate current record
- auto-restart a stale thread when needed
- call the runtime
- mark attachments consumed

The queued-turn feature should reuse that service instead of adding a second start path.

### 2. Coding session state is persisted in Mongo

`apps/host/src/coding/repository.ts` is the canonical persistence layer for coding sessions. A queued follow-up turn should be durable, so queue state should also live in Mongo, not only in browser state.

### 3. Attachments are still owned by the host store

Attachments are stored by `SessionStore` in `apps/host/src/store.ts`. A queued turn should reference attachment ids, not duplicate attachment payloads. The queue layer must prevent deletion of any attachment that is referenced by a queued turn.

## Proposed Design

## Data Model

Add a new Mongo collection owned by a small repository, for example `coding_queued_turns`.

Suggested record shape:

```ts
interface QueuedTurnRecord {
  id: string;
  sessionId: string;
  ownerUserId: string;
  prompt: string | null;
  attachmentIds: string[];
  status: 'queued' | 'starting';
  queuedAfterTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Suggested indexes:

- `{ sessionId: 1, status: 1, createdAt: 1 }`
- `{ sessionId: 1, createdAt: 1 }`
- `{ ownerUserId: 1, createdAt: -1 }`

Why a dedicated collection instead of embedding inside `coding_sessions`:

- atomic claim of the head item is easier
- queue operations stay isolated from normal session updates
- later chat reuse becomes straightforward by introducing a shared queued-turn repository or a second collection with the same contract

## API Contract

Keep the existing turn endpoint, but make it authoritative about busy sessions.

### `POST /api/coding/sessions/:sessionId/turns`

Behavior:

- if the session has no active turn and is ready, start immediately
- if the session has an active turn, enqueue instead of trying to start a second runtime turn
- if the session is `error` or `stale`, return `409`

Response shape:

```ts
type CreateCodingTurnResponse =
  | {
      status: 'started';
      turn: unknown;
      session: CodingSessionRecord;
      queuedTurns: QueuedTurnSummary[];
    }
  | {
      status: 'queued';
      queuedTurn: QueuedTurnSummary;
      session: CodingSessionRecord;
      queuedTurns: QueuedTurnSummary[];
    };
```

Use `200` for `started` and `202` for `queued`.

### `GET /api/coding/sessions/:sessionId`

Extend detail payload with queued turns:

```ts
interface QueuedTurnSummary {
  id: string;
  promptPreview: string;
  attachmentCount: number;
  createdAt: string;
}
```

Add:

```ts
queuedTurns: QueuedTurnSummary[];
```

to the coding session detail response.

### `DELETE /api/coding/sessions/:sessionId/queued-turns/:queuedTurnId`

Cancel a queued turn that has not started yet.

Behavior:

- only `queued` items can be removed
- `starting` items return `409`

This endpoint is important because queued turns otherwise become irreversible user input.

## Backend Flow

## 1. Enqueue path

In `apps/host/src/routes/coding-routes.ts`:

1. Validate prompt and attachments exactly as the current route does.
2. If `session.activeTurnId` is present:
   - create a queued turn record
   - return `202` with `status: 'queued'`
3. Otherwise:
   - call `startTurnWithAutoRestart`
   - return `200` with `status: 'started'`

Important change:

The backend should stop relying on the frontend-only submit guard. The route must be safe if a client submits while a turn is active.

## 2. Auto-drain path

Add a small service, for example `createQueuedTurnDrainService`, that is called from the runtime notification handler after a coding turn completes.

Recommended sequence:

1. `turn/completed` arrives
2. existing handler updates the session to `idle` or `needs-approval`
3. existing handler syncs transcript/history
4. if the next session state is `idle`, ask the drain service to start the head queued turn

Drain service behavior:

1. Acquire a per-session in-process lock
2. Reload the latest session from `CodingRepository`
3. Exit unless:
   - `activeTurnId === null`
   - `status === 'idle'`
   - queued turn exists
4. Atomically claim the oldest queued item by changing `status` from `queued` to `starting`
5. Resolve attachment records from `SessionStore`
6. Call the existing `startTurnWithAutoRestart`
7. On success:
   - delete the queued turn record
   - return
8. On failure:
   - move the queued turn back to `queued`
   - patch the session to `error`
   - add a live event describing the failed auto-start

The queue item must not be dropped on failure.

## 3. Attachment ownership

Queued turns should store only attachment ids.

Rules:

- an attachment referenced by any queued turn is not a draft attachment anymore
- delete-attachment routes must reject attachment ids that are referenced by queued turns
- when a queued turn is canceled, its attachments become draft attachments again
- when a queued turn actually starts, the existing attachment-consumption path marks them consumed

This avoids duplicating attachment metadata while still keeping the queue durable.

## State Rules

Queued follow-up turns only auto-start when all of these are true:

- session type is `code`
- session status is `idle`
- `activeTurnId` is `null`
- there are no pending approvals
- the session is not archived

They do not auto-start when:

- the user pressed stop
- the runtime reported `error`
- the host marked the session `stale`
- the turn is waiting on approval

This keeps the feature predictable and avoids surprising starts after an explicit interrupt.

## Frontend UX

`apps/web/src/app.tsx` should stop treating an active coding turn as a hard submit block.

Recommended UX:

- if the selected record is a coding session with an active turn, keep the composer enabled
- change the primary action label from "Send" to "Queue next turn"
- on `202`, clear the composer and refresh the selected session detail
- render queued turns under the composer or in the right-side detail stack
- each queued turn shows:
  - prompt preview
  - attachment count
  - enqueue time
  - cancel action

Do not introduce a new core session status just for this.

Instead, derive UI copy from:

- normal processing state from the active turn
- plus a queued-turn count in the detail view

## Failure Semantics

### Runtime restart while a turn is active

Current behavior already marks the session stale or interrupted. Keep queued turns untouched. The user should explicitly recover the session before any queued work continues.

### Auto-start fails after the current turn completed

- keep the queued item at the head of the queue
- set the session to `error`
- show a live event like `turn/queued-start-failed`

This preserves user input and makes failure visible.

### User stops the current turn manually

Do not auto-drain the queue. The stop action is an explicit interruption, so phase 1 should require the user to review and continue manually.

## Files To Touch

Backend:

- `apps/host/src/coding/repository.ts`
- `apps/host/src/routes/coding-routes.ts`
- `apps/host/src/app/codex-notification-handler.ts`
- `apps/host/src/server.ts`
- `apps/host/src/types.ts`

Frontend:

- `apps/web/src/coding/types.ts`
- `apps/web/src/coding/api.ts`
- `apps/web/src/types.ts`
- `apps/web/src/app.tsx`

Tests:

- `apps/host/src/routes/coding-routes.test.ts`
- new drain-service tests
- frontend submit/queue interaction tests if the project later adds them

## Rollout Order

1. Add queue repository and tests.
2. Make the coding turn route return `started` vs `queued`.
3. Add drain service and wire it into `turn/completed`.
4. Expose queued turns in coding session detail.
5. Update the web composer to queue while busy.
6. Add cancel queued turn support.

This order keeps the backend authoritative before the UI starts relying on the new behavior.
