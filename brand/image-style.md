# Image style (generated-images mode)

`studio prompts` puts the style block below in front of every beat's `image_prompt`. Everything outside the
STYLE-BLOCK markers is for humans and is not sent. `prompts` adds one fixed line after the style block (subject must be exactly one of: ...).

## Style block

<!-- STYLE-BLOCK-START -->
Tall vertical illustration, 2:3. Near-black charcoal background. Glowing amber-gold
wireframe line art: thin luminous contour lines, faint mesh texture, soft bloom.
Abstract figures with no facial features, no skin detail, fully non-sexual.
Anatomical brain or heart as a warm golden glowing accent. One subject, centered,
with empty space at the top and bottom for captions. No text, no letters, no logos,
no watermark.
<!-- STYLE-BLOCK-END -->

## Banned words

`studio validate` (generated mode) fails any `image_prompt` containing one of these as a whole word,
case-insensitive. Comma- or line-separated; edit freely. Not sent to the image model.

<!-- BANNED-WORDS-START -->
bed, bedroom, embrace, hug, kiss, couple, naked, nude, undress, bra, lingerie, sensual, intimate, touching, sex
<!-- BANNED-WORDS-END -->

## Hard rules

- A single figure, a brain, a heart, hands, objects or symbols only.
- NEVER two bodies touching, beds, undressing, or anything sensual.
- No text in images.
