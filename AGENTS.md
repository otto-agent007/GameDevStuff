# Repository instructions

## Durable game-asset gate

Every generated or approved game asset must be copied immediately from tool output, chat storage, `/tmp`, or a Codex scratch directory into a named persistent project asset directory. Preserve the canonical source, prompt/contract, anchor and matrix references, correction inputs, runtime exports, metadata, manifest, and SHA-256 hashes needed to reproduce or verify it.

An asset milestone is not complete until all intended files are audited for tracked, untracked, and ignored state; committed; pushed; and verified on the exact remote commit. Use Git LFS or a GitHub Release for binaries that cannot live in ordinary Git, and verify the remote package checksum. A sandbox download link, chat-visible image, local ZIP, or local-only commit is not durable storage.

Before reporting completion, prove a clean checkout can restore the assets using only remote durable sources and pass validation. Report the repository, branch, commit SHA, PR or release URL, package checksum, asset count, restore result, and every remaining untracked or ignored file. If remote persistence is blocked, report `locally produced, not durably saved`; never call the milestone complete.
