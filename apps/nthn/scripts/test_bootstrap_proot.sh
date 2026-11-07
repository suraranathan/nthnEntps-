#!/usr/bin/env bash
# Run a Termux-style ARM64 bootstrap on an ARM64 Android device using proot.
#
# This is a real execution test of the bootstrap userspace, not a simulation.
# It does not install the APK; it binds an extracted bootstrap to the prefix the
# app will use and runs the actual ARM64 binaries.
#
# Usage (inside Termux on the target device):
#   scripts/test_bootstrap_proot.sh packages/bootstrap-aarch64.zip
#
# For an upstream com.termux bootstrap, set NTHN_TEST_PREFIX:
#   NTHN_TEST_PREFIX=/data/data/com.termux/files scripts/test_bootstrap_proot.sh bootstrap-aarch64.zip
#
# Requires: bash, proot, python3, unzip, dpkg-deb.
set -euo pipefail

zip_path=${1:?usage: test_bootstrap_proot.sh <bootstrap-aarch64.zip>}
zip_path=$(readlink -f "$zip_path")
[ -s "$zip_path" ] || { echo "missing bootstrap archive: $zip_path" >&2; exit 1; }

prefix=${NTHN_TEST_PREFIX:-/data/data/com.nthn/files}
prefix=${prefix%/}

root=$(mktemp -d "${TMPDIR:-/tmp}/nthn-bootstrap.XXXXXX")
deb_dir=$(mktemp -d "${TMPDIR:-/tmp}/nthn-deb.XXXXXX")
cleanup() { rm -rf "$root" "$deb_dir"; }
trap cleanup EXIT

mkdir -p "$root/usr"
unzip -q "$zip_path" -d "$root/usr"
touch "$root/.nthn-proot-root"

python3 - "$root/usr" <<'PY'
import os
import sys

usr = sys.argv[1]
with open(os.path.join(usr, "SYMLINKS.txt"), encoding="utf-8") as handle:
    for line in handle:
        line = line.rstrip("\n")
        if "\u2190" not in line:
            continue
        target, link = line.split("\u2190", 1)
        link = link[2:] if link.startswith("./") else link
        path = os.path.join(usr, link)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        os.symlink(target, path)
PY

mkdir -p "$root/usr/home" "$root/usr/tmp"

# Build a tiny package whose data path matches the bootstrap prefix. Installing
# it exercises dpkg extraction and the dpkg database inside the bound root.
pkg="$deb_dir/pkg"
mkdir -p "$pkg/DEBIAN" "$pkg$prefix/usr/share/nthn-test"
chmod 755 "$pkg" "$pkg/DEBIAN"
printf 'hello from nthn package\n' > "$pkg$prefix/usr/share/nthn-test/hello.txt"
cat > "$pkg/DEBIAN/control" <<'EOF'
Package: nthn-test
Version: 1.0
Architecture: all
Maintainer: nthn <nthn@example.invalid>
Description: Local package installation test
EOF
chmod 644 "$pkg/DEBIAN/control"
dpkg-deb --build "$pkg" "$deb_dir/nthn-test.deb" >/dev/null

script_template=$(cat <<'EOS'
test -f @PREFIX@/.nthn-proot-root || { echo "PROOT_BIND_FAILED"; exit 99; }
export HOME=@PREFIX@/usr/home
export PATH=@PREFIX@/usr/bin:/system/bin
export TMPDIR=@PREFIX@/usr/tmp
export LD_LIBRARY_PATH=@PREFIX@/usr/lib
set -u
fail=0
run() { echo "== $* =="; "$@" || fail=1; }
run pwd
run whoami
run uname -m
run ls @PREFIX@/usr/bin
run bash --version
run apt --version
run dpkg --version
run python --version
run node --version
run git --version
echo "== filesystem =="
mkdir -p "$HOME/nthn-test" && echo persisted > "$HOME/nthn-test/file.txt"
cat "$HOME/nthn-test/file.txt"
test -f "$HOME/nthn-test/file.txt" || fail=1
rm -f "$HOME/nthn-test/file.txt"
echo "== package install =="
dpkg -i /nthn-test-deb/nthn-test.deb || fail=1
cat @PREFIX@/usr/share/nthn-test/hello.txt || fail=1
dpkg -s nthn-test | head -5 || fail=1
dpkg --purge nthn-test || fail=1
echo "== terminal =="
printf 'interactive-input-ok\n' | cat
exit "$fail"
EOS
)

script=${script_template//@PREFIX@/$prefix}

set +e
proot --link2symlink \
  -b "$root:$prefix" \
  -b "$deb_dir:/nthn-test-deb" \
  -b /dev -b /proc -b /sys \
  -w "$prefix/usr/home" \
  "$prefix/usr/bin/bash" --noprofile --norc -c "$script"
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "BOOTSTRAP RUNTIME TEST PASSED"
else
  echo "BOOTSTRAP RUNTIME TEST FAILED (exit $status)" >&2
fi
exit "$status"
