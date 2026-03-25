# remote-vibe-coding

[中文说明](./README.zh-CN.md)

`remote-vibe-coding` is a Codex-first browser shell for running local coding and chat workflows through a web UI.

The current repo ships a real, usable phase-1 runtime:

- desktop web client
- local host service backed by the real `codex app-server` protocol
- two product modes: `developer` and `chat`
- role-based access for `user`, `developer`, and `admin`
- transcript-first sessions with approvals, attachments, archive/restore, stop, restart, and fork actions
- managed workspaces under `~/Coding/<username>/...`
- optional Cloudflare tunnel orchestration from the UI

## What It Does

### Developer mode

- Create managed workspaces or clone a Git repository into a managed workspace
- Start Codex coding sessions bound to one primary workspace
- Send turns with prompt text and attachments
- Review transcript events, command output, file changes, and approval requests
- Restart stale sessions after runtime restarts
- Archive, restore, fork, rename, and delete sessions

### Chat mode

- Run a general assistant experience on top of Codex in a dedicated shared `chat` workspace
- Keep durable conversation history in MongoDB
- Upload images, PDFs, and text-like files as context
- Use admin-managed chat role presets
- Archive, restore, fork, stop, and delete conversations

### Permissions and trust model

- Executor: `Codex`
- Primary client: desktop web
- Default security profile: `repo-write`
- Network: disabled by default
- `full-host`: available only to users who are allowed to use it
- Approvals: surfaced to the browser instead of being silently auto-approved

## Architecture

- `apps/host`
  Local Fastify host, auth, session state, approval routing, Cloudflare orchestration, Mongo-backed repositories, and the bridge to `codex app-server`.
- `apps/web`
  React + Vite browser client for chat and developer flows.
- `apps/host/chat-system-prompt.json`
  Default system prompt used by chat mode.
- `apps/host/chat-role-presets.json`
  Bundled chat role presets that admins can manage from the UI.
- `docs/phase-1-architecture.md`
  Product and technical blueprint for the current phase.

## Requirements

You need the following on the machine running the host:

- Node.js with `npm`
- MongoDB reachable at `mongodb://127.0.0.1:27017/?directConnection=true` by default
- `codex` CLI, because the host starts `codex app-server`
- `cloudflared` only if you want built-in tunnel support

If `codex` is not on the default path, set `CODEX_BIN`.

## Local Development

Install dependencies:

```bash
npm install
```

Start MongoDB. Any local instance is fine. One simple option is:

```bash
docker run --name rvc-mongo -p 27017:27017 -d mongo:7
```

Set login credentials before first start. This is strongly recommended:

```bash
export RVC_AUTH_USERNAME=owner
export RVC_AUTH_PASSWORD='change-me'
```

Start the host and web client in separate terminals:

```bash
npm run dev:host
```

```bash
npm run dev:web
```

If the host is running on a non-default port, pass it when you start the web client:

```bash
npm run dev:web -- --api-port 8788
```

Open `http://127.0.0.1:5173`.

Development defaults:

- host: `http://127.0.0.1:8787`
- web: `http://127.0.0.1:5173`
- Vite proxies `/api` to the host
- `--api-port` overrides the default host port for the dev proxy

## Single-Origin Build

To serve the built web app from the host:

```bash
npm run build
npm run start:host
```

Then open `http://127.0.0.1:8787`.

## Authentication

The browser surface is owner-gated by default.

- Unauthenticated browser requests are redirected to `/login`
- Password login sets an HTTP-only cookie
- `?token=...` links still work as a fallback
- Users, roles, preferred mode, and tokens are managed by the host

Recommended setup:

- Set `RVC_AUTH_USERNAME` and `RVC_AUTH_PASSWORD` before the first run

If you start without those environment variables, the app creates an `owner` user automatically and writes auth state to `~/.config/remote-vibe-coding/auth.json`.

Important detail:

- the file stores a password hash, not the plaintext password
- the file does store the generated token

So if you skipped explicit credentials on first boot, use the token from `~/.config/remote-vibe-coding/auth.json` like this:

```text
http://127.0.0.1:8787/?token=YOUR_TOKEN
```

Then you can create or update users from the admin UI.

Development-only shortcut:

- set `RVC_DEV_DISABLE_AUTH=1` before `npm run dev:host`
- the host will skip browser login and treat requests as the seeded admin user
- keep this off outside local/dev preview usage

## Data and Storage

The project uses both local files and MongoDB.

- `~/.config/remote-vibe-coding/auth.json`
  Auth state and user records.
- `~/.config/remote-vibe-coding/sessions.json`
  Local persisted session state and backups.
- `~/Coding/<username>/...`
  Managed workspaces created by the app.
- MongoDB database `remote_vibe_coding`
  Durable chat history, coding sessions, and workspace records.

Attachments are written into the managed workspace so Codex can access them in-place.

Current attachment behavior:

- max upload size: `20 MB`
- supported kinds: image, PDF, generic file
- PDFs and text-like files are text-extracted when possible

## Configuration

### Core runtime

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST` | Host bind address | `127.0.0.1` |
| `PORT` | Host port | `8787` |
| `MONGODB_URL` | MongoDB connection string | `mongodb://127.0.0.1:27017/?directConnection=true` |
| `MONGODB_DB_NAME` | MongoDB database name | `remote_vibe_coding` |
| `CODEX_BIN` | Path to the Codex executable | platform default |

### Auth

| Variable | Purpose |
| --- | --- |
| `RVC_AUTH_USERNAME` | Seed username for the first admin user |
| `RVC_AUTH_PASSWORD` | Seed password for the first admin user |
| `RVC_AUTH_TOKEN` | Optional fixed token for the seeded user |
| `RVC_DEV_DISABLE_AUTH` | Dev-only auth bypass for browser requests when set to `1` |

### Cloudflare

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | Use a managed tunnel instead of a quick tunnel |
| `CLOUDFLARE_PUBLIC_URL` | Stable public URL to display in the UI |
| `CLOUDFLARE_TARGET_URL` | Override the local target exposed by the tunnel |

### Web

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | Optional API base URL when running the web app separately |

## Cloudflare Support

The current Cloudflare slice supports:

- quick tunnels through `cloudflared`
- named tunnels already defined in `~/.cloudflared/config.yml`
- managed tunnels via `CLOUDFLARE_TUNNEL_TOKEN`
- connect and disconnect actions directly from the browser UI

When a built web client exists, the host serves it from the same origin as the API. If the built client is missing, the tunnel logic can target the local Vite dev server instead.

## Current Scope

This repo is still intentionally narrow.

Included now:

- Codex-only execution
- desktop web only
- chat mode and developer mode in one browser shell
- transcript-first session UX
- explicit approval handling
- Cloudflare tunnel integration
- admin-managed users and chat role presets

Not shipped yet:

- mobile client
- multi-executor abstraction
- Cloudflare Access integration
- full long-running orchestration layer beyond the current host/runtime model
