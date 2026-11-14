"""Static-server privacy checks using only temporary files and loopback sockets."""

import contextlib
import errno
import http.client
import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SERVER_PATH = Path(__file__).resolve().parents[1] / "serve.py"
SPEC = importlib.util.spec_from_file_location("studio_serve", SERVER_PATH)
serve = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(serve)

# Independent fixture: adding any other file to the repository must not expose it.
PUBLIC_FILES = {
    "index.html": b"<html>diagnostic fixture</html>",
    "studio.html": b"<html>studio fixture</html>",
    "css/style.css": b"body { color: black; }",
    "js/app.js": b"// app fixture",
    "js/calibration.js": b"// calibration fixture",
    "js/diagnostics.js": b"// diagnostics fixture",
    "js/dualsense.js": b"// dualsense fixture",
    "js/effects.js": b"// effects fixture",
    "js/studio.js": b"// studio fixture",
    "js/visualizer.js": b"// visualizer fixture",
}


class StaticServerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "public"
        self.root.mkdir()
        for relative, content in PUBLIC_FILES.items():
            self.write_file(relative, content)
        # Silence only request logging; assertions still use unittest's own stream.
        self.log_capture = contextlib.redirect_stderr(io.StringIO())
        self.log_capture.__enter__()
        self.addCleanup(self.log_capture.__exit__, None, None, None)
        self.server = serve.create_server(self.root, port=0)
        self.worker = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.worker.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=5)
        self.assertFalse(self.worker.is_alive())

    def write_file(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def request(self, path, method="GET"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def assert_denied(self, path):
        for method in ("GET", "HEAD"):
            with self.subTest(path=path, method=method):
                status, _, body = self.request(path, method)
                self.assertEqual(status, 404)
                self.assertNotIn(b"synthetic private token", body)
                if method == "HEAD":
                    self.assertEqual(body, b"")

    def make_symlink(self, link, target, is_directory=False):
        try:
            link.symlink_to(target, target_is_directory=is_directory)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EPERM, errno.ENOSYS) or getattr(error, "winerror", None) == 1314:
                self.skipTest(f"Platform does not permit symlink creation: {error}")
            raise

    def stub_lstat(self, target, mode, attributes=0):
        original_lstat = Path.lstat

        def lstat(path, *args, **kwargs):
            if path == target:
                return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
            return original_lstat(path, *args, **kwargs)

        return patch.object(Path, "lstat", lstat)

    def test_allowed_pages_and_subresources_get_and_head(self):
        for relative, content in PUBLIC_FILES.items():
            for method in ("GET", "HEAD"):
                with self.subTest(path=relative, method=method):
                    status, headers, body = self.request("/" + relative, method)
                    self.assertEqual(status, 200)
                    self.assertEqual(body, content if method == "GET" else b"")
                    self.assertEqual(int(headers["Content-Length"]), len(content))
                    expected_type = {
                        ".html": "text/html", ".css": "text/css", ".js": "text/javascript"
                    }[Path(relative).suffix]
                    self.assertTrue(headers["Content-Type"].startswith(expected_type))

    def test_root_serves_studio_and_query_does_not_change_asset(self):
        for path in ("/", "/?v=1", "/studio.html?v=1", "/js/app.js?v=1"):
            with self.subTest(path=path):
                expected = PUBLIC_FILES["js/app.js" if path.startswith("/js/") else "studio.html"]
                status, _, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(body, expected)

    def test_private_runtime_file_is_not_served(self):
        self.write_file(".runtime/coach.html", b"synthetic private token")
        self.assert_denied("/.runtime/coach.html")

    def test_unknown_and_private_files_and_directories_are_not_served(self):
        private_files = (
            ".git/config", "sessions/session.json", ".upstream/preview.html",
            "Profiles/controller.json", "README.md", "serve.py", "private.html",
            "js/private.js", "css/private.css",
        )
        for path in private_files:
            self.write_file(path, b"synthetic private token")
            self.assert_denied("/" + path)
        for path in ("/missing.html", "/js/", "/css/", "/.git/", "/sessions/", "/.upstream/"):
            self.assert_denied(path)

    def test_raw_and_encoded_traversal_are_not_normalized_into_assets(self):
        self.write_file(".runtime/coach.html", b"synthetic private token")
        for path in (
            "/../studio.html", "/js/../studio.html", "/./studio.html",
            "/%2e/studio.html", "/js/%2e%2e/studio.html", "/js/%2E%2E%2Fstudio.html",
            "/%2e%2e/.runtime/coach.html", "/%252e%252e/.runtime/coach.html",
            "/%2eruntime/coach.html", "/js%2f..%2f.runtime%2fcoach.html",
            "/js\\..\\studio.html", "/js/%2e%2e%5cstudio.html",
            "/%73tudio.html", "/studio.html%00", "/studio.html/", "/studio.html:secret",
        ):
            self.assert_denied(path)

    def test_missing_allowlisted_file_is_not_served(self):
        (self.root / "studio.html").unlink()
        self.assert_denied("/studio.html")
        self.assert_denied("/")

    def test_directory_in_place_of_allowlisted_file_is_not_listed(self):
        (self.root / "studio.html").unlink()
        (self.root / "studio.html").mkdir()
        (self.root / "studio.html" / "private.txt").write_bytes(b"synthetic private token")
        self.assert_denied("/studio.html")

    def test_allowlisted_symlink_file_is_not_served(self):
        link = self.root / "studio.html"
        link.unlink()
        for target in (self.base / "outside.html", self.root / "private.html"):
            with self.subTest(target=target.name):
                target.write_bytes(b"synthetic private token")
                self.make_symlink(link, target)
                try:
                    self.assert_denied("/studio.html")
                    self.assert_denied("/")
                finally:
                    link.unlink()

    def test_allowlisted_symlink_parent_is_not_served(self):
        original = self.root / "js"
        original.rename(self.root / "original-js")
        for target in (self.base / "outside-js", self.root / "private-js"):
            with self.subTest(target=target.name):
                target.mkdir()
                (target / "app.js").write_bytes(b"synthetic private token")
                self.make_symlink(original, target, is_directory=True)
                try:
                    self.assert_denied("/js/app.js")
                finally:
                    original.unlink()

    def test_alias_above_configured_root_does_not_block_assets(self):
        # Simulate e.g. macOS /var -> /private/var without requiring symlink privileges.
        for mode, attributes in ((stat.S_IFLNK, 0), (stat.S_IFDIR, stat.FILE_ATTRIBUTE_REPARSE_POINT)):
            with self.subTest(mode=mode, attributes=attributes), self.stub_lstat(self.root.parent, mode, attributes):
                for relative in ("studio.html", "js/app.js"):
                    for method in ("GET", "HEAD"):
                        status, _, body = self.request("/" + relative, method)
                        self.assertEqual(status, 200)
                        self.assertEqual(body, PUBLIC_FILES[relative] if method == "GET" else b"")

    def test_symlink_and_reparse_metadata_at_or_below_root_are_denied(self):
        # Only lstat metadata is simulated; requests and file reads use real fixtures.
        for target in (self.root / "js" / "app.js", self.root / "js", self.root):
            for mode, attributes in ((stat.S_IFLNK, 0), (stat.S_IFDIR, stat.FILE_ATTRIBUTE_REPARSE_POINT)):
                with self.subTest(target=target.name, mode=mode, attributes=attributes), self.stub_lstat(target, mode, attributes):
                    self.assert_denied("/js/app.js")

    def test_server_binds_only_ipv4_loopback(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")


class PortTests(unittest.TestCase):
    def test_default_and_valid_ports(self):
        self.assertEqual(serve.parse_args([]).port, 8777)
        for value in ("1", "8777", "65535"):
            with self.subTest(port=value):
                self.assertEqual(serve.parse_args([value]).port, int(value))

    def test_invalid_ports_and_extra_arguments_fail_before_startup(self):
        for args in (["0"], ["-1"], ["65536"], ["word"], ["1.5"], [""], ["8777", "extra"], ["--bind", "0.0.0.0"]):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    serve.parse_args(args)
                self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
