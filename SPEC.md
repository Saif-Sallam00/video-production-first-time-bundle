# TTYNG Studio: Series Template Spec (v1)

Local pipeline that turns one JSON video spec into one finished 9:16 MP4 for **The Talk You Never Got**. Production only. No posting, scheduling or analytics.

Files that ship with this spec:

- `schema/video.schema.json`: the contract every script fills (JSON Schema 2020-12)
- `brand/tokens.json`: every visual/audio constant (a starting hypothesis, editable)
- `examples/w2-p6.json`: fixture built from the real Week 2 Part 6 script

---

## 1. Principles

1. **The voiceover drives the timeline.** Beat timings, captions and the CTA pop all come from TTS word timestamps. Nothing is timed by hand.
2. **One template, many variants.** Every video uses the same component system, but hooks, visual modes and overlays vary per spec so a week of videos never looks interchangeable.
3. **Tokens, not constants.** Templates read colors, fonts, sizes, safe zones and motion from `brand/tokens.json`. Changing the look must never require touching template code.
4. **Deterministic and cached.** Same spec + same tokens + same audio = identical MP4. TTS is cached by content hash so re-renders cost nothing.
5. **No dead air at the start.** Frame 0 shows meaningful content. No fade from black, no logo, no intro.
6. **Human approves the final cut.** Automated QA catches mechanical problems; a person watches every video before it leaves the pipeline.

## 2. Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js 22+, TypeScript |
| Renderer | HyperFrames (install skills: `npx skills add heygen-com/hyperframes`) |
| Voice | Kokoro-82M (Apache 2.0), local on CPU via the Python `kokoro` package in a uv env (`tts/`). ElevenLabs is optional. Voice costs $0 by default. |
| Media ops / QA | FFmpeg + ffprobe |
| Validation | Ajv (JSON Schema 2020-12) |

Use the HyperFrames skills for all composition authoring. Do not hand-roll a renderer or a frame capture loop.

**Renderer escape hatch:** `timeline.json` (section 5) stays renderer-agnostic — it names no HyperFrames concept, so a different renderer can consume it unchanged. Nothing in M1–M3 may depend on HyperFrames. If HyperFrames blocks M4 for more than a day, stop and report; the fallback is FFmpeg + ASS subtitles (karaoke tags for word highlight), driven by the same `timeline.json`.

## 3. Repo layout

```
ttyng-studio/
  SPEC.md
  schema/video.schema.json
  brand/tokens.json
  brand/fonts/                  # Anton-Regular.ttf, Inter-SemiBold.ttf (OFL, bundled locally)
  brand/safezone-overlay.png    # TikTok UI screenshot, preview only, never rendered
  config/voice.json             # voice presets
  tts/                          # Kokoro runner: pyproject.toml + uv.lock (pinned), kokoro_tts.py; .venv/ made by uv
  assets/stills/  assets/clips/  assets/music/
  assets/candidates/<beat_id>/  # M5b: downloaded stock candidates awaiting a pick, plus contact-sheet.jpg
  assets/index.json             # M5b: source URL + license per picked asset
  specs/<week>/<id>.json        # one file per video
  templates/                    # HyperFrames composition + components
  src/                          # CLI
  cache/tts/<hash>/             # audio.wav + alignment.json
  out/<id>/                     # final outputs
  .env                          # ElevenLabs: ELEVENLABS_API_KEY (optional ELEVENLABS_BASE_URL)
                                 # M5b: PEXELS_API_KEY, PIXABAY_API_KEY
```

`config/voice.json`:

```json
{
  "james-default": {
    "provider": "kokoro",
    "model_id": "hexgrad/Kokoro-82M",
    "voice_id": "am_michael",
    "speed": 1.0,
    "beat_gap_sec": 0
  },
  "james-elevenlabs": {
    "provider": "elevenlabs",
    "model_id": "<MODEL_ID>",
    "voice_id": "<VOICE_ID>",
    "speed": 1.0,
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0
  },
  "pronunciations": { "<word>": "<spoken form>" }
}
```

