#!/usr/bin/env bash
# Installs Playwright's WebKit build for the smoke test, entirely inside the
# project: the browser under vendor/playwright-browsers, and the shared
# libraries it needs that this machine lacks under vendor/webkit-syslibs
# (Ubuntu packages downloaded and unpacked there; nothing is installed
# system-wide, no sudo). Linux only. Run again after a Playwright upgrade.
set -euo pipefail
web="$(cd "$(dirname "$0")/.." && pwd)"
vendor="$(cd "$web/../vendor" && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="$vendor/playwright-browsers"
libs="$vendor/webkit-syslibs"

cd "$web"
bun install
# Its host check fails when system libraries are missing; the download has already happened by then.
bunx playwright install webkit >/dev/null 2>&1 || true
wpe="$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/webkit-*/minibrowser-wpe | tail -1)"

missing() {
  find -L "$wpe" "$libs/lib" \( -name '*.so*' -o -type f -perm -u+x \) 2>/dev/null \
    | { LD_LIBRARY_PATH="$wpe/lib:$wpe/sys/lib:$libs/lib" xargs ldd 2>/dev/null || true; } | awk '/not found/ {print $1}' | sort -u
}

unpack() {
  for deb in "$libs"/debs/*.deb; do dpkg-deb -x "$deb" "$libs/root"; done
  # One flat directory of links: what LD_LIBRARY_PATH points at. Plugins (media codecs,
  # spelling back ends) are left out: the smoke test needs neither, and each drags in more.
  find "$libs/root" -name '*.so*' \( -type f -o -type l \) -path '*/lib/*' ! -path '*/gstreamer-1.0/*' ! -path '*/enchant-2/*' -exec ln -sf {} "$libs/lib/" \;
}

mkdir -p "$libs/debs" "$libs/root" "$libs/lib"
# Not a link dependency: GLib loads TLS support as a module (smoke.sh points GIO_EXTRA_MODULES at it).
# Without it WebKit cannot open https pages at all.
(cd "$libs/debs" && apt-get download glib-networking >/dev/null)
unpack
for round in 1 2 3 4 5; do
  need="$(missing)"
  [ -z "$need" ] && break
  for lib in $need; do
    package="$(awk -v lib="$lib" '$1 == lib {print $2; exit}' "$web/webkit/packages.txt")"
    if [ -z "$package" ]; then echo "no package known for $lib (add it to web/webkit/packages.txt)" >&2; exit 1; fi
    (cd "$libs/debs" && apt-get download "$package" >/dev/null)
  done
  unpack
done
left="$(missing)"
if [ -n "$left" ]; then echo "still missing: $left" >&2; exit 1; fi
# The bundle's MiniBrowser wrapper replaces LD_LIBRARY_PATH with its own lib and sys/lib,
# so the extra libraries are linked into sys/lib (never over one the bundle ships).
for lib in "$libs"/lib/*; do
  [ -e "$wpe/sys/lib/$(basename "$lib")" ] || ln -s "$(readlink -f "$lib")" "$wpe/sys/lib/$(basename "$lib")"
done
echo "WebKit ready: $wpe"
