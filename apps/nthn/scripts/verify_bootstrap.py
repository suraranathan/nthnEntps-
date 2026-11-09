#!/usr/bin/env python3
"""Verify a Termux-style bootstrap ZIP produced for com.nthn.

Checks, without extracting the whole archive:
  * archive is non-empty and readable;
  * required shell/package-manager/terminal paths exist;
  * no upstream com.termux prefix is present;
  * dpkg status lists the expected packages and omits disabled ones;
  * bin/bash is an ARM64 Android executable;
  * required symlinks are declared.

Usage: python3 scripts/verify_bootstrap.py packages/bootstrap-aarch64.zip
"""

from __future__ import annotations

import hashlib
import pathlib
import posixpath
import stat
import struct
import sys
import zipfile

REQUIRED_FILES = (
    "bin/bash",
    "bin/apt",
    "bin/apt-get",
    "bin/dpkg",
    "bin/git",
    "bin/login",
    "bin/node",
    "bin/proot",
    "bin/pkg",
    "var/lib/dpkg/status",
    "SYMLINKS.txt",
)

REQUIRED_PACKAGES = (
    "apt",
    "bash",
    "coreutils",
    "dpkg",
    "git",
    "nodejs",
    "proot",
    "python",
    "termux-core",
    "termux-exec",
    "termux-tools",
)

FORBIDDEN_PACKAGES = ("command-not-found",)

REQUIRED_SYMLINKS = ("bin/sh", "bin/python", "bin/python3")

ELF_MACHINE_AARCH64 = 183


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_member(zf: zipfile.ZipFile, name: str) -> bytes:
    try:
        with zf.open(name) as handle:
            return handle.read()
    except KeyError:
        fail(f"missing archive member {name!r}")


def parse_symlinks(text: str) -> dict[str, str]:
    """Map link path -> raw target from the archive's SYMLINKS.txt."""
    links: dict[str, str] = {}
    for line in text.splitlines():
        if "←" not in line:
            continue
        target, link = line.rsplit("←", 1)
        link = link.strip()
        if link.startswith("./"):
            link = link[2:]
        links[link] = target
    return links


def link_target_exists(link: str, links: dict[str, str], names: set[str]) -> bool:
    seen: set[str] = set()
    current = link
    while current in links:
        if current in seen:
            return False
        seen.add(current)
        target = links[current]
        if target.startswith("/"):
            return False
        current = posixpath.normpath(posixpath.join(posixpath.dirname(current), target))
    return current in names


def elf_machine(data: bytes) -> int:
    if len(data) < 20 or data[:4] != b"\x7fELF":
        fail("bin/bash is not an ELF file")
    endian = "<" if data[5] == 1 else ">"
    return struct.unpack_from(endian + "H", data, 18)[0]


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: verify_bootstrap.py <bootstrap-aarch64.zip>")

    path = pathlib.Path(sys.argv[1])
    if not path.is_file() or path.stat().st_size == 0:
        fail(f"{path} is missing or empty")

    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f"archive: {path} ({path.stat().st_size} bytes)")
    print(f"sha256: {digest}")

    with zipfile.ZipFile(path) as zf:
        bad = zf.testzip()
        if bad is not None:
            fail(f"corrupt archive member {bad!r}")

        names = set(zf.namelist())
        symlinks_text = read_member(zf, "SYMLINKS.txt").decode("utf-8", "replace")
        links = parse_symlinks(symlinks_text)
        for required in REQUIRED_FILES:
            if required in names:
                continue
            if required in links and link_target_exists(required, links, names):
                continue
            fail(f"missing required file {required!r}")

        for name in names:
            if "com.termux" in name:
                fail(f"upstream com.termux path leaked into archive: {name!r}")

        status = read_member(zf, "var/lib/dpkg/status").decode("utf-8", "replace")
        installed = {
            line[len("Package: "):].strip()
            for line in status.splitlines()
            if line.startswith("Package: ")
        }
        for package in REQUIRED_PACKAGES:
            if package not in installed:
                fail(f"required package {package!r} is not installed")
        for package in FORBIDDEN_PACKAGES:
            if package in installed:
                fail(f"disabled package {package!r} must not be installed")

        bash = read_member(zf, "bin/bash")
        if elf_machine(bash) != ELF_MACHINE_AARCH64:
            fail("bin/bash is not an ARM64 (aarch64) ELF executable")
        if stat.S_IMODE(zf.getinfo("bin/bash").external_attr >> 16) & 0o111 == 0:
            fail("bin/bash is not executable")

        for target in REQUIRED_SYMLINKS:
            if target not in links:
                fail(f"missing symlink declaration for {target!r}")

        print(f"installed packages: {len(installed)}")
        print(f"bash ELF machine: aarch64 ({ELF_MACHINE_AARCH64})")
        print("bootstrap verification passed")


if __name__ == "__main__":
    main()