Every preset names a `provider`, `model_id`, `voice_id` and `speed`; other keys are provider-specific settings. A spec's `voice.speed` overrides the preset speed. Never change a preset mid-series. The default preset's `voice_id` is picked by ear with `studio voice --audition`.

`beat_gap_sec` (default 0) inserts that much silence at each beat boundary after synthesis, so pacing can be tuned without changing prosody — the TTS take itself is still the continuous full VO (section 5). It's part of the TTS cache key.

**TTS providers** sit behind one interface: given the spoken text and the resolved voice, a provider writes audio and returns timed tokens (characters, words or recognized words). The pipeline then aligns those tokens to the script (section 5), so every provider ends up in the same word-timing format.

| Provider | Timings (`alignment` method) | Needs |
|---|---|---|
| `kokoro` (default) | `kokoro-durations`: per-word start/end from the model's own duration predictor, so they are the timings the audio was made with | `uv` on PATH. The first run creates `tts/.venv` from `tts/uv.lock` (CPU torch, ~1.3 GB) and downloads the model to the Hugging Face cache |
| `elevenlabs` (optional, paid) | `elevenlabs-characters`: character timings from the with-timestamps endpoint | `ELEVENLABS_API_KEY` |

Kokoro runs as a Python subprocess rather than kokoro-js. kokoro-js returns audio only: no durations, and its phonemizer merges the text before synthesis, so words can't be mapped back to audio. It would need a Whisper pass on top. The Python package returns per-token timestamps directly. Kokoro's vocoder adds noise, so the runner seeds it per job, which makes re-renders byte-identical.

`pronunciations` keys are single words, matched whole-word and case-insensitively; punctuation attached to the word is kept (`TTYNG,` → `the talk you never got,`). Values may be several words.

## 4. CLI

| Command | Does |
|---|---|
| `studio validate <spec\|dir>` | Schema check + lint rules (section 9). Exit 1 on errors, print warnings. |
| `studio voice <spec>` | Validates, joins beat `vo` with single spaces, applies `pronunciations`, runs the preset's TTS provider, trims leading silence, aligns word timings (section 5), writes to `cache/tts/<hash>/`. Hash = sha256(spoken text + resolved voice: provider, model, voice, speed, `beat_gap_sec`, alignment method, provider settings). Cache hit skips TTS. |
| `studio voice --audition <spec>` | Renders the hook beat in every American male Kokoro voice (`am_*`) to `out/audition/<voice_id>.wav`, at the spec's speed, to pick the default voice by ear. Not cached. |
| `studio voice --audition-speed <spec>` | Renders the full VO at 0.8, 0.85, 0.9 and 1.0x to `out/audition/speed/<speed>.wav`, to pick the pace by ear; prints each take's words-per-minute. Doesn't change the preset's speed. Not cached. |
| `studio timeline <spec>` | Builds `out/<id>/timeline.json` from the spec + alignment (section 5). |
| `studio render <spec>` | Renders the HyperFrames composition from `timeline.json` to `out/<id>/<id>.mp4`. `--preview` opens the live preview with the safe-zone overlay visible. |
| `studio qa <spec>` | Currently just gate 7 (section 10): extracts frames from the rendered `<id>.mp4` and writes `out/<id>/contact-sheet.jpg`. The rest of the QA gates and `qa.json` are still M6 future work. |
| `studio make <spec\|dir>` | validate → voice → timeline → render → qa. For a dir, processes every spec and runs the batch lint. |
| `studio assets <spec>` | M5b. For each beat with `search_queries` and no still/clip yet, offers matching library assets plus up to 4 new candidates from Pexels (Pixabay fallback) into `assets/candidates/<beat_id>/`, and builds `out/<id>/asset-candidates.jpg`. Never picks. |
| `studio assets --pick <spec> <beat_id>=<n> ...` | M5b. Moves the chosen candidate `<n>` for each `<beat_id>` into the asset library, writes its path into the spec and appends `assets/index.json`. |

## 5. Timing model

