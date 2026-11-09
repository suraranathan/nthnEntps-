#!/usr/bin/env python3
"""Package the small proot runtime from a custom bootstrap for existing installs."""

import argparse
import posixpath
import zipfile
from pathlib import Path

REQUIRED = (
    "bin/proot",
    "libexec/proot/loader",
    "lib/libtalloc.so.2",
    "lib/libandroid-shmem.so",
)
OPTIONAL = ("libexec/proot/loader32",)


def package_runtime(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as zf:
        members = set(zf.namelist())
        links = {}
        for line in zf.read("SYMLINKS.txt").decode("utf-8").splitlines():
            if "←" not in line:
                continue
            target, link = line.rsplit("←", 1)
            links[posixpath.normpath(link.strip())] = target.strip()

        def content(path: str) -> bytes:
            current = path
            for _ in range(8):
                if current in members:
                    return zf.read(current)
                target = links.get(current)
                if target is None:
                    raise FileNotFoundError(f"required proot runtime file missing: {path}")
                if target.startswith("/data/data/com.nthn/files/usr/"):
                    current = target.removeprefix("/data/data/com.nthn/files/usr/")
                else:
                    current = posixpath.normpath(posixpath.join(posixpath.dirname(current), target))
                if current.startswith("../") or current.startswith("/"):
                    raise ValueError(f"proot runtime link escapes bootstrap: {path}")
            raise ValueError(f"proot runtime link cycle: {path}")

        for path in REQUIRED + tuple(path for path in OPTIONAL if path in members or path in links):
            target = destination / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content(path))
            target.chmod(0o755 if path.startswith(("bin/", "libexec/")) else 0o644)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    package_runtime(args.archive, args.destination)
