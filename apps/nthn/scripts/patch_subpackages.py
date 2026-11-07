#!/usr/bin/env python3
"""Force the ncurses-ui-libs subpackage to be built.

`build-bootstraps.sh` uses `--no-build-unneeded-subpackages`, which only checks
whether a subpackage is a dependency of its parent. `python` depends on
`ncurses-ui-libs`, but `ncurses` itself does not, so the subpackage is skipped
and bootstrap extraction later fails with "No deb file found for package
'ncurses-ui-libs'". Keep the size-reduction flag for all other subpackages and
force this one.
"""

from __future__ import annotations

import pathlib
import sys

OLD = (
    '\t\t\t[ "$TERMUX_PARENT_DEPEND_ON_SUBPKG" = "false" ] && '
    '[ "$TERMUX_PARENT_BUILD_DEPEND_ON_SUBPKG" = "false" ]; then\n'
)

NEW = (
    '\t\t\t[ "$TERMUX_PARENT_DEPEND_ON_SUBPKG" = "false" ] && '
    '[ "$TERMUX_PARENT_BUILD_DEPEND_ON_SUBPKG" = "false" ] &&\n'
    '\t\t\t[ "$SUB_PKG_NAME" != "ncurses-ui-libs" ]; then\n'
)


def main() -> None:
    path = pathlib.Path(
        sys.argv[1]
        if len(sys.argv) > 1
        else "packages/scripts/build/termux_create_debian_subpackages.sh"
    )
    text = path.read_text()
    if NEW in text:
        print("ncurses-ui-libs subpackage already forced")
        return
    if OLD not in text:
        raise SystemExit(f"subpackage dependency check not found in {path}")
    text = text.replace(OLD, NEW, 1)
    path.write_text(text)
    print(f"forced ncurses-ui-libs subpackage in {path}")


if __name__ == "__main__":
    main()
