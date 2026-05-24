# dokploy-bridge

A small, restricted TypeScript + Effect bridge between Hermes and Dokploy.

Target Dokploy instance default: `https://dok.saphi.dev`.

## Why this exists

Dokploy's API can do powerful things: create apps, redeploy, stop/start, update configuration, delete services, edit Traefik, etc.

Hermes should not receive a full-power Dokploy token directly. This bridge exposes only a tiny allowlisted API.

## Safe defaults

Allowed by default:

- `GET /health`
- `GET /projects`
- `GET /deployments`
- `GET /apps/:id` for allowlisted app IDs
- `POST /apps/:id/redeploy` for allowlisted app IDs

Disabled by default:

- create apps
- start/stop apps
- delete anything
- update app config
- edit env vars/secrets
- edit domains/Traefik
- access Docker/SSH keys/git providers

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Generate a bridge token:

```bash
openssl rand -base64 32
```

Edit `.env`:

```env
DOKPLOY_URL=https://dok.saphi.dev
DOKPLOY_API_KEY=your-limited-dokploy-api-key
BRIDGE_TOKEN=long-random-secret
ALLOWED_APP_IDS=app_id_1,app_id_2
ALLOW_REDEPLOY=true
ALLOW_CREATE=false
ALLOW_START_STOP=false
```

## API

All requests need:

```http
Authorization: Bearer <BRIDGE_TOKEN>
```

Examples:

```bash
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:8787/health
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:8787/apps/app_id_1
curl -X POST -H "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:8787/apps/app_id_1/redeploy
```

Create app is off by default. To enable it:

```env
ALLOW_CREATE=true
ALLOWED_ENVIRONMENT_ID=your_hermes_managed_environment_id
```

Then:

```bash
curl -X POST http://localhost:8787/apps \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"hermes-demo"}'
```

## Deploy

```bash
npm run build
npm start
```

## Important security note

Use a dedicated Dokploy user/API key with minimal permissions:

- `canAccessToAPI: true`
- `canCreateServices: true` only if you want Hermes to create apps
- `canDeleteServices: false`
- `canDeleteProjects: false`
- `canAccessToDocker: false`
- `canAccessToTraefikFiles: false`
- `canAccessToSSHKeys: false`
- `canAccessToGitProviders: false`

The bridge also blocks dangerous routes in code.
