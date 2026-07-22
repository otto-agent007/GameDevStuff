# Third-Party Software and Donor Review

This file records direct dependencies and reviewed donor boundaries for the
GameDevStuff character-animation workflow. The npm package excludes
`node_modules`, test fixtures, browser downloads, private runs, and generated
media.

## Runtime and development dependencies

| Dependency | License | Use | Distribution disposition |
|---|---|---|---|
| commander 15.0.0 | MIT | CLI parsing | Source dependency declared in the lockfile; not vendored. |
| sharp 0.35.3 | Apache-2.0 | Lossless image decoding and encoding | Source dependency declared in the lockfile; prebuilt libvips components retain their upstream LGPL and other notices and are not included by `npm pack`. |
| @playwright/test 1.61.1 | Apache-2.0 | Frame Studio browser tests | Development-only dependency. Version 1.61.1 excludes the certificate-verification vulnerability affecting versions below 1.55.1. Downloaded browsers and test artifacts are excluded from `npm pack` and releases. |

## Selective donor policy

The exact repository commits, licenses, adopted concepts, rejected behavior,
and copied-file inventory live in
`references/donors/game-character-animation.json`. Every current donor entry is
`concept-only` with an empty copied-file list. If code is later copied or
materially adapted, update that ledger before the code change and add the
required per-file provenance and license notice here.

## Public acceptance fixture

The Clockwork Courier artwork and motion data under
`skills/game-character-pipeline/examples/clockwork-courier/` were created
originally for GameDevStuff. No donor pixels or private production assets are
included. GameDevStuff dedicates those fixture assets to the public domain
under CC0-1.0 for testing, examples, and downstream interoperability.
