#!/bin/sh
# Build and publish dist/ to the gh-pages branch of origin.
set -e
cd "$(dirname "$0")/.."
node scripts/build.mjs
rm -rf .deploy && git worktree prune
git worktree add -f --detach .deploy >/dev/null
cd .deploy
git checkout --orphan gh-pages-tmp >/dev/null 2>&1
git rm -rq . >/dev/null 2>&1 || true
cp -R ../dist/. .
git add -A
git commit -qm "Publish $(date -u +%Y-%m-%dT%H:%MZ)"
git push -f origin HEAD:gh-pages
cd .. && git worktree remove --force .deploy
echo "published"
