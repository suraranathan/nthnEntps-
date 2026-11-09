import pathlib
import tempfile
import unittest
import zipfile

from scripts.package_proot_runtime import package_runtime


class PackageProotRuntimeTest(unittest.TestCase):
    def test_resolves_bootstrap_symlinks_into_installable_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            archive = root / "bootstrap.zip"
            destination = root / "runtime"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("bin/proot", b"proot-binary")
                zf.writestr("libexec/proot/loader", b"loader-binary")
                zf.writestr("lib/libtalloc.so.2.4.2", b"talloc-binary")
                zf.writestr("lib/libandroid-shmem.so", b"shmem-binary")
                zf.writestr("SYMLINKS.txt", "libtalloc.so.2.4.2←./lib/libtalloc.so.2\n")
            package_runtime(archive, destination)
            self.assertEqual((destination / "bin/proot").read_bytes(), b"proot-binary")
            self.assertEqual((destination / "libexec/proot/loader").read_bytes(), b"loader-binary")
            self.assertEqual((destination / "lib/libtalloc.so.2").read_bytes(), b"talloc-binary")
            self.assertEqual((destination / "lib/libandroid-shmem.so").read_bytes(), b"shmem-binary")


if __name__ == "__main__":
    unittest.main()
