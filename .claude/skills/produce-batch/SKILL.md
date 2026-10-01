---
name: produce-batch
description: Produce several TTYNG videos one after another, each through the start-production procedure in its own subagent. Usage: /produce-batch specs/a.json specs/b.json specs/c.json (produced in the order given).
---

# Produce batch

Specs to produce, in this order: `$ARGUMENTS`. If empty, stop and ask me for the list.

## For each spec, in order

1. **Delegate to a fresh subagent** with this instruction:
   "Follow `.claude/skills/start-production/SKILL.md` exactly for `<spec>`. Return only its final report."
   Use a new subagent per spec so one video's contact sheets never sit in context while the next is picked.

2. **Wait for it to finish before starting the next.** Never produce two at once; renders compete for CPU.

3. **If a spec fails** (validation, no acceptable pick after the one retry, QA failing twice), record the reason and move on to the next spec. Do not retry beyond what start-production allows.

4. **Check duration** against the spec id:
   - id ending `-s` (short arm): 12–18 s
   - id ending `-l` (long arm): 28–33 s
   - series specs (`w2-p*`): no range
   Flag anything out of range. Do NOT edit the script or VO to fix it; I decide.

## Final report (nothing more)

- Table: spec, status (done / failed + reason), output path, duration, duration in range (yes / no / n/a).
- Each subagent's weak-pick notes and QA warnings, unchanged.
- Caption and hashtags per video, from each spec's `meta`.
- One suggested commit message covering the whole batch.
- "Watch each one on your phone before posting."

## Rules

- Same rules as start-production: do not modify `src/`, `templates/`, `schema/`, `brand/`.
- Do not commit. Do not post anywhere.
- AI-generated label stays on for every video.
