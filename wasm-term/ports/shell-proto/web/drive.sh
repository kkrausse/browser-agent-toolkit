#!/bin/sh
# Opens the prototype page in the shared Chrome through browser-control and prints its result as JSON.
#   web/drive.sh [query string, e.g. 'spin=0&arg=quick'] [session, default shell-proto]
here=$(cd "$(dirname "$0")" && pwd)
url="http://127.0.0.1:${PORT:-4797}/?$1"
script=$(mktemp /tmp/shell-proto-drive.XXXXXX.js)
sed "s|__URL__|$(printf %s "$url" | sed "s/&/\\\\&/g")|" "$here/drive.js" > "$script"
browser-control execute --json --session "${2:-shell-proto}" --file "$script"
rm -f "$script"
