---
target: M5 still-background hook frame + motion plan
total_score: 12
max_score: 24
na_heuristics: 3,5,7,9,10
p0_count: 1
p1_count: 2
target_identity: "file:/home/ss-dev/projects/video-production/templates/index.html"
target_fingerprint: "sha256:cb05a6cc641798429e23ff0dea3b0eded670ddab0a8ac91b9a13f8ad5a26c2a0"
target_path: /home/ss-dev/projects/video-production/templates/index.html
timestamp: 2026-09-30T00-08-33Z
slug: templates-index-html
---
Method: dual-agent (A: design review · B: detector + measured evidence). Adapted to a rendered 1080x1920 video frame plus the planned still-motion, not a web UI.

Target: hook frame (still background + hook_slam + caption + label) and the M5 still-motion plan.

## Design Health Score (6 heuristics applicable; 3, 5, 7, 9, 10 n/a for passive video)
Total 12/24 (Acceptable, generic).

## Design specificity verdict
Category-interchangeable "text on stock". Amber accent absent from the frame; single centered axis; loud Anton broadcast tone vs a warm/frank series voice.

## Priority issues
- [P0] Hook slam and caption repeat the same sentence on frame 0. Fix: captions_hidden on the hook, or a distilled slam that isn't the caption text.
- [P1] Accent (amber) not in frame; add one amber word in the slam or an accent rule by the label.
- [P1] Slam collides with the subject patch. Measured: brightest clean bg behind the slam needs black alpha 0.274 for 4.5:1; 0.45 covers bg luminance up to ~0.39 but NOT near-white (needs ~0.80-0.82).
- [P2] Series label (muted #9A968E, 30px) measured 2.39:1 worst case on stills; the grade bands do not cover it.
- [P3] Ragged pyramid wrap on the slam.

## Motion plan
Uniform linear 1.00->1.08 push on every beat reads as a stock Ken Burns filter. Vary direction per beat (fixture does: push_in, pan_left, pull_out, pan_right). Linear ease is spec'd; ease-out would feel more human but needs a spec change. Keep pans off two-line-slam beats.

Detector: `impeccable detect templates/index.html` -> 0 findings (weak evidence: DOM is built at runtime).
