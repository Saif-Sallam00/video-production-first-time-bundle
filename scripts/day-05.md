# Day 5 (week2/day7) — production scripts

Applies to all three:
- Shape template: `specs/w2-p2-stock.json` (voice preset, captions, end card, music, disclosure).
- `"motion_preset": "punch"` on all three.
- Visuals: stock, no faces, no recognizable people, no text in frame, no beds,
  nothing school- or teen-coded (classrooms, lockers, school buses).
- Hashtags (all three): #datingadviceformen #relationshipadvice #confidence #datingtips
- No spoken CTA, no spoken series intro.

---

## 1. Part 1 — `specs/w2-p1-stock.json` (new, final part of the series)

`output_dir`: `week2/day7/slot1-part1-its-not-a-test`
Series label on screen the whole video: `Nobody tells you this · 1 of 7`
Series follow pop at 4 s: `Follow for all 7`

| Beat | VO | Overlay | Visual |
|---|---|---|---|
| hook | Your first time is not a test. Nobody's grading you. | It's not a test. | Empty stadium at night, floodlights on, no people. Queries: "empty stadium night lights", "stadium floodlights empty", "empty arena night" |
| with | She isn't there to see if you pass. She's there to be with you. | — | Two bicycles parked side by side, evening light. Queries: "two bicycles parked together", "two bikes evening", "bicycles side by side" |
| pressure | Most of the pressure you feel is pressure you're putting on yourself. | — | Heavy barbell on a gym floor, dim light, no people. Queries: "barbell floor gym dark", "heavy weights gym floor", "barbell close up" |
| recap | And every other thing in this series, the nerves, the checking in, going slow, gets easier the second you stop performing and start paying attention. | — | Typography card, style "statement", text: "Stop performing. Start paying attention." |
| close | You don't have to be good at this yet. You just have to be there. | Just be there. | Calm ocean horizon at dawn, no people. Queries: "ocean horizon dawn", "calm sea sunrise", "sea horizon morning" |

Caption: #1 of 7. The one thing to remember. What to know before your first time.

---

## 2. C1 Long — `specs/lt-c1-l.json` (new)

`output_dir`: `week2/day7/slot2-lengthtest-c1-long-condoms-before-the-weekend`
Length-test video. No series block. Target 28–33 s.

MATCHED TO `specs/lt-c1-s.json`. Copy these beats from it unchanged (VO, overlay, visual pick): hook, action, close. Copy caption, hashtags, cta_pop. Insert the three new beats between hook and action, in this order:

| Beat | VO | Overlay | Visual |
|---|---|---|---|
| hook | (copy from lt-c1-s) | (copy) | (copy pick) |
| putoff | Most guys put this off because it feels awkward to bring up. So it ends up happening at the worst possible moment, with no plan, while you're already nervous. | — | Unopened envelope on a table, dim light. Queries: "unopened envelope table", "envelope on desk dark", "sealed letter table" |
| asking | Asking ahead doesn't kill anything. It's a normal question between adults, and it tells her you're thinking about her, not just about the night. | — | Doorway with warm light spilling into a dark room, no people. Queries: "doorway warm light dark room", "light through open door", "door light spill" |
| fix | And if neither of you has any, you find out with time to fix it. | — | Convenience store exterior at night, lit up, no people. Queries: "convenience store night", "corner store night exterior", "store front night lights" |
| action | (copy from lt-c1-s) | (copy) | (copy pick) |
| close | (copy from lt-c1-s) | (copy) | (copy pick) |

---

## 3. A2 Short — `specs/lt-a2-s.json` (new)

`output_dir`: `week2/day7/slot3-lengthtest-a2-short-body-switches-off`
Length-test video. No series block. Target 12–18 s.

MATCHED TO `specs/lt-a2-l.json`. Use only these three beats, each copied from lt-a2-l unchanged (VO, overlay, visual pick): hook, why, action. Copy caption, hashtags, cta_pop. No new searches needed.

| Beat | VO |
|---|---|
| hook | If your body switches off for a minute, it's not over. |
| why | Nerves can make your body's response come and go. That's your body reacting to pressure, not failing you. |
| action | Don't stop and apologize. Slow down, stay close, and keep your attention on her. |
