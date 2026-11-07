#!/usr/bin/env python3
"""Isolate the Node.js host ICU build from Android cross-compile flags.

`build-bootstraps.sh` sets CFLAGS/CPPFLAGS/CXXFLAGS/LDFLAGS for the Android
target before invoking package builds. Node.js performs a host build of ICU in
the same shell, so those Android flags reach the host compiler and the ICU
configure step fails with "C compiler cannot create executables". Run the ICU
host build in a subshell with those variables removed; the parent shell keeps
them for the actual cross build.
"""

from __future__ import annotations

import pathlib
import sys

HEADER = (
    "termux_step_host_build() {\n"
    "\t######\n"
    "\t# Do host-build of ICU, which is required for nodejs\n"
    "\t######\n"
    "\tlocal ICU_VERSION=76.1\n"
)

HEADER_PATCHED = (
    "termux_step_host_build() {\n"
    "\t######\n"
    "\t# Do host-build of ICU, which is required for nodejs\n"
    "\t######\n"
    "\t(\n"
    "\t# The bootstrap builder sets cross-compilation flags before package\n"
    "\t# builds. The host ICU build must not inherit them.\n"
    "\tunset CFLAGS CPPFLAGS CXXFLAGS LDFLAGS\n"
    "\tlocal ICU_VERSION=76.1\n"
)

TAIL = (
    "\tmake -j $TERMUX_PKG_MAKE_PROCESSES install\n"
    "\n"
    "\n"
    "\t######\n"
    "\t# Download LLVM toolchain used by the upstream v8 project.\n"
)

TAIL_PATCHED = (
    "\tmake -j $TERMUX_PKG_MAKE_PROCESSES install\n"
    "\t)\n"
    "\n"
    "\n"
    "\t######\n"
    "\t# Download LLVM toolchain used by the upstream v8 project.\n"
)

HOST_CC = (
    "\texport CC=\"$TERMUX_HOST_LLVM_BASE_DIR/bin/clang\"\n"
    "\texport CXX=\"$TERMUX_HOST_LLVM_BASE_DIR/bin/clang++\"\n"
    "\texport LD=\"$TERMUX_HOST_LLVM_BASE_DIR/bin/clang++\"\n"
)

HOST_CC_PATCHED = (
    "\texport CC=\"gcc\"\n"
    "\texport CXX=\"g++\"\n"
    "\texport LD=\"g++\"\n"
)


def main() -> None:
    path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "packages/packages/nodejs/build.sh")
    text = path.read_text()
    if HEADER_PATCHED in text:
        print("nodejs host build already patched")
        return
    if HEADER not in text:
        raise SystemExit(f"nodejs host build header not found in {path}")
    text = text.replace(HEADER, HEADER_PATCHED, 1)
    if TAIL not in text:
        raise SystemExit(f"nodejs ICU install block not found in {path}")
    text = text.replace(TAIL, TAIL_PATCHED, 1)
    if HOST_CC in text:
        text = text.replace(HOST_CC, HOST_CC_PATCHED, 1)
    elif HOST_CC_PATCHED not in text:
        raise SystemExit(f"nodejs host compiler block not found in {path}")
    path.write_text(text)
    print(f"patched nodejs host build in {path}")


if __name__ == "__main__":
    main()
