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

    def test_packages_built_deb_contents_without_changing_bootstrap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            prefix = root / "stage/data/data/com.nthn/files/usr"
            for path, content in {
                "bin/proot": b"proot-binary",
                "libexec/proot/loader": b"loader-binary",
                "lib/libtalloc.so.2.4.2": b"talloc-binary",
                "lib/libandroid-shmem.so": b"shmem-binary",
            }.items():
                target = prefix / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            (prefix / "lib/libtalloc.so.2").symlink_to("libtalloc.so.2.4.2")
            destination = root / "runtime"
            package_runtime(root / "stage", destination)
            self.assertEqual((destination / "bin/proot").read_bytes(), b"proot-binary")
            self.assertEqual((destination / "lib/libtalloc.so.2").read_bytes(), b"talloc-binary")


if __name__ == "__main__":
    unittest.main()
