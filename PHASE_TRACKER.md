# Phase Tracker

This file tracks rollout progress for the secure video portal.

## Phase 1 - Core MVP (2-4 days)

Status: COMPLETE ✅

- [x] Project scaffold (Fastify, MySQL, SSR, Docker)
- [x] Login/logout with JWT cookie
- [x] Signup + admin signup toggle
- [x] Signup approval workflow (pending users, admin approve/reject)
- [x] Login blocks pending accounts; register link hidden when signup off
- [x] Role system (admin, viewer)
- [x] Admin create user (force password reset)
- [x] Admin upload MP4
- [x] FFmpeg HLS transcode job
- [x] Video list/watch pages
- [x] Signed short-lived playback URL/token
- [x] Publish/unpublish video
- [x] Basic audit logging
- [x] Run end-to-end test with real video file (8K MP4 uploaded and published successfully)
- [x] CSRF protection (cookie double-submit, timing-safe comparison, auto-injected on all forms)
- [x] FFmpeg timeout with SIGKILL (configurable via FFMPEG_TIMEOUT_MS)
- [x] Verify concurrency and bandwidth limits in your network

Exit criteria:

- [x] Users can log in and watch published videos.
- [x] Admin can upload and publish videos.
- [x] Public signup can be turned on/off.

## Phase 2 - Security Hardening (2-3 days)

Status: IN PROGRESS

- [x] One-session-per-user logic (max session setting)
- [x] Bind playback token to IP and User-Agent with strict checks
- [x] Basic viewer watermark overlay (email + timestamp)
- [x] Add lockout after repeated failed login attempts
- [x] Add anomaly alerts (multiple IP jumps / suspicious sharing)
- [x] Add admin force logout user feature
- [ ] Add backup restore test runbook

Exit criteria:

- [x] Leakage risk reduced with stronger anti-sharing controls.
- [ ] Backup and restore process tested.

## Phase 3 - Stability and UX (1-2 days)

Status: IN PROGRESS

- [x] Admin dashboard tabs (users, upload, video management)
- [x] Admin video edit/delete flow (title, description, thumbnail)
- [x] User video cards with thumbnails and description
- [x] Malaysia time display on user pages
- [x] Mark video as completed after playback
- [x] Upload/transcode retry queue
- [x] Better admin video filters and sorting
- [x] Monitoring dashboard (CPU, disk, bandwidth)
- [x] Upload progress panel auto-clears on completion and does not persist after logout/refresh
- [x] Watch video while still transcoding (early publish at 480p; higher profiles added to master.m3u8 progressively)
- [x] "Quality upgrading…" badge on video cards and notice bar on watch page while background renditions are still processing
- [x] Responsive layout for all screen sizes — 4-tier breakpoints (860/720/640/480px), hamburger nav, fluid container with clamp(), large external display breakpoint (1600px+), viewport-based background gradients
- [x] Unified auth screen redesign (login/signup/reset-password) with responsive single-panel layout
- [x] Mobile navigation reliability fixes (hamburger collapse/open behavior + viewport sync)
- [x] Admin UX polish for media management (drag-drop thumbnail replace with inline preview, aligned thumbnail removal controls)
- [x] Course assignment UX fixes (collapsible assign panels restored, search + pagination behavior corrected)
- [x] Watch progress autosave and resume from last position (POST /videos/:id/progress, 15 s interval, resumes on reload)
- [x] Token grace period (PLAYBACK_TOKEN_GRACE_SECONDS=30) to eliminate intermittent segment 403 errors
- [x] 30–50 concurrent user load test validated with k6 (full auth → token → HLS segment loop)
- [ ] Optional email notifications for alerts
- [ ] Add test coverage for auth and token routes

Exit criteria:

- [x] Stable upload/transcode flow with recovery.
- [x] Better operational visibility and smoother admin UX.

## Phase 4 - Product UI and NUC hosting (2026)

Status: COMPLETE

- [x] Digital Penang dual-theme logos (white-text dark / black-text light) in `src/public/brand/`
- [x] Monochrome cinematic dark + light themes with theme toggle (localStorage + prefers-color-scheme)
- [x] Streaming-style video grid with thumbnail overlays and badges
- [x] Player-first watch page with custom Plyr theme
- [x] Admin dashboard visual alignment (underline tabs, table polish, pending approvals UI)
- [x] Toast notifications (replace alert for CSRF form errors)
- [x] Total media disk monitoring (uploads + HLS + thumbnails) with disk % warning above 80%
- [x] NUC ~100 GB hosting notes (Dokploy bind mount, Cloudflare upload guidance) in README

Exit criteria:

- [x] Branded dark/light UI across auth, viewer, and admin surfaces.
- [x] Self-registration requires admin approval when signup is enabled.
- [x] Admin monitor shows full media storage breakdown.

## Deployment checklist

- [ ] Domain DNS points to server
- [ ] TLS certificate enabled (via Nginx Proxy Manager or Certbot)
- [ ] Nginx Proxy Manager configured as reverse proxy (replaces bundled nginx service)
- [ ] Firewall allows only 80/443 + restricted SSH
- [ ] .env production secrets rotated (DB credentials, JWT_SECRET)
- [ ] Nightly DB backup enabled
- [ ] Weekly media backup enabled
- [x] Dokploy: bind mount host media path (e.g. `/opt/video-stream/media` → `./media` in compose)
- [ ] Cloudflare: keep chunked upload for files >90 MB; set proxy timeout for large uploads (or use Tunnel)
- [ ] Plan 250–500 GB SSD on NUC for ~100 GB source library + HLS renditions (HLS adds ~1.5–3× source size)
