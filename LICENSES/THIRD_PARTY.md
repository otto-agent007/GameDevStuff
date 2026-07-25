# Third-Party Software and Donor Review

This file records direct dependencies and reviewed donor boundaries for the
GameDevStuff character-animation workflow. The npm package excludes
`node_modules`, test fixtures, browser downloads, private runs, and generated
media.

## Runtime and development dependencies

| Dependency                  | License                          | Use                                  | Distribution disposition                                                                                                                                                   |
| --------------------------- | -------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @eslint/js 10.0.1           | MIT                              | ESLint recommended rules             | Development-only dependency declared in the root lockfile; not included by `npm pack`.                                                                                     |
| @img/sharp-win32-x64 0.35.3 | Apache-2.0 AND LGPL-3.0-or-later | Windows Sharp native runtime         | Root optional workspace pin retained for Windows installs; it must match `sharp` and is not included by `npm pack`.                                                        |
| @playwright/test 1.62.0     | Apache-2.0                       | Frame Studio browser tests           | Development-only dependency. Downloaded browsers and test artifacts are excluded from `npm pack` and releases.                                                             |
| commander 15.0.0            | MIT                              | CLI parsing                          | Source dependency declared in the lockfile; not vendored.                                                                                                                  |
| eslint 10.8.0               | MIT                              | Static analysis                      | Development-only dependency declared in the root lockfile; not included by `npm pack`.                                                                                     |
| fflate 0.8.3                | MIT                              | ZIP archive processing               | Runtime source dependency declared in the Pixel Sprite Pipeline lockfile; not vendored.                                                                                    |
| globals 17.7.0              | MIT                              | ESLint global definitions            | Development-only dependency declared in the root lockfile; not included by `npm pack`.                                                                                     |
| prettier 3.9.6              | MIT                              | Repository formatting                | Development-only dependency declared in the root lockfile; not included by `npm pack`.                                                                                     |
| sharp 0.35.3                | Apache-2.0                       | Lossless image decoding and encoding | Runtime source dependency declared in the workspace lockfile; prebuilt libvips components retain their upstream LGPL and other notices and are not included by `npm pack`. |
| tar-stream 3.2.0            | MIT                              | TAR archive processing               | Runtime source dependency declared in the Pixel Sprite Pipeline lockfile; not vendored.                                                                                    |
| yaml 2.9.0                  | ISC                              | YAML configuration parsing           | Runtime source dependency declared in the Pixel Sprite Pipeline lockfile; not vendored.                                                                                    |

## Selective donor policy

The exact repository commits, licenses, adopted concepts, rejected behavior,
and copied-file inventory live in
`references/donors/game-character-animation.json`. Every current donor entry is
`concept-only` with an empty copied-file list. If code is later copied or
materially adapted, update that ledger before the code change and add the
required per-file provenance and license notice here.

## Public acceptance fixture

The Clockwork Courier artwork and motion data under
`integration/fixtures/clockwork-courier/` were created
originally for GameDevStuff. No donor pixels or private production assets are
included. GameDevStuff dedicates those fixture assets to the public domain
under CC0-1.0 for testing, examples, and downstream interoperability.
