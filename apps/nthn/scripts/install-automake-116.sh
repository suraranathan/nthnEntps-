#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update -qq
sudo apt-get install -y pkgconf
test -s /usr/share/aclocal/pkg.m4
cd /tmp
curl -fL --retry 3 -o automake-1.16.5.tar.xz https://ftp.gnu.org/gnu/automake/automake-1.16.5.tar.xz
printf '%s  %s\n' 'f01d58cd6d9d77fbdca9eb4bbd5ead1988228fdb73d6f7a201f5f8d6b118b469' automake-1.16.5.tar.xz | sha256sum -c -
tar -xf automake-1.16.5.tar.xz
cd automake-1.16.5
./configure --prefix=/usr/local
make -j2
sudo make install
# Some upstream tarballs (for example libtirpc) ship INSTALL as an absolute
# symlink to /usr/share/automake-1.16/INSTALL. Populate that system path so
# automake can resolve those files inside the package-builder container.
sudo mkdir -p /usr/share/automake-1.16
sudo cp -a /usr/local/share/automake-1.16/. /usr/share/automake-1.16/
test -s /usr/share/automake-1.16/INSTALL
/usr/local/bin/automake-1.16 --version
/usr/local/bin/aclocal-1.16 --version
