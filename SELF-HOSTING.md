# Self-hosting FIRST PRESS

The app uses Next.js standalone output and can run on a Node.js host or in Docker. No Vercel or Sites account is required. The current beta still stores user activity in the browser; deploying the server does not connect accounts or a shared database.

## Requirements

- Node.js 22.13 or newer (the container uses Node 22).
- pnpm 11.25.0, pinned in `package.json`.
- For the container option: Docker Engine and Compose.

## Local development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Development listens on `http://127.0.0.1:3000`. If Corepack is unavailable, install the pinned pnpm version through your normal Node.js tooling.

## Node.js production server

```sh
pnpm build
pnpm start
```

The start script copies public assets and Next.js static assets into `.next/standalone`, then starts the generated server. It binds to loopback by default. `PORT` changes the port; `FIRST_PRESS_HOST` explicitly changes the listening interface. Put a reverse proxy with HTTPS in front for a public deployment.

## Docker

```sh
docker compose up -d --build
docker compose logs -f app
```

Compose binds `127.0.0.1:3000` on the host. Configure the host’s HTTPS reverse proxy to forward your domain to that address. The multi-stage image runs as the unprivileged `node` user and includes a health check at `/api/health`. `docker compose down` stops the app.

The Docker build installs from the frozen pnpm lockfile. The Linux SWC packages are included in that lockfile. Images are currently served as original bundled assets with Next.js image optimization disabled, so the optional Sharp dependency is deliberately omitted.

## Verification in this workspace

- Next.js production build and TypeScript checks passed; `.next/standalone/server.js` was produced.
- pnpm frozen-lockfile installation passed from an integrity-checked offline cache.
- `docker compose config --quiet` passed.
- The environment denied localhost binding (`listen EPERM`). Docker CLI is installed, but its daemon was unavailable. A running HTTP server and container have therefore **not** been verified here.
- Browser tests used a standalone QA build of the same React components, with a small hash-navigation adapter. That artifact verifies the UI and local mechanics; it does not exercise Next.js HTTP routing or hydration.

On 2026-11-12, [hosted GitHub CI](https://github.com/ayadebbagh/first-press/actions/runs/43282396592) successfully built the Docker image and ran the actual production HTTP server. Health, root redirect/discovery, catalog, favicon and an invalid-route 404 passed. The local environment limits above remain; browser interactions against the HTTP server are a separate planned test (F02).

Before public beta access, connect authenticated accounts and a transactional database for the Credits ledger, settlements, receipts, listener snapshots and community votes. This migration does not make local demo records server-verified.

References: [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Docker’s Next.js guide](https://docs.docker.com/guides/nextjs/).
