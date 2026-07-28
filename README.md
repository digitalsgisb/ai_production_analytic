# Sugi Prod Analytic

Secure React chat frontend and Node gateway for Sugihara Grand Industries' production-analysis Langflow workflow.

## Included

- Responsive black and maroon React interface using the official company wordmark.
- Installable PWA with a branded `>_<` app icon and offline application shell.
- Named local accounts, forced first-password changes, administrator user management, and Argon2id password hashing.
- Persistent, per-user PostgreSQL conversations and administrative audit records.
- Langflow v2 background execution with AG-UI events, resumable SSE, streamed answers, sanitized progress steps, and cancellation.
- A local Langflow simulator for frontend testing on a Windows PC.
- Hardened Docker image, private data networks, loopback-only tunnel access, health checks, log rotation, backups, and GitHub Actions validation.

The browser never receives the Langflow URL or API key. The application does not expose prompts, SQL, tool arguments, tool results, credentials, or raw database payloads in its progress display or normal logs.

## Repository layout

| Path | Purpose |
| --- | --- |
| `client/` | React, TypeScript, chat UI, and PWA registration |
| `server/` | Express API, authentication, conversations, and Langflow gateway |
| `db/` | PostgreSQL migration and least-privilege role provisioning |
| `public/` | Company wordmark, app icons, manifest, and service worker |
| `scripts/` | Local setup, Atom provisioning, backups, and icon generation |
| `compose.yaml` | Production Atom stack |
| `compose.local.yaml` | Optional local Docker stack |

## Test on Windows

Requirements: Node.js 24, npm, and PostgreSQL. Open PowerShell in the repository directory:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.scripts\setup-local.ps1
npm.cmd install
npm.cmd run db:migrate
npm.cmd run admin:create
npm.cmd run dev
```

Open `http://localhost:5173` and sign in with the administrator account created by `admin:create`. The first login requires a password change.

Local answers identify themselves as preview responses because `.env` uses `LANGFLOW_MOCK=true`. Authentication, history, streaming, cancellation, and the frontend use the production code paths.

If PostgreSQL is installed elsewhere:

```powershell
.scripts\setup-local.ps1 -PsqlPath "D:\PostgreSQL\bin\psql.exe"
```

If the local PostgreSQL administrator password has been forgotten, run PowerShell as Administrator:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.scripts\reset-postgres-admin.ps1
```

### Optional local Docker test

```powershell
docker compose -f compose.local.yaml up -d --build
docker compose -f compose.local.yaml exec app node dist/server/cli/create-admin.js
```

Then open `http://localhost:3000`.

## Validate a change

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

GitHub Actions repeats these checks and builds the Docker image on pushes and pull requests.

## Deploy on the GIGABYTE AI TOP ATOM

The production stack is designed to live at `/srv/apps/sugi-prod-analytic`. The app connects privately to the existing PostgreSQL and Langflow Docker networks. Its HTTP port is published only on Atom loopback as `127.0.0.1:3000`, allowing the Atom's existing `cloudflared` system service to reach it without exposing the port to the LAN or internet.

### 1. Atom prerequisites

Install or confirm:

- Ubuntu on the Atom.
- Git, Docker Engine, and the Docker Compose plugin.
- An existing PostgreSQL container and database.
- An existing Langflow container and working flow.
- A company hostname managed in Cloudflare.
- The existing remotely managed `AI Supercomputer` Cloudflare Tunnel running as an Atom system service.

Confirm Docker is healthy:

```bash
docker version
docker compose version
docker ps
```

### 2. Gather the existing service information

Run these commands on the Atom:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Networks}}'
docker network ls
docker inspect YOUR_POSTGRES_CONTAINER --format '{{json .NetworkSettings.Networks}}'
docker inspect YOUR_LANGFLOW_CONTAINER --format '{{json .NetworkSettings.Networks}}'
```

Record:

- PostgreSQL container name, Docker network, database name, and administrator role.
- PostgreSQL hostname or network alias reachable from another container.
- Langflow container/service hostname and Docker network.
- Langflow internal base URL, normally `http://LANGFLOW_SERVICE:7860`.
- Langflow flow ID or endpoint name.

In the existing Langflow deployment, set:

```text
LANGFLOW_DEVELOPER_API_ENABLED=true
```

Recreate or restart Langflow using its own deployment procedure. Confirm the flow accepts `input_value` and `session_id`, returns one primary Chat Output response, and has model streaming enabled where supported. The production database account used by the flow must be read-only.

### 3. Clone from GitHub

```bash
sudo mkdir -p /srv/apps
sudo chown "$USER":"$USER" /srv/apps
git clone https://github.com/digitalsgisb/ai_production_analytic.git /srv/apps/sugi-prod-analytic
cd /srv/apps/sugi-prod-analytic
cp .env.example .env
chmod 600 .env
```

For a private repository, configure an SSH deploy key or authenticate Git before cloning. Do not place a GitHub token in this repository or its `.env` file.

### 4. Change these `.env` values

Generate a URL-safe database password on the Atom and keep it private:

```bash
openssl rand -hex 32
nano .env
```

