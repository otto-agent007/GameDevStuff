# Pixel Snapper Integration

The pipeline first checks `PIXEL_SNAPPER_BIN`, then `snapper.executable` from the project profile. The default executable is `spritefusion-pixel-snapper`. Install the supported tool using its official package instructions.

For every frame, the adapter invokes the executable without a shell using this exact argument contract:

```text
spritefusion-pixel-snapper <INPUT> <OUTPUT> 16 [OPTIONS]
```

`16` is always the third positional argument. Profile `snapper.args` are appended as options; a legacy `16` entry is ignored so it cannot be passed twice. The adapter leaves source files untouched and writes each snapped image separately as `<source-name>-snapped.png`.

When the executable is unavailable, the pipeline writes `pixel-snapper-handoff.json` in the requested output directory. It records the original source paths, expected output names, exact command template, and resume command. Run Pixel Snapper on every listed input, save the resulting files using the exact `expectedOutputs` names, then run `resumeCommand`. Do not rename, crop, or overwrite source frames between snapping and normalization.
