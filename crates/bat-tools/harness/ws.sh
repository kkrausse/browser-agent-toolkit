#!/bin/sh
# ws.sh <dir> <cmd...>: run cmd with <dir> mounted at /workspace (cwd /workspace)
dir=$(cd "$1" && pwd); shift
args=""
for d in /usr /bin /lib /lib64 /sbin /etc /home /tmp /var /opt /run /snap; do [ -e "$d" ] && args="$args --bind $d $d"; done
exec bwrap $args --dev /dev --proc /proc --bind "$dir" /workspace --chdir /workspace "$@"
