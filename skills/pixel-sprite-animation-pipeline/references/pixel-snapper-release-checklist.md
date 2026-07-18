# Pixel Snapper immutable release checkpoint

Before dispatching `.github/workflows/pixel-snapper-release.yml`:

1. In the GameDevStuff repository settings, enable immutable releases and confirm the organization does not override that setting.
2. Create a fine-grained token with read-only repository Administration permission. Store it as the repository Actions secret `IMMUTABLE_RELEASES_TOKEN`. Do not grant Contents write to this token.
3. Confirm the approved upstream tag peels to the full approved source commit. A matching branch or abbreviated commit is insufficient.
4. Dispatch the workflow with `immutable_releases_confirmed` checked. The preflight job calls `GET /repos/{owner}/{repo}/immutable-releases` using the narrow token and stops unless `enabled` is exactly `true`.
5. Do not approve or rerun publication if the preflight fails. Correct the repository setting or token first.

After `gh release create`, the workflow independently requires GitHub CLI release field `isImmutable` to be `true`, then verifies the public checksums, metadata, manifest, compliance files, all five archives, and embedded target metadata without executing downloaded binaries.

The immutable-tag checkpoint is satisfied: upstream `v1.0.0` peels to the approved release pin `5743009265051098831ad7298092072325d1149b`, used by GameDevStuff release tag `pixel-snapper-v1.0.0-commit.5743009`. Publication remains a later manual action; do not dispatch or publish until separately authorized.
