#!/usr/bin/env bash
# Publish the current @5dive/openagent version to npm using the stored
# automation token at /etc/5dive/connectors/npm.env (NPM_TOKEN=...).
# The token never touches the repo or a persistent ~/.npmrc — it lives only
# in a mode-600 temp userconfig that is removed on exit.
#
# Usage:  ./scripts/npm-publish.sh           # publish package.json's version
#         ./scripts/npm-publish.sh --dry-run # pack + auth check, no publish
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=/etc/5dive/connectors/npm.env
TOK=$(sudo sed -n 's/^NPM_TOKEN=//p' "$ENV_FILE")
[ -n "$TOK" ] || { echo "no NPM_TOKEN in $ENV_FILE" >&2; exit 1; }

NPMRC=$(mktemp); chmod 600 "$NPMRC"
trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOK" > "$NPMRC"

echo "auth: $(npm whoami --userconfig "$NPMRC")"
VER=$(node -p "require('./package.json').version")
echo "local version: $VER ; npm latest: $(npm view @5dive/openagent version 2>/dev/null || echo none)"

if [ "${1:-}" = "--dry-run" ]; then
  npm publish --userconfig "$NPMRC" --access public --dry-run
else
  npm publish --userconfig "$NPMRC" --access public
  echo "published @5dive/openagent@$VER"
fi
