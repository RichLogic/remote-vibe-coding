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

In development the Vite client proxies `/api` to the host, so the browser shell uses same-origin API calls.

## Cloudflare tunnel slice

Phase 1 now ships the first Cloudflare integration slice:

- the host can serve the built web client from the same origin as the API
- the browser can connect and disconnect a local `cloudflared` tunnel
- quick tunnels work out of the box when `cloudflared` is installed
- existing named tunnels in `~/.cloudflared/config.yml` are auto-detected when they already map a hostname to the local host port
- managed tunnels are supported through environment variables

## Owner auth

The public surface is now owner-gated by default.

- unauthenticated browser requests are redirected to `/login`
- password login sets an HTTP-only cookie
- `?token=...` links still work as a fallback and are cleaned back to `/` after the cookie is set
- credentials can come from environment variables or `~/.config/remote-vibe-coding/auth.json`

Supported environment overrides:

- `RVC_AUTH_USERNAME`
- `RVC_AUTH_PASSWORD`
- `RVC_AUTH_TOKEN`

Without environment overrides, the first startup generates a local owner auth record automatically:

```json
{
  "username": "owner",
  "passwordHash": "...generated and hashed locally...",
  "token": "...generated locally..."
}
```

For a single-origin remote build:

```bash
npm install
npm run build
npm run start:host
```

Then open `http://127.0.0.1:8787`, use the Cloudflare card in the browser shell, and connect the tunnel.

If the machine already has a named tunnel config like:

```yaml
ingress:
  - hostname: codex.example.com
    service: http://127.0.0.1:8787
```

the browser shell will surface that hostname as the stable public URL and prefer the named tunnel path over a quick tunnel.

Optional environment variables:

- `CLOUDFLARE_TUNNEL_TOKEN` — run a pre-created managed tunnel instead of a quick tunnel
- `CLOUDFLARE_PUBLIC_URL` — stable public URL to display in the UI when using a managed tunnel
- `CLOUDFLARE_TARGET_URL` — override the local target the tunnel should expose

## Current scope

This repo currently ships the phase-1 runtime foundation:

- a formal architecture/design document
- a host service that bridges into the real Codex app-server protocol
- a browser shell that can create sessions, send prompts, render thread history, and surface approval requests
- explicit stale-session handling after host/runtime restarts, with a restart action that creates a fresh Codex thread for the same workspace

It still does not ship Cloudflare Access auth, Flutter, or the full long-running orchestration model yet.
