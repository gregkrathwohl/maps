#!/bin/sh
# Build and publish exactly dist/ to the gh-pages branch of origin.
set -e
cd "$(dirname "$0")/.."
node scripts/build.mjs
rm -rf .deploy && git worktree prune
git worktree add -f --detach .deploy >/dev/null
cd .deploy
git checkout -q --orphan gh-pages-tmp
git rm -rfq --cached . >/dev/null 2>&1 || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +   # empty the tree (keep .git)
cp -R ../dist/. .
git add -A -f      # -f: publish generated data even if .gitignore'd in the source repo
git commit -qm "Publish $(date -u +%Y-%m-%dT%H:%MZ)"
git push -qf origin HEAD:gh-pages
cd .. && git worktree remove --force .deploy && git branch -D gh-pages-tmp >/dev/null 2>&1 || true
echo "published"
