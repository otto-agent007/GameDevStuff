# Generation Prompts

Generate one production frame per request. Reuse both locked references for every frame; never use a generated frame as the new identity reference.

## Locked references

1. `anchor-generation.png`: approved 1024×1024 nearest-neighbor identity reference. Preserve its face, hair, costume, proportions, direction, palette, outline, and camera.
2. `pixel-matrix.png`: separate 1024×1024 black-and-white 8×8 block matrix. Use it only to constrain crisp square pixel clusters. Do not composite, trace, or show the matrix in the output.

## Per-frame template

```text
Create exactly one full-body articulated animation frame.

Reference 1 is the locked character identity anchor. Preserve identity, costume,
proportions, direction, palette, outline weight, scale, and camera.
Reference 2 is a pixel-cluster constraint only. Render crisp square clusters aligned
to its 8×8 rhythm; do not include the black-and-white matrix in the artwork.

Change only: <measured pose delta for this frame>.
Keep the shared foot-contact baseline and generous padding on all sides.
Use the same flat chroma background. No text, extra characters, new props,
antialiasing, blur, gradients, subpixel detail, or camera change.
Output one 1024×1024 PNG, not a sprite sheet or pose board.
```

Describe deltas from the locked anchor, not from the prior generated frame. Keep a frame list with motion phase, planted foot, arm/leg direction, and intended duration so adjacent poses remain distinct.

## Targeted correction

Preserve the failed frame and create a new attempt. Reuse both locked references and the original pose instruction. Add exactly one measured repair, such as “restore cap silhouette,” “add 16 pixels of padding above the hair,” or “return the planted shoe to the shared baseline.” Do not broaden the redesign.

Stop immediately for ambiguous identity, costume, or pose intent. Permit at most two generative retries for a frame; after the second failed attempt, present the versions and request user judgment. Never rewrite the installed skill from a correction outcome.
