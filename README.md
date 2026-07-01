# Secure Video Portal

Internal and external video streaming platform built for **Digital Penang** — login-gated HLS playback, admin uploads, course management, and NUC-friendly Docker deployment.

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![MySQL](https://img.shields.io/badge/MySQL-8-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [NUC storage planning](#nuc-storage-planning)
- [Documentation](#documentation)

---

## Features

| Area | Capabilities |
|------|----------------|
| **Auth** | Email/password login, JWT session cookie, admin-only or approval-gated signup |
| **Roles** | `admin` and `viewer`; admin creates users or approves pending registrations |
| **Video** | MP4 upload, FFmpeg HLS transcode (480p → 720p → 1080p), early publish at 480p |
| **Playback** | Signed short-lived tokens, IP/UA binding, viewer watermark, resume progress |
| **Admin** | User management, video CRUD, courses, monitoring dashboard, anomaly alerts |
| **UI** | Dark/light theme, Digital Penang branding, responsive streaming-style grid |

---

## Tech stack

- **Runtime** — Node.js 22, Fastify 5, EJS (SSR)
- **Database** — MySQL 8
- **Media** — FFmpeg (software or Intel VAAPI), HLS segments
- **Deploy** — Docker Compose, Nginx Proxy Manager / Cloudflare, Dokploy-compatible

---

## Project structure

```
.
├── src/
│   ├── server.js           # App entry
│   ├── routes/             # HTTP routes (auth, videos, admin, pages)
│   ├── services/           # Business logic (auth, video, settings)
│   ├── plugins/            # Fastify plugins (auth, CSRF, DB)
│   ├── views/              # EJS templates
│   └── public/             # Static CSS, brand assets
├── migrations/             # SQL schema migrations
├── media/                  # Uploads + HLS output (gitignored contents)
├── docker/                 # Sample nginx config
├── load-tests/             # k6 streaming load test
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── ARCHITECTURE.md
└── PHASE_TRACKER.md
```

---

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose **or**
- Node.js 22+, MySQL 8, FFmpeg on the host

### Docker (recommended)

```bash
# 1. Clone and configure
git clone <your-repo-url>
cd video-stream
cp .env.example .env   # Windows: copy .env.example .env

# 2. Edit .env — set JWT_SECRET, DB_PASSWORD, and other secrets

# 3. Start stack
docker compose up --build -d

# 4. Seed first admin
docker compose exec app npm run db:seed-admin -- admin@company.com StrongPass123!

# 5. Open the app
# http://localhost:3000
```

For **local HTTP** testing, set `COOKIE_SECURE=false` in `.env`.  
For **HTTPS** production, use `COOKIE_SECURE=true` (or `auto`) with an `https://` `APP_URL`.

### Intel Quick Sync (NUC / VAAPI)

```bash
# On the NUC host — confirm GPU is visible (expect card0 + renderD128, NOT card1)
ls -la /dev/dri/
vainfo

# .env
FFMPEG_HWACCEL=vaapi
FFMPEG_VAAPI_DEVICE=/dev/dri/renderD128
LIBVA_DRIVER_NAME=iHD

# Start with VAAPI override (mounts renderD128 only — no card1)
docker compose -f docker-compose.yml -f docker-compose.ubuntu-vaapi.yml up --build -d
```

> **Why the Dokploy error?** The old compose mounted `/dev/dri/card1`, which many NUCs do not have. Only `renderD128` is required for hardware transcode.

### Local development (no Docker)

```bash
cp .env.example .env
npm install
# Run all migrations in migrations/ against your MySQL instance
npm run dev
npm run db:seed-admin -- admin@company.com StrongPass123!
```

---

## Configuration

Key environment variables (see [`.env.example`](.env.example) for the full list):

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Signing key for auth & playback tokens | *(required)* |
| `DB_HOST` / `DB_PORT` | MySQL connection | `db` / `3306` |
| `ALLOW_SIGNUP_DEFAULT` | Public registration on first boot | `false` |
| `MAX_ACTIVE_SESSIONS` | Concurrent sessions per user | `1` |
| `ENABLE_1080P` | Transcode third HLS profile | `false` |
| `FFMPEG_HWACCEL` | `none` or `vaapi` | `none` |
| `PLAYBACK_TOKEN_TTL_SECONDS` | HLS token lifetime | `1200` |
| `PLAYBACK_TOKEN_GRACE_SECONDS` | Grace window near expiry | `30` |

---

## Deployment

Typical production topology:

```
Internet → Nginx Proxy Manager (TLS) → Fastify :3000 → MySQL
                                      ↘ media/ (bind mount)
```

**Checklist**

- [ ] DNS and TLS certificate
- [ ] Reverse proxy on ports 80/443 only; restrict SSH
- [ ] Rotate `JWT_SECRET` and DB credentials
- [ ] Nightly database backup, weekly `media/` backup
- [ ] Firewall: no public exposure of MySQL or app port

**Dokploy on your NUC (with Intel Quick Sync)**

If Dokploy runs **on the NUC itself**, VAAPI works — but do **not** mount `/dev/dri/card1`. Most Intel NUCs only have `card0` and `renderD128`. FFmpeg needs **`renderD128` only**.

### Dokploy domain / 404 fix (ports)

Traefik talks to the **container internal port**, not the host port you map for direct access.

| Setting | Correct value | Wrong (causes 404/502) |
|---------|---------------|-------------------------|
| `.env` → `PORT` | `3000` | `3010` unless app really listens on 3010 |
| Dokploy **container / domain port** | `3000` | `80`, `3010` |
| Compose `ports` (if host 3000 is busy) | `3010:3000` | `3010:3010` without `PORT=3010` |
| Traefik `loadbalancer.server.port` label | `3000` or remove labels (let Dokploy set domain) | `80` |

**Recommended `.env` on Dokploy:**

```env
PORT=3000
APP_HOST_PORT=3010
APP_URL=https://stream.iyazbrhm.cloud
COOKIE_SECURE=auto
DB_HOST=db
```

**Compose `app` ports** (only if something else uses host 3000):

```yaml
ports:
  - "3010:3000"   # host:container — Traefik still uses 3000 inside the network
```

**Remove** manual Traefik labels from compose if you already configure the domain in the Dokploy UI — duplicate routers often return **404**.

**Verify after deploy:**

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(console.log)"
curl -I https://stream.iyazbrhm.cloud/health
```

On the NUC host, verify GPU:

```bash
ls -la /dev/dri/
# Typical: card0  renderD128
vainfo   # should list H264 profiles
```

In Dokploy compose, under `app`, add **only**:

```yaml
devices:
  - /dev/dri/renderD128:/dev/dri/renderD128
group_add:
  - "44"    # video group on Ubuntu — run: getent group video
  - "110"   # render group on Ubuntu — run: getent group render
```

In `.env`:

```env
FFMPEG_HWACCEL=vaapi
FFMPEG_VAAPI_DEVICE=/dev/dri/renderD128
LIBVA_DRIVER_NAME=iHD
ENABLE_1080P=true
```

If `renderD128` is missing, check `ls /dev/dri/` — some boards use `renderD129`. Update both the compose device line and `FFMPEG_VAAPI_DEVICE` to match.

**Dokploy on a cloud VPS (no GPU)** — omit all `devices:` / `group_add:` and use `FFMPEG_HWACCEL=none`.

**Cloudflare** — admin UI chunks uploads above 90 MB; increase proxy timeouts for large files or use Cloudflare Tunnel.

### MySQL `Access denied for user 'video_app'@'…'`

The app **reaches** MySQL, but the password in `.env` does not match what was stored when the `db_data` volume was first created. MySQL only applies `MYSQL_USER` / `MYSQL_PASSWORD` on **first** volume init — changing Dokploy env later does not update existing users.

**Option A — sync password (keep data)** — SSH to the NUC, in the project directory:

```bash
sh scripts/sync-mysql-user.sh
docker compose restart app
```

Or manually (replace values from your Dokploy `.env`):

```bash
docker compose exec -T db mysql -uroot -p"YOUR_MYSQL_ROOT_PASSWORD" -e "
CREATE DATABASE IF NOT EXISTS video_portal;
CREATE USER IF NOT EXISTS 'video_app'@'%' IDENTIFIED BY 'YOUR_DB_PASSWORD';
ALTER USER 'video_app'@'%' IDENTIFIED BY 'YOUR_DB_PASSWORD';
GRANT ALL PRIVILEGES ON video_portal.* TO 'video_app'@'%';
FLUSH PRIVILEGES;"
docker compose restart app
```

If root login fails, `MYSQL_ROOT_PASSWORD` in `.env` also does not match the volume — use Option B.

**Option B — fresh database (no data to keep)**

```bash
docker compose down
docker volume ls | grep db_data    # note exact volume name, e.g. myproject_db_data
docker volume rm <project>_db_data
docker compose up -d --build
docker compose exec app npm run db:seed-admin -- admin@email.com Password123
```

**Ensure Dokploy env matches** — same `DB_PASSWORD` for both `app` and `db` service (compose passes `${DB_PASSWORD}` to MySQL init on new volumes):

```env
DB_HOST=db
DB_USER=video_app
DB_PASSWORD=video_app_password
DB_NAME=video_portal
MYSQL_ROOT_PASSWORD=root_password_change_me
```

---

## NUC storage planning

| Component | Rough size |
|-----------|------------|
| Source uploads | 40–100 GB target library |
| HLS renditions | ~1.5–3× source (with 1080p enabled) |
| OS + Docker + MySQL | Reserve 20–30 GB |

**Recommendation:** 250–500 GB SSD on a NUC for comfortable headroom.

Admin **Monitoring** tab reports uploads, HLS, thumbnails, and disk usage (warns above 80%).

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, playback flow, security model |
| [PHASE_TRACKER.md](PHASE_TRACKER.md) | Feature rollout status and deployment checklist |

**Load testing** — `load-tests/k6-streaming.js` (30–50 concurrent viewers validated on NUC hardware).

---

## License

Private / internal use — Digital Penang. All rights reserved unless otherwise specified.
