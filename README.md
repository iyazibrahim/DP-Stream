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
# Host: install VAAPI drivers, then verify with vainfo

# .env
FFMPEG_HWACCEL=vaapi
FFMPEG_VAAPI_DEVICE=/dev/dri/renderD128

# Start with VAAPI override
docker compose -f docker-compose.yml -f docker-compose.ubuntu-vaapi.yml up --build -d
```

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

**Dokploy** — use the same `docker-compose.yml`; bind-mount host media e.g. `/opt/video-stream/media` → `./media`.

**Cloudflare** — admin UI chunks uploads above 90 MB; increase proxy timeouts for large files or use Cloudflare Tunnel.

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
