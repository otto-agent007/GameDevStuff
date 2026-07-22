# Motion Sources

Never infer missing timing or silently replace a source decoder. Intake records the source hash, decoder identity, frame diagnostics, and approval state.

## PNG sequence

```bash
node scripts/cli.mjs intake \
  --project-dir /absolute/path/character-project \
  --action walk \
  --kind png-sequence \
  --source-manifest /absolute/path/sequence.json
```

The manifest supplies explicit order and duration. Missing or invalid timing is an objective failure.

## GIF, APNG, and animated WebP

```bash
node scripts/cli.mjs intake \
  --project-dir /absolute/path/character-project \
  --action idle \
  --kind gif \
  --source /absolute/path/idle.gif
```

Change `--kind` to `apng` or `webp` as appropriate. Preserve frame delays, alpha, canvas offsets, blend, and disposal behavior. The pinned libvips cannot expose APNG animation pages, so APNG intake intentionally uses the package's explicit CRC-validated subframe compositor. Do not flatten the animation or substitute unvalidated chunks.

## MP4 and WebM

```bash
node scripts/cli.mjs intake \
  --project-dir /absolute/path/character-project \
  --action walk \
  --kind webm \
  --source /absolute/path/walk.webm \
  --ffmpeg /absolute/path/ffmpeg
```

Use the inspected FFmpeg executable and preserve source presentation timestamps. Missing, duplicate, or invalid timestamps are exit class `3`; never invent a default such as 100 ms per frame.

## Generated still

Start the handoff without claiming that an image exists:

```bash
node scripts/cli.mjs intake \
  --project-dir /absolute/path/character-project \
  --action unlock \
  --kind generated-still \
  --pose key-pose
```

This exits `2` with a canonical handoff. After the environment returns a real image, resume with the exact handoff, `--generated-image`, and explicit `--duration-ms`.

If ComfyUI is unavailable, do not wait for or require a restart. Record the generation step as `skipped/unavailable`, run the generated-still intake command above to create the canonical handoff, and return exit class `2`. Ask for an owner-supplied candidate and import it through that handoff. Do not fabricate an image, prompt history, model record, or success claim.