- **Full VO** = `beats[].vo` joined with one space. Keep a character-offset map of where each beat starts and ends inside it.
- **Words** are the spoken text split on whitespace; punctuation stays attached to the word. The known text is always the source of truth: provider tokens only lend it timings. Letters and digits of the script are matched to the tokens' letters and digits (longest common subsequence), so tokenization, punctuation and small recognition differences don't matter. A word's start = the start of the first token under its matched characters, its end = the end of the last (for character tokens: first character's start, last character's end). A word counts as matched when at least half of its characters matched.
- Unmatched words get interpolated timings: each run of them splits the gap between its matched neighbours in proportion to word length. Words with no letters or digits (a standalone `—`) are always interpolated and don't count. If more than 10% of the counted words are unmatched, `voice` fails and caches nothing.
- **Beat start** = start of its first word. **Beat end** = start of the next beat's first word (so visuals cut on speech, not on silence). The last beat ends at VO end + `audio.tail_sec`.
- The first beat starts at 0.0 regardless of leading silence in the audio. If the audio has more than 0.15 s of leading silence, trim it before muxing. `studio voice` does this once, at cache-write time: it finds the silence with FFmpeg `silencedetect` (−50 dB), cuts it off, and shifts every alignment time back by the same amount.
- After the leading-silence trim, if the voice preset's `beat_gap_sec` is above 0, `studio voice` splices that much silence into the audio at every beat boundary and shifts every later alignment time by the cumulative gap so far. The TTS take itself stays the one continuous, full-VO render — only the pacing between beats changes, prosody within a beat doesn't.
- `cache/tts/<hash>/audio.wav` is 16-bit PCM (bit-exact, so reruns produce identical files). `alignment.json` holds the spoken `text`, the resolved `voice`, `words` (`[{ "text", "start", "end", "matched" }]`, one per spoken word, trimmed timeline), `duration_sec` and `leading_silence_trimmed_sec`. A cache entry is written atomically, so a half-finished or failed run never counts as a hit.
- **CTA pop start**: `at_sec` directly, or the start time of the first word of `phrase` inside that beat's `vo` (case-insensitive, punctuation-insensitive match). Unmatched phrase = validation error.
- **End card** (off by default): appended after the tail. Only about 4% of Week 1 viewers reached the end, so nothing important lives there.

`timeline.json` shape:

```json
{
  "id": "w2-p6",
  "duration_sec": 34.2,
  "audio": { "vo": "cache/tts/<hash>/audio.wav", "music": { "file": "assets/music/bed-01.mp3", "gain_db": -22, "duck_under_vo": true } },
  "label": "Nobody tells you this · 6 of 7",
  "beats": [
    { "id": "hook", "start": 0.0, "end": 4.1, "visual": {}, "overlay": {} }
  ],
  "words": [ { "text": "Your", "start": 0.0, "end": 0.18, "beat_id": "hook" } ],
  "caption_pages": [ { "start": 0.0, "end": 1.9, "lines": [["Your", "first", "time"], ["will", "not", "look"]], "word_indexes": [0, 5] } ],
  "cta_pop": { "text": "Follow for all 7", "start": 4.3, "end": 6.8, "style": "pill" },
  "end_card": null
}
```

## 6. Scene structure

Layers, bottom to top:

| Z | Layer | Source | Notes |
|---|---|---|---|
| 0 | Background | `beat.visual` | Hard cut at beat boundaries |
| 1 | Grade | tokens `grade` | Vignette always (whole video). On a still/clip beat, extra darkening: a full-width band behind each of the series label, the overlay box and the caption block (only if a caption page is on screen during the beat), feathered `darken_feather_px` above and below; bands whose feathers touch merge so they never double-darken (`scrimBands`). Each band's alpha follows the mean luma of the picture behind it, sampled from the real pixels at render time: `darken_behind_text` over black, ramping linearly to `darken_behind_text_max` at `darken_bright_luma` and above (`darkenAlpha`). The ramp saturates before white so the muted label reaches 4.5:1 on bright frames; it cannot above ~0.93 luma even at the ceiling. Solid/typography beats get no bands |
| 2 | Series label | `series.label` | Top of safe zone, small, muted, persistent for the full video. Hidden if absent |
| 3 | Overlay | `beat.overlay` | Spans its beat |
| 4 | Captions | `timeline.caption_pages` | Word-synced |
| 5 | CTA pop | `cta_pop` | Above everything except the end card |
| 6 | End card | `end_card` | Optional, full frame |

