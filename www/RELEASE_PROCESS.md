# www.klaudii.com — Release Process

## Overview

The marketing site at www.klaudii.com is hosted on **GitHub Pages** from the `gh-pages` branch.
Staging is served from the `klaudiihq/www` GitHub repo (also GitHub Pages).

## Architecture

- **Source files**: `www/` directory on the `main` branch (index.html, style.css, script.js, docs/)
- **Staging**: `klaudiihq/www` repo — served at `staging.klaudii.com`
- **Production branch**: `gh-pages` — served at `klaudii.com`
- **HTTPS**: Enforced via GitHub Pages settings

## Automated Deployment

Both staging and production are deployed automatically via GitHub Actions when `www/` changes are pushed.

### Staging (`staging.klaudii.com`)

Triggered by pushes to `main` that touch `www/`. Workflow: `.github/workflows/deploy-staging-www.yml`

- Clones `klaudiihq/www` via SSH deploy key (`WWW_DEPLOY_KEY` secret)
- Rsyncs `www/` into the repo (preserving the `CNAME` file)
- Commits and pushes any changes

### Production (`klaudii.com`)

Triggered by pushes to `stable` that touch `www/`. Workflow: `.github/workflows/release-www.yml`

- Uses `peaceiris/actions-gh-pages` to publish `www/` to the `gh-pages` branch
- Sets `CNAME` to `klaudii.com`

## Manual Deploy (if needed)

```bash
# Staging: push www/ to klaudiihq/www directly
git clone git@github.com:klaudiihq/www.git /tmp/www-repo
rsync -av --delete --exclude='.git' --exclude='CNAME' www/ /tmp/www-repo/
cd /tmp/www-repo && git add -A && git commit -m "Manual staging deploy" && git push

# Production: update gh-pages branch
git checkout gh-pages
git checkout main -- www/index.html www/style.css www/script.js www/docs/
cp -r www/* . && rm -rf www/
git add . && git commit -m "Deploy: <description>" && git push
git checkout main
```

GitHub Pages typically builds within 1-3 minutes after push. Check status:

```bash
gh api repos/klaudiihq/klaudii/pages/builds --jq '.[0] | {status, created_at}'
```