| Variable | Required production value |
| --- | --- |
| `PUBLIC_ORIGIN` | Final HTTPS address, for example `https://analytic.company.example` |
| `ASSISTANT_DB_PASSWORD` | Newly generated hex password |
| `DATABASE_URL` | `postgresql://assistant_app:SAME_PASSWORD@POSTGRES_HOST:5432/POSTGRES_DB` |
| `POSTGRES_ADMIN_USER` | Existing PostgreSQL administrator role used only by the provisioning script |
| `POSTGRES_DB` | Existing database that will contain the isolated `assistant` schema |
| `PRODUCTION_POSTGRES_CONTAINER` | Exact existing PostgreSQL container name |
| `POSTGRES_NETWORK` | Exact external Docker network containing PostgreSQL |
| `LANGFLOW_BASE_URL` | Private URL such as `http://langflow:7860`—never the public address |
| `LANGFLOW_FLOW_ID` | Flow ID or endpoint name from Langflow API Access |
| `LANGFLOW_API_KEY` | Langflow key created for this app; store only in Atom `.env` |
| `LANGFLOW_NETWORK` | Exact external Docker network containing Langflow |

Keep these production defaults:

```text
NODE_ENV=production
PORT=3000
LANGFLOW_MOCK=false
SESSION_TTL_HOURS=24
LANGFLOW_TIMEOUT_MS=600000
```

Important distinctions:

- `PRODUCTION_POSTGRES_CONTAINER` is used by `docker exec` during provisioning and backups.
- The hostname inside `DATABASE_URL` must resolve on `POSTGRES_NETWORK`; it may be different from the container name.
- `LANGFLOW_BASE_URL` must use the hostname or alias visible on `LANGFLOW_NETWORK`.
- Use the same generated password in `ASSISTANT_DB_PASSWORD` and `DATABASE_URL`.
- Never commit `.env`, the Langflow key, tunnel token, database password, or a real flow export containing credentials.

### 5. Provision the isolated database access

```bash
chmod 750 scripts/*.sh
./scripts/provision-database.sh
```

This creates or updates only the `assistant_app` role and `assistant` schema. It does not grant write access to production tables used by the Langflow analysis flow.

### 6. Configure the existing Cloudflare Tunnel

The Atom already runs the `AI Supercomputer` tunnel as `cloudflared.service`; this application does not run a second tunnel container and does not need a tunnel token in its `.env`.

In the Cloudflare dashboard, open that tunnel and add or edit its published application route:

1. Set the hostname to `prod-analytic.sugidigital.org`.
2. Set the service type to `HTTP`.
3. Set the service URL to `http://localhost:3000`.
4. Leave the path empty and save the route.

No router port-forwarding is required. Confirm the existing connector with `systemctl is-active cloudflared`.

### 7. Build and start

```bash
docker compose config --quiet
docker compose build --pull app
docker compose up -d
docker compose ps
```

Create the first administrator interactively:

```bash
docker compose exec app node dist/server/cli/create-admin.js
```

Verify readiness:

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:3000/health/ready').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
docker compose logs --tail=50 app
```

Then open `PUBLIC_ORIGIN`, sign in, change the temporary administrator password, and run one real production question. Compare its final answer with the same question in Langflow Playground.

The PWA install option appears through the HTTPS Cloudflare hostname. The offline cache contains only the static application shell and branding; login, conversations, Langflow, and production data always require the private backend.

## Deploy later GitHub updates

Back up first, then pull and rebuild:

```bash
cd /srv/apps/sugi-prod-analytic
./scripts/backup-assistant.sh
git pull --ff-only origin main
docker compose build --pull app
docker compose up -d
docker compose ps
```

Database migrations run automatically with an advisory lock before the server accepts traffic.

## Backups

Create an assistant-schema backup:

```bash
cd /srv/apps/sugi-prod-analytic
./scripts/backup-assistant.sh
```

The default local retention is 14 days. Schedule the command daily with cron or a systemd timer and copy backups to the existing NAS or another off-machine destination.

## Common Atom problems

| Symptom | Check |
| --- | --- |
| `network ... declared as external, but could not be found` | Correct `POSTGRES_NETWORK` or `LANGFLOW_NETWORK` using `docker network ls` |
| PostgreSQL `ENOTFOUND` or connection refused | Correct the hostname in `DATABASE_URL` and confirm the app is attached to the PostgreSQL network |
| Langflow `ENOTFOUND` or timeout | Correct `LANGFLOW_BASE_URL` and confirm both containers share `LANGFLOW_NETWORK` |
| Langflow returns `401` or `403` | Check the Atom-only API key and `LANGFLOW_DEVELOPER_API_ENABLED=true` |
| Cloudflare shows `502` | Confirm the dashboard service is `http://localhost:3000`, `cloudflared.service` is active, and `curl http://127.0.0.1:3000/health/ready` succeeds on the Atom |
| Login is unavailable | Run the interactive `admin:create` command and check the app readiness health check |

## Security notes

- Public registration is disabled.
- Secure session cookies require the correct HTTPS `PUBLIC_ORIGIN`.
- PostgreSQL and Langflow have no public host ports. The app is bound only to `127.0.0.1:3000` for the existing host-level Cloudflare Tunnel.
- Questions, answers, credentials, raw Langflow events, SQL, and tool payloads are not logged by default.
- Conversations remain until their owner deletes them.

## Reference documentation

- [Langflow Workflow API](https://docs.langflow.org/workflow-api)
- [Cloudflare Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/)
- [Cloudflare tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