### Layout

One layout module computes every text box; the lint, the templates and QA all use it, so they can't disagree. Boxes are centered horizontally in the safe zone unless noted. Line heights come from `tokens.line_height`, padding from `tokens.padding` (`[vertical, horizontal]` px), corner radii from `tokens.radius`.

| Box | Position |
|---|---|
| Series label | Top of the safe zone |
| Captions | `caption.max_lines` lines centered on `caption.center_y`, safe width |
| Overlay, `upper` | Directly under the label (the safe-zone top when there is no label) |
| Overlay, `center` | Centered between the label and the caption block, so it stays in the upper half. With captions off, centered on the canvas |
| CTA `pill` | Directly under the caption block, so it never covers the active caption line. With captions off, centered on `caption.center_y` |
| CTA `bar` | Full canvas width at the top of the safe zone |

Overlays never overlap the captions, and the CTA pop box never overlaps an overlay box while both are on screen. Compute boxes and assert.

## 7. Components

A beat may also carry `visual_intent` (string, max 140 chars) and `search_queries` (1-4 strings): notes on what the beat's visual should show and stock search terms for it. Both are optional, schema-validated, and ignored by the renderer — they exist only as input for M5b's asset search.

A beat may also carry `captions_hidden` (boolean, default false): when true, no caption page is shown while that beat is on screen — the VO still plays and the beat's words still exist in `timeline.words`, they just never appear on any `caption_pages` entry. Use this when a beat's own visual (typically `typography`) already repeats its VO on screen, so the words aren't shown twice.

### Background visuals (`beat.visual.type`)

