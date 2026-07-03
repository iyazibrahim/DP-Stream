# Workflow

## LMS expansion (2026-07-03)

### Completed
- UI foundation: icon buttons, compact theme toggle, `styles-lms.css`, `viewer.js`, scrollable admin tabs
- Admin dashboard split into tab partials under `src/views/admin/partials/`
- Learning library at `/learn` with segmented filters and mobile-first grids
- Polymorphic content model: migration `008_learning_content.sql`, `learning_items`, `course_items`, `item_progress`
- `learningItemService.js`, `optionalAuth`, public/authenticated access
- Admin upload for documents, free videos, external YouTube/Vimeo links
- Polymorphic viewer: HLS redirect for premium, MP4, PDF iframe, external embed
- Course playlists use mixed `course_items`

### Validation
- Run `npm run db:migrate` after deploy
- Test `/learn` as guest and authenticated user
- Upload PDF, free MP4, YouTube link via Admin → Upload
