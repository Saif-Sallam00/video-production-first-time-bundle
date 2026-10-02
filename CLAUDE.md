
# video-production: The Talk You Never Got (TTYNG)

Faceless TikTok videos rendered from JSON specs.

- Specs: specs/*.json. Scripts: scripts/day-XX.md are the source of truth for VO,
  overlays and visuals.
- Output: out/<output_dir>/ (week/day/slot layout). The final mp4 is named after its folder.
- Produce one video: /start-production <spec>. Several: /produce-batch <specs...>.
- Production tasks never touch src/, templates/, schema/ or brand/ unless I say so.
- Length test: lt-*-s must land 12–18 s, lt-*-l 28–33 s. Matched pairs share hook,
  action, caption and cta_pop. Never change those on one side only.
- Unsplash is in demo mode (50 requests/hour). A 403 means rate-limited, not "no
  candidates". Never rewrite search_queries because of a 403.
- Visuals: no faces, no recognizable people, no text in frame, no beds.
- Never commit or post unless I ask. The AI-generated label is always on.
Renders need Node 22+ (run `nvm use` first).
