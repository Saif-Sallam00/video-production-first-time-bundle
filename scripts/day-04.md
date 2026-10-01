# Day 4 (week2/day6) — production scripts

Applies to all three:
- Shape template: `specs/w2-p3-stock.json` (voice preset, captions, end card, music, disclosure).
- `"motion_preset": "punch"` on all three.
- Visuals: stock, no faces, no recognizable people, no text in frame, no beds.
- Hashtags (all three): #datingadviceformen #relationshipadvice #confidence #datingtips
- No spoken CTA, no spoken series intro.

---

## 1. Part 2 — `specs/w2-p2-stock.json` (new)

`output_dir`: `week2/day6/slot1-part2-go-slower`
Series label on screen the whole video: `Nobody tells you this · 2 of 7`
Series follow pop at 4 s: `Follow for all 7`

| Beat | VO | Overlay | Visual |
|---|---|---|---|
| hook | The most underrated move your first time is going slower than feels natural. | Go slower than feels natural. | Water drop falling into water, slow motion, dark background. Queries: "water drop slow motion", "droplet splash dark", "water drop macro" |
| rush | Nerves make you rush. You want to get to the part you're worried about so it's over with. But rushing is what makes it feel mechanical, for both of you. | — | Train passing fast at night, motion blur, no people. Queries: "train passing night blur", "fast train motion blur", "subway train speed" |
| slow | Slow down the kissing. Slow down everything before anything else happens. | Slow everything down. | Leaves moving gently in a breeze, golden hour. Queries: "leaves breeze golden hour", "tree leaves slow wind", "leaves sunlight gentle" |
| present | Going slow keeps you present instead of stuck in your head. | — | Feather falling slowly, dark background. Queries: "feather falling dark", "feather floating slow", "white feather black background" |
| tease | Number one is next: the one thing to remember if you forget the rest. | — | Typography number card: "1 →" |

Caption: #2 of 7. Why going slow matters. What to know before your first time.

---

## 2. A1 Long — `specs/lt-a1-l.json` (new)

`output_dir`: `week2/day6/slot2-lengthtest-a1-long-body-wont-cooperate`
Length-test video. No series block. Target 28–33 s.
`cta_pop`: "Follow — new one every day", `start: {"at_sec": 4}`

MATCHED TO `specs/lt-a1-s.json`. Copy these from it unchanged: hook beat (VO, overlay, visual pick), why beat (visual pick), action beat (VO, overlay, visual pick), caption, hashtags, cta_pop.

| Beat | VO | Overlay | Visual |
|---|---|---|---|
| hook | (copy from lt-a1-s) | (copy) | (copy pick) |
| why | Your body responds when you feel relaxed, not when you force it. Stress pushes it the other way. | — | (copy pick from lt-a1-s) |
| stress | That's why nerves hit guys hardest the first time. You're flooded with stress, and the more you worry about it working, the harder it is for it to work. | — | Storm clouds moving fast, time-lapse, dark. Queries: "storm clouds timelapse", "dark clouds moving", "stormy sky fast clouds" |
| relax | Telling yourself to relax doesn't fix it either. What helps is changing what's riding on the night. | — | Tight knot in a rope, close-up. Queries: "rope knot close up", "tight knot rope", "knotted rope macro" |
| options | Nothing has to happen tonight for it to count. You can kiss, talk, slow down, stop, and pick it up another time. | — | Open empty road at golden hour, no cars. Queries: "empty road golden hour", "open road sunset", "country road evening" |
| action | (copy from lt-a1-s) | (copy) | (copy pick) |

---

## 3. B1 Short — `specs/lt-b1-s.json` (new)

`output_dir`: `week2/day6/slot3-lengthtest-b1-short-grading-voice`
Length-test video. No series block. Target 12–18 s.
`cta_pop`: "Follow — new one every day", `start: {"at_sec": 4}`

MATCHED TO `specs/lt-b1-l.json`. Use only these three beats, each copied from lt-b1-l unchanged (VO, overlay, visual pick): hook, action, close. Copy caption, hashtags, cta_pop. No new searches needed.

| Beat | VO |
|---|---|
| hook | That "am I doing this right?" voice is what's pulling you out of the moment. |
| action | When you catch that voice, switch to one thing you can physically feel right now. |
| close | Grading keeps you in your head. Feeling keeps you in the room. |
