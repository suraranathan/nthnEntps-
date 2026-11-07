#!/usr/bin/env bash
set -euo pipefail
version=3.12.11
archive="Python-${version}.tar.xz"
expected=c30bb24b7f1e9a19b11b55a546434f74e739bb4c271a3e3a80ff4380d49f7adb
workdir=/home/builder/termux-packages/.nthn-host-python
mkdir -p "$workdir"
cd "$workdir"
curl -fL --retry 3 "https://www.python.org/ftp/python/${version}/${archive}" -o "$archive"
printf '%s  %s\n' "$expected" "$archive" | sha256sum -c -
tar xf "$archive"
cd "Python-${version}"
./configure --prefix=/home/builder/.local/python312 --without-ensurepip --disable-test-modules
make -j2
make install
sudo ln -sf /home/builder/.local/python312/bin/python3.12 /usr/bin/python3.12
python3.12 --version
