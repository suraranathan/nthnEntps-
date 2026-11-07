#!/usr/bin/env python3
"""Verify the com.nthn APK and the custom ARM64 bootstrap embedded in it.

Usage:
  python3 scripts/verify_apk.py nthn-separate.apk [--aapt2 /path/to/aapt2]

Checks:
  * package id is com.nthn and label is nthn;
  * only arm64-v8a native code is packaged;
  * libtermux-bootstrap.so embeds a readable bootstrap ZIP;
  * the embedded bootstrap contains bash/apt/dpkg and no com.termux prefix;
  * the embedded bootstrap matches the separately built bootstrap when given
    with --bootstrap.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

REQUIRED_BOOTSTRAP_FILES = (
    "bin/bash",
    "bin/apt",
    "bin/apt-get",
    "bin/dpkg",
    "var/lib/dpkg/status",
    "SYMLINKS.txt",
)


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def find_aapt2(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    for candidate in ("aapt2", "aapt"):
        found = shutil.which(candidate)
        if found:
            return found
    return None


def badging(aapt2: str, apk: pathlib.Path) -> str:
    result = subprocess.run(
        [aapt2, "dump", "badging", str(apk)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"aapt2 dump badging failed: {result.stderr.strip()}")
    return result.stdout


def carve_embedded_zip(so_bytes: bytes) -> bytes:
    start = so_bytes.find(b"PK\x03\x04")
    if start < 0:
        fail("libtermux-bootstrap.so does not contain a ZIP local header")
    data = so_bytes[start:]
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0 or eocd + 22 > len(data):
        fail("embedded bootstrap is missing a ZIP end-of-central-directory")
    comment_len = struct.unpack_from("<H", data, eocd + 20)[0]
    end = eocd + 22 + comment_len
    if end > len(data):
        fail("embedded bootstrap ZIP comment extends past the native library")
    return data[:end]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=pathlib.Path)
    parser.add_argument("--aapt2")
    parser.add_argument("--bootstrap", type=pathlib.Path)
    args = parser.parse_args()

    apk = args.apk
    if not apk.is_file() or apk.stat().st_size == 0:
        fail(f"{apk} is missing or empty")

    print(f"apk: {apk} ({apk.stat().st_size} bytes)")
    print(f"sha256: {hashlib.sha256(apk.read_bytes()).hexdigest()}")

    aapt2 = find_aapt2(args.aapt2)
    if aapt2 is None:
        fail("aapt2/aapt not found; pass --aapt2")
    info = badging(aapt2, apk)
    if not re.search(r"^package: name='com\.nthn'", info, re.MULTILINE):
        fail("APK package id is not com.nthn")
    if not re.search(r"^application-label:'nthn'", info, re.MULTILINE):
        fail("APK application label is not nthn")
    if not re.search(r"^launchable-activity: name='com\.termux\.app\.NthnActivity'", info, re.MULTILINE):
        fail("APK does not launch the NTHN home dashboard")
    native = re.search(r"^native-code: (.+)$", info, re.MULTILINE)
    if native is None or native.group(1).strip() != "'arm64-v8a'":
        fail(f"APK native code is not arm64-v8a only: {native.group(1) if native else 'none'}")

    with zipfile.ZipFile(apk) as zf:
        bad = zf.testzip()
        if bad is not None:
            fail(f"corrupt APK member {bad!r}")
        names = zf.namelist()
        abi_dirs = sorted({name.split("/")[1] for name in names if name.startswith("lib/")})
        if abi_dirs != ["arm64-v8a"]:
            fail(f"unexpected native ABI directories: {abi_dirs}")
        so_name = "lib/arm64-v8a/libtermux-bootstrap.so"
        if so_name not in names:
            fail(f"missing {so_name}")
        so_bytes = zf.read(so_name)

    embedded = carve_embedded_zip(so_bytes)
    with zipfile.ZipFile(io.BytesIO(embedded)) as bz:
        bad = bz.testzip()
        if bad is not None:
            fail(f"corrupt embedded bootstrap member {bad!r}")
        bootstrap_names = set(bz.namelist())
        for required in REQUIRED_BOOTSTRAP_FILES:
            if required not in bootstrap_names:
                fail(f"embedded bootstrap is missing {required!r}")
        for name in bootstrap_names:
            if "com.termux" in name:
                fail(f"embedded bootstrap contains upstream com.termux path {name!r}")
        status = bz.read("var/lib/dpkg/status").decode("utf-8", "replace")
        if "Package: bash" not in status or "Package: apt" not in status:
            fail("embedded bootstrap dpkg status lacks bash/apt")
        if "Package: command-not-found" in status:
            fail("embedded bootstrap contains disabled command-not-found package")

    embedded_sha = hashlib.sha256(embedded).hexdigest()
    print(f"embedded bootstrap: {len(embedded)} bytes, sha256 {embedded_sha}")

    if args.bootstrap:
        expected = args.bootstrap.read_bytes()
        if embedded != expected:
            fail("embedded bootstrap does not match the separately built bootstrap")
        print("embedded bootstrap matches the built bootstrap byte-for-byte")

    print("APK verification passed")


if __name__ == "__main__":
    main()
