# www.klaudii.com — Release Process

## Overview

The marketing site at www.klaudii.com is hosted on **GitHub Pages** from the `gh-pages` branch.

## Architecture

- **Source files**: `www/` directory on the `main` branch (index.html, style.css, script.js, docs/)
- **Deploy branch**: `gh-pages` (root of this branch = the site)
- **Custom domain**: www.klaudii.com (CNAME record in `gh-pages` branch)
- **HTTPS**: Enforced via GitHub Pages settings

## Deploy Steps

Changes to `www/` on `main` are **not** automatically deployed. You must manually update the `gh-pages` branch:

```bash
# From the main worktree
git checkout gh-pages
git checkout main -- www/index.html www/style.css www/script.js www/docs/
cp -r www/* .
rm -rf www/
git add .
git commit -m "Deploy: <description of changes>"
git push
git checkout main
```

GitHub Pages typically builds within 1-3 minutes after push. Check status:

```bash
gh api repos/klaudiihq/klaudii/pages/builds --jq '.[0] | {status, created_at}'
```

## TODO

- [ ] Set up GitHub Actions workflow to auto-deploy `www/` to `gh-pages` on push to `main`
- [ ] Add cache-busting for CSS/JS (query string or content hash)
- [ ] Consider migrating to deploy from `main` branch with `/www` as source directory
