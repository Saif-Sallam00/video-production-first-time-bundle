---
name: start-production
description: Produce one TTYNG TikTok video end to end from a spec: validate, search stock, pick assets against each beat's visual_intent, render, QA, and report. Usage: /start-production specs/<id>.json (no argument = the next spec in specs/ that has no finished render in out/).
---

# Start production

Produce ONE finished video from a spec JSON, then stop. You never post, schedule, or publish anything.

Target spec: `$ARGUMENTS`. If empty, list `specs/*.json`, find the first whose `out/<id>/` has no final MP4, and use it. Tell me which one you chose.

Run all commands as `npm run studio -- <command> ...` from the repo root.

**Node 22 is required** (HyperFrames refuses to render on Node 20, the nvm default). Before any command, run `nvm use 22`, or if nvm isn't loaded in the shell: `export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$HOME/.local/bin:$PATH` (this also puts `ffmpeg`/`ffprobe` on PATH).

## Steps

1. **Validate.** `npm run studio -- validate <spec>`. If it fails, fix the spec only if the fix is obvious and mechanical, and say what you changed. Otherwise stop and report.

2. **Search.** `npm run studio -- assets <spec>`. Duration/size-cap warnings on Pixabay clips are normal; ignore them.

3. **Pick.** View `out/<id>/asset-candidates.jpg`. For each beat that still needs an asset, choose the candidate that best matches that beat's `visual_intent`.
   - Hard rejects: any visible face or recognizable person, watermark, logo, text in frame, busy or low-contrast shots.
   - Prefer: one clear subject, calm mood, readable in the first second, dark or warm tones.
   - Beats in the same video must not look alike. If two picks look similar, change one.
   - Use the series look from `brand/tokens.json` as context; do not edit it.
   - If NO candidate for a beat is acceptable, do not force a pick. Add 3 new `search_queries` to that beat in the spec (different angle, not a reword), re-run `assets` for that beat, and try once more. If it still fails, stop and report the beat.
   - Then run `npm run studio -- assets --pick <spec> <beat_id>=<n> ...` for all beats at once.

4. **Voice.** `npm run studio -- voice <spec>`. Cache hit skips TTS.

5. **Timeline.** `npm run studio -- timeline <spec>`. Render fails without `out/<id>/timeline.json`. Re-run `timeline` after any change to the spec or `brand/tokens.json`.

6. **Render.** `npm run studio -- render <spec>`. Never render with unresolved beats; the tool refuses, and that is correct.

7. **QA.** `npm run studio -- qa <spec>`, then view `out/<id>/contact-sheet.jpg`. `qa` currently only builds the contact sheet (SPEC section 10, gate 7). It does NOT check loudness, resolution or safe-zone, so a clean `qa` run is not a pass on those. Judge the contact sheet yourself (text over subject, unreadable captions, wrong crop). If something is wrong, fix the cause (usually a pick, not the template) and re-render ONCE. If it fails again, stop and report.

8. **Report.** End with exactly this, nothing more:
   - Output file path and duration.
   - Table: beat, pick number, asset source, one-line reason.
   - Any beat where the pick was a weak match (be honest; I will look at these first).
   - Warnings or QA notes. Always state explicitly: "Loudness, resolution and safe-zone were NOT verified (qa only builds the contact sheet)."
   - Caption and hashtags from the spec's `meta`.
   - Reminder: "Watch it on your phone before posting."

## Rules

- Do NOT modify files in `src/`, `templates/`, `schema/`, `brand/`. Production only.
- Do NOT commit. Suggest a commit message at the end.
- Do NOT start a second video. One spec per run.
- Do NOT post anywhere.
- AI-generated label stays on (`disclosure.ai_generated_label`).
- You only see thumbnails, so motion quality of clips is a guess. Say so when a clip pick is uncertain.