- **solid**: full-frame color from a token name.
- **typography**: full-frame text on `bg`. `statement` = display font, `typography_statement` size, max 3 lines. `number` = one huge numeral (`typography_number`, one line), used for countdown beats.
- **still**: image from `assets/`, cover-fit to 1080×1920 (`object-fit: cover`, centered), motion over the beat's duration: `push_in`/`pull_out` sweep `motion.still_zoom` (pull_out is the reverse), pans travel `motion.still_pan_px` **in total**, centered on the frame, at a fixed scale of `(width + still_pan_px) / width` so the image still covers the frame at both extremes. `pan_left` moves the picture leftward across the frame (`pan_right` the reverse). Linear easing over the full beat. The poses come from `stillMotion` in `src/media.ts`; the template only tweens between them on a non-timed wrapper.
- **clip**: video from `assets/`, muted, cover-fit, starts at `trim_start_sec`, loops if shorter than the beat. A loop is back-to-back `<video>` elements, each restarting at `trim_start_sec` (one media element per range is HyperFrames' own model), the last cut off at the beat end (`clipSegments`). Each pass lasts `(source length − trim_start_sec) / playback_rate`; a pass under 0.25 s fails the render.

### Overlays (`beat.overlay.style`)

- **hook_slam**: display font, `hook_slam` size, max 4 lines, appears on frame 0 of the beat with no animation (it must be readable on the very first frame).
- **card**: body font, `card` size, max 3 lines, on a `card_bg` panel with `padding.card` and `radius.card`, fades in over `overlay_in_ms`.
- **kicker**: small uppercase accent line, body font, `kicker` size, one line.

### Captions

- `word_highlight` (default): show a page of up to `max_lines` lines; the active word switches to `caption_highlight`. Never split a word.
  - **Lines and pages are chosen jointly by an optimal (Knuth-Plass style dynamic programming) breaker** (`breakSentence` in `src/breaker.ts`), run per sentence, minimizing total cost — not a greedy character budget. Line width is measured in real pixels (the caption font/size against the safe-zone width via the fontkit layout in `text.ts`), not a character count. Costs, heaviest to lightest: a one-word line (unless the whole sentence is one word) and a page under 3 words (unless the sentence is shorter) are effectively forbidden; a line ending on a glue word (`a, an, the, of, to, in, on, at, for, with, and, or, but, my, your, his, her, their, our, this, that, is, are, was`) is heavily penalized; each page beyond the minimum a sentence needs costs a flat penalty (so a long sentence doesn't fragment into more, thinner pages than necessary); raggedness (squared unused line width, and squared page word-count deviation from an even split) is a light cost; breaking right after clause punctuation (`, ; : —`) is rewarded. An em dash attaches to the word before it, so a line never starts with one. A sentence end always closes the line — a line never holds the tail of one sentence and the head of the next.
  - **Pages** hold up to `max_lines` lines. A page never contains the end of one sentence and the start of another unless the whole next sentence fits in the page's remaining lines, so a page never ends on just the opening word(s) of a sentence it can't finish (e.g. dangling on "Six:"). A sentence too long for one page is split into several pages by the same joint line+page optimization (never packed with a neighbouring sentence).
  - A beat with `captions_hidden: true` contributes no units to this at all — its words are skipped entirely when building sentences, so they never appear on any page (see section 7 intro).
- `phrase`: same pages, no per-word highlight.
- Body font, `caption` size, 4 px dark stroke or soft shadow for legibility on any background. Word spans are separated by real space characters (normal inline white-space), not CSS `gap`, so the browser lays out the same space width `breaker.ts` measured — see the render-time guard in section 8.
- Captions show the words as spoken in the full VO (after pronunciation fixes, display the original spelling).

Typography statements, overlays and the end card also wrap with the same optimal breaker (`wrap` in `src/text.ts`, which calls `breakSentence` with that text box's own font, size, width and real `max_lines`) instead of a greedy fill — so a hook_slam, card, kicker, typography statement or end card also never breaks a line down to one word or a glue-word ending when a better split exists. A text needing more lines than its `max_lines` allows comes back as that many lines anyway (the lint rule below still catches the overflow) rather than an artificially truncated wrap.

### CTA pop

- `pill`: accent pill with dark text, `cta` size, one line, `padding.pill` and `radius.pill`, scales 0.9 → 1.0 over `cta_in_ms`, fades out over the last 200 ms.
- `bar`: full-width accent bar at the top of the safe zone, one line, `padding.pill` vertical padding.
- Placed per section 6 so it never covers the active caption line or an overlay on screen at the same time.

## 8. Safe zones and output

- Canvas 1080×1920, 30 fps, H.264 (yuv420p, CRF 18), AAC 48 kHz stereo, `+faststart`.
- Every asset path in a spec (`visual.asset`, `music.file`) is relative to `assets/`, e.g. `stills/window-night-01.jpg`, `music/bed-01.mp3`.
- All text boxes (label, overlays, captions, CTA, end card) must sit inside the `safe_zone` insets. The inset values are defaults; confirm them once by rendering the preview with `brand/safezone-overlay.png` on top.
- Loudness: normalize the final mix to `audio.target_lufs` integrated, true peak ≤ `audio.true_peak_db` (FFmpeg `loudnorm`, two-pass).
- Music (optional) sits at `gain_db` and ducks under VO when `duck_under_vo` is true. A music file without `license_note` is a schema error. Ducking is a volume envelope derived from the word timings (`musicLane` in `src/media.ts`), not audio analysis: while the VO speaks the bed sits at `gain_db + audio.music_duck_db`; in pauses it returns to `gain_db`, ramping down over `music_duck_attack_sec` and up over `music_duck_release_sec`. Words closer together than attack + release count as one spoken stretch, so it doesn't pump between words. The bed always fades to silence over the last `audio.tail_sec`. The file must be at least as long as the video (the render fails otherwise). Final loudness normalization is still M6.
- **Render-time guard**: `studio render` loads the composition in a real (headless) browser before invoking HyperFrames and compares every caption line's actual DOM width to what `layout.ts`/`breaker.ts` predicted from the real font. A line that drifts by more than 3% fails the render — this catches any future divergence between the measured layout and what the browser actually renders (e.g. a CSS change that reintroduces flex `gap` instead of real space characters between word spans).

## 9. Lint rules (beyond the schema)

Errors:

- Beat `id`s not unique, or more than one `hook` beat.
- `cta_pop.start.beat_id` doesn't exist, or its `phrase` isn't found in that beat's `vo`.
- An asset path (`visual.asset`, `music.file`) that doesn't exist under `assets/`.
- A color token name not in `tokens.colors`.
- A text box that can't fit inside the safe zone at its token size, padding included (measure with the real font), or that wraps past its line limit: hook_slam 4, card 3, kicker 1, statement 3, number 1, label 1, CTA 1, end card 2 (display font, `typography_statement` size). Every spoken word must fit a caption line by itself.
- The CTA pop box overlaps an overlay box while both are on screen (layout from section 6).

Before any audio exists, `validate` places beats and the CTA in time by character offset (~1,100 characters ≈ 70 s, divided by `voice.speed`). The timeline step re-runs the timing-based checks with real TTS timings.

Warnings:

- CTA pop resolves to a start later than 5.0 s. (Week 1 lesson: end-of-video CTAs went unseen.)
- Full VO longer than ~1,100 characters (roughly 70 s). Length should follow the idea; this just flags it.
- Batch check (dir mode): 3 or more consecutive specs share the same first-beat overlay style **and** the same first-beat visual type.
- `disclosure.ai_generated_label` is false. Every voice preset is TTS, so every voiceover is AI-generated.
- `captions_hidden` on a beat whose on-screen text (typography and/or overlay, combined) shares less than 50% of its words with the beat's own `vo` — hiding captions assumes the on-screen text already carries the words.

## 10. QA gates (`studio qa`)

Automated, written to `out/<id>/qa.json` with pass/fail per check:

1. Resolution, fps, codecs and duration match the timeline (±1 frame).
2. Integrated loudness within ±1 LU of target; true peak under the limit.
3. Leading silence before the first word ≤ 0.15 s.
4. Every word in `timeline.words` appears on exactly one caption page, in order — except words from a `captions_hidden` beat, which appear on none.
5. All computed text boxes are inside the safe zone and don't overlap each other.
6. CTA pop start ≤ 5.0 s (warning, not failure).
7. Contact sheet (**pulled forward, built** — see `studio qa` above): frames at t = 0.0, the CTA pop midpoint (if any) and the midpoint of every beat and every caption page, in chronological order with any point within 0.75 s of the last kept one dropped (the earlier wins), tiled into `contact-sheet.jpg`, each with its timestamp burned in. Extracted from the rendered MP4 itself, not the DOM, so it shows what actually rendered.

`out/<id>/` also gets `manifest.json`: spec hash, token hash, voice preset, TTS cache key, render time, QA summary, and `ai_generated_label` (the reminder to switch TikTok's AI-generated content label on at upload).

Then a person watches the MP4 once. Rejections go back into the spec, never into the rendered file.

## 11. Build order

Each milestone ends with a command that works on `examples/w2-p6.json`.

1. **M1 Contract**: repo scaffold, `validate` with Ajv + all lint rules. Unit-test every lint rule with a failing and a passing spec. **Done.**
2. **M2 Voice**: `voice` with the provider interface (Kokoro default, ElevenLabs optional), caching, pronunciation map, leading-silence trim, script alignment and `--audition`. Re-running must not call TTS. **Done** — default voice is `am_puck` (`config/voice.json`).
3. **M3 Timeline**: word derivation, beat timing, caption paging, CTA resolution. Unit-test caption paging on long and short sentences.
4. **M4 Template core**: HyperFrames composition with `solid` + `typography` backgrounds, label, overlays, captions, CTA pop. The fixture renders end to end with an empty `assets/` folder.

M3 and M4 run back to back: the goal is the first real rendered MP4 of the fixture, not a milestone-by-milestone pause. After that:

5. **M5 Media**: `still` (all motions) and `clip` backgrounds, grade layer, optional music with ducking. **Done.** Second fixture `examples/w2-p6-media.json` (same script as w2-p6, so it shares its TTS cache) exercises every still motion but `static`, a looping clip and a music bed, using generated placeholder assets under `assets/`.
6. **M5b Studio assets**: **Done** (see below). Needs `PEXELS_API_KEY` / `PIXABAY_API_KEY` in `.env` to search; everything else is tested against mocked APIs.

M6 and M7 are deferred until after the first video has actually shipped:

7. **M6 QA**: all gates, manifest, loudness normalization. Gate 7 (contact sheet) pulled forward and built — see `studio qa` above.
8. **M7 Batch**: `make <dir>`, batch lint, a summary table of all videos in the run.

Acceptance for v1: `studio make examples/w2-p6.json` produces an MP4 that passes every QA gate, and changing one value in `brand/tokens.json` changes the render without touching any template file.

### M5b: `studio assets`

Fills in `still`/`clip` visuals for beats that named `search_queries` but have no asset yet. Never auto-picks — a person always chooses.

**Which beats.** Any beat with `search_queries` whose `visual` is not yet a `still`/`clip` (the schema requires `asset` on those, so an un-sourced beat carries a placeholder `solid`, or whatever visual it had, plus `visual_intent`/`search_queries`). Beats that already have an asset are reported as skipped. `examples/w2-p6-stock.json` is such a spec.

**Providers.** Everything goes through one interface (`StockProvider` in `src/assets/provider.ts`: `kinds`, `search(query)` returning normalized `Candidate`s, and an optional `trackDownload`); the selection code (`select.ts`) never names a provider, so a new source is one new file plus one line in `stockProviders()` in `cli.ts`. The wired-in order (skipping any whose key is missing from `.env`):
1. **Unsplash** (`UNSPLASH_ACCESS_KEY`), **photos only**. The `raw` URL is requested at an explicit width (`wantedWidth`): the smallest that covers 1080×1920 with `pushHeadroom` (1.1) to spare for a push-in, in the photo's own aspect ratio, never above the original (`fit=max`), so returned files are real pixels, not an upscale. Originals smaller than that are rejected by the size rule.
2. **Pexels** (`PEXELS_API_KEY`), photos and video, `orientation=portrait`. Its key issuance is currently paused, so it is normally absent.
3. **Pixabay** (`PIXABAY_API_KEY`), **video only** in the CLI. Its photos are capped at 1280 px on the longest side (`largeImageURL`), so a portrait photo is ~853×1280 and can never meet 1080×1920; the provider now reports that real size (it once assumed 1280 wide and let upscaled photos through), so any Pixabay photo is rejected by the size rule. Pixabay videos have no orientation filter, so `select.ts` drops landscape hits.

**Acceptable candidate** (`RULES` in `src/assets/select.ts`): at least 1080×1920 (of the file we would actually download), height/width ≥ 1.4, videos ≥ 3 s, and no close-up-face tags (below). A provider's *claimed* size is only a pre-filter: after each download the real file is probed with ffprobe and dropped (with a warning) if it is below the minimum, so a misreporting provider can't slip an upscale through. **Video caps.** A video is skipped, with one aggregated warning per beat naming what was skipped, if it is over **15 MB** (`maxVideoBytes`) or longer than the beat needs: the beat's own length plus 4 s (`videoSlackSec`), never above **10 s** (`maxVideoSec`). Beat length comes from `out/<id>/timeline.json` when a timeline has been built, else the lint's characters-per-second estimate. Of the variants Pixabay offers that meet 1080×1920 the one with the fewest bytes is chosen, not just the first that qualifies. Size is checked before downloading when the provider reports it; a video that doesn't report a size is refused at download time by `Content-Length`, or by the bytes actually received, and nothing is saved.

**Search order.** All of a beat's queries run per **kind** (photo, video) down the provider chain: a provider is only asked when it supplies a kind for which earlier providers left fewer than **3 acceptable** candidates (rejects don't count), and only that kind's results are kept from it. So Unsplash supplies photos and Pixabay supplies video even when Unsplash alone has plenty of photos. A provider's query results are interleaved query by query and deduped; the final list alternates photo, video, photo, video… (photos first), backfilling with whichever kind is left. Up to **4 new** candidates per beat are downloaded into `assets/candidates/<beat_id>/<n>-<provider>-<id>.<ext>`, with a `candidates.json` beside them holding what `--pick` needs. `assets/candidates/` is gitignored, and re-running replaces a beat's candidates. A provider that errors (bad key, rate limit) is skipped with a warning.

**Reuse.** Before searching, `assets/index.json` is scanned for assets whose recorded `search_queries` overlap the beat's: the best pairwise word-set overlap (Jaccard) between any two queries must be ≥ 0.5. Up to 2 matches (whose files still exist and whose real size still meets the minimum) are offered first as candidates labeled `existing`; they don't count against the 4 new ones. A library asset picked before the size rule was enforced for real (e.g. an old upscaled Pixabay photo) is reported as skipped, not re-offered. Picking one just points the beat at the library file: nothing is moved or re-indexed.

**Single beat.** `studio assets <spec> --beat <id>[,<id>]` searches only the named beats (each must have `search_queries` and no still/clip yet), leaves every other beat's candidates untouched, and writes its own sheet, `out/<id>/asset-candidates-<beat>.jpg`, instead of overwriting the whole-spec one.

**Contact sheet.** One per run, `out/<id>/asset-candidates.jpg`: a row per beat, a tile per candidate labeled `<beat_id> #<n> <provider> <photo|video>` (or `existing`), videos shown by a frame at 0.5 s. A beat with no acceptable candidate gets a `none found` tile.

**Face guardrail (best-effort).** The series wants silhouettes, hands and places, not headshots. A candidate is dropped when its provider tags, alt text or URL slug contain any of `CLOSE_UP_FACE_WORDS` (portrait, headshot, face, selfie, close-up, smile/smiling, eyes, beard, lips, makeup, model, posing, handsome, attractive, looking at camera). This is keyword matching on the text a provider happens to supply, **not** a guarantee: untagged faces get through and harmless hits get dropped. A person reviews every candidate anyway.

**`--pick`.** `studio assets --pick <spec> <beat_id>=<n> ...` validates every pick first (a bad one changes nothing), then for each: moves the file to `assets/stills/` (photo) or `assets/clips/` (video) as `<provider>-<id>.<ext>`, sets the beat's `visual` to `{type: still|clip, asset}` (a previous still's `motion` is kept), and appends an `assets/index.json` entry keyed by the path under `assets/`. The index is append-only (an existing key is never replaced; the write is atomic). When the candidate's provider supplied a `track_url` (Unsplash's `download_location`) and that provider is configured, it is pinged once for a fresh pick (`StockProvider.trackDownload`); a failed ping warns but keeps the pick, and reusing an existing library asset sends nothing. Other candidates for the beat are left in `assets/candidates/`.

`assets/index.json` entry: `{ provider, source_url, creator, creator_url?, license, search_queries, picked_at }`. Licenses recorded: `Unsplash License`, `Pexels License`, `Pixabay Content License`. Keys come from `.env`: `UNSPLASH_ACCESS_KEY`, `PEXELS_API_KEY`, `PIXABAY_API_KEY`; providers without a key are skipped with a warning (no Unsplash/Pexels key = no photo source, so only video is searched). Unsplash demo-tier apps are limited to 50 requests/hour: a beat with 3 queries costs 3 Unsplash requests per run.

## 12. Out of scope for v1

- Generating images or AI video inside the pipeline. Assets are produced separately and dropped into `assets/`.
- Posting, scheduling, analytics.
- Languages other than English.
- A storyboard approval step before render. Renders are cheap and template-driven, so review happens on the final cut. Revisit only if AI-generated clips become a regular part of the format.
