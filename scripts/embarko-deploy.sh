#!/usr/bin/env bash
# Package the committed files and deploy them to Embarko (from the HireDrive runbook).
#   scripts/embarko-deploy.sh <app-name>            deploy HEAD
#   DRY_RUN=1 scripts/embarko-deploy.sh <app-name>  build + check the archive, upload nothing
# Token: $DEPLOY_TOKEN, else line 1 of ~/.embarko/credentials. It is never printed.
set -euo pipefail

APP="${1:?usage: $0 <app-name>}"
API="https://ship.embarko.ai"
TOKEN="${DEPLOY_TOKEN:-$(head -1 "$HOME/.embarko/credentials" 2>/dev/null || true)}"
[ -n "$TOKEN" ] || [ "${DRY_RUN:-}" = 1 ] || { echo "No token: set DEPLOY_TOKEN or put it on line 1 of ~/.embarko/credentials" >&2; exit 1; }

# The token goes to curl on stdin, so it never appears in the process list.
ecurl() { printf 'oauth2-bearer = "%s"\n' "$TOKEN" | curl -sS -K - "$@"; }

cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Uncommitted changes: commit first (git archive ships HEAD only)." >&2; exit 1; }
VERSION="$(git rev-parse --short HEAD)"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Tracked files only. Tests and local helpers are not needed to run the app.
git archive --format=tar.gz -o "$TMP/app.tar.gz" HEAD -- . ':(exclude).claude' ':(exclude).env.example' ':(exclude)tests' ':(exclude)scripts/viasocket-check.mjs' ':(exclude)scripts/embarko-deploy.sh'

LIST="$(tar -tzf "$TMP/app.tar.gz")"
if echo "$LIST" | grep -E '(^|/)\.env(\..*)?$|(^|/)node_modules/|^dist/|^data/|(^|/)\.git/'; then
  echo "Refusing to upload: forbidden file(s) above are in the archive." >&2; exit 1
fi
echo "$LIST" | grep -qx 'package.json'      || { echo "package.json is not at the archive root." >&2; exit 1; }
echo "$LIST" | grep -qx 'package-lock.json' || echo "WARNING: no package-lock.json in the archive (installs are less reliable)." >&2
echo "$LIST" | grep -qx 'embarko.json'      || echo "WARNING: no embarko.json in the archive (the 5-minute schedule would be missing)." >&2
echo "Archive: $(echo "$LIST" | grep -vc '/$') files, $(du -h "$TMP/app.tar.gz" | cut -f1), version $VERSION"
[ "${DRY_RUN:-}" = 1 ] && { echo "$LIST"; echo "DRY_RUN: nothing uploaded."; exit 0; }

echo "Uploading to $API/apps as $APP ..."
ecurl -m 180 -w '\nHTTP %{http_code}\n' -X POST "$API/apps" \
  -H "X-App-Name: $APP" -H 'X-Agent-Name: claude-code' -H "X-App-Version: $VERSION" \
  -F "source=@$TMP/app.tar.gz"

echo "Waiting for the build ..."
for _ in $(seq 1 60); do
  R="$(ecurl -m 20 "$API/apps/$APP/status" || true)"
  S="$(echo "$R" | grep -o '"status":"[a-z_]*"' | head -1 | cut -d'"' -f4)"
  case "$S" in
    live)    echo "$R"; exit 0 ;;
    failed|crashed|not_deployed)
             echo "$R"; echo "--- logs:"; ecurl -m 20 "$API/apps/$APP/logs?stream=stderr" | head -c 4000; echo; exit 1 ;;
  esac
  sleep 10
done
echo "Still not final after 10 minutes: check $API/apps/$APP/status" >&2; exit 1
