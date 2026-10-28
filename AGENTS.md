# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Single production deployment

Merge all features to main before packaging. Build only from clean current origin/main with `node scripts/deploy/stage-release.cjs <release-path>`. Activate only with `node scripts/deploy/activate-release.cjs --source <clean-main-worktree> --release <release-path> --activate`. The global lock, current-main equality, ancestry, hashes and feature checks are mandatory. Never activate a feature branch or use task-local deploy scripts. Update desktop frontend together with server. Interrupt managed sessions before stopping a service; never abandon provider children. Do not enable historical release scheduled tasks.
