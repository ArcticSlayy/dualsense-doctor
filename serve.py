#!/usr/bin/env python3
"""Serve only DualSense Studio's public browser assets on IPv4 loopback."""

import argparse
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import stat


ASSETS = {
    "/index.html": "text/html; charset=utf-8",
    "/studio.html": "text/html; charset=utf-8",
    "/css/style.css": "text/css; charset=utf-8",
    "/js/app.js": "text/javascript; charset=utf-8",
    "/js/calibration.js": "text/javascript; charset=utf-8",
    "/js/diagnostics.js": "text/javascript; charset=utf-8",
    "/js/dualsense.js": "text/javascript; charset=utf-8",
    "/js/effects.js": "text/javascript; charset=utf-8",
    "/js/studio.js": "text/javascript; charset=utf-8",
    "/js/visualizer.js": "text/javascript; charset=utf-8",
}


class AssetHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, root, **kwargs):
        self.root = root
        super().__init__(*args, **kwargs)

    def do_GET(self):
        self.send_asset(include_body=True)

    def do_HEAD(self):
        self.send_asset(include_body=False)

    def send_asset(self, include_body):
        # Match literal URLs before any decoding or filesystem normalization.
        path = self.path.partition("?")[0]
        if path == "/":
            path = "/studio.html"
        if path not in ASSETS:
            self.send_error(404)
            return

        asset = self.root / path[1:]
        try:
            # Check the asset through the configured root, inclusive. Aliases
            # above that root (e.g. macOS /var) do not redirect individual assets.
            # On Windows, reject junctions and other reparse points as well.
            for component in (asset, *asset.parents):
                info = component.lstat()
                if stat.S_ISLNK(info.st_mode) or (
                    getattr(info, "st_file_attributes", 0)
                    & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
                ):
                    self.send_error(404)
                    return
                if component == self.root:
                    break
            if not asset.is_file():
                self.send_error(404)
                return
            content = asset.read_bytes()
        except OSError:
            self.send_error(404)
            return

        self.send_response(200)
        self.send_header("Content-Type", ASSETS[path])
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if include_body:
            self.wfile.write(content)


def create_server(root, port=8777):
    handler = partial(AssetHandler, root=Path(root).absolute())
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", nargs="?", default=8777, type=int)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    return args


def main(argv=None):
    args = parse_args(argv)
    with create_server(Path(__file__).absolute().parent, args.port) as server:
        print(f"DualSense Studio → http://127.0.0.1:{args.port}/studio.html   (diagnostic at /index.html)", flush=True)
        print("Open it in Chrome or Edge (WebHID is not in Safari/Firefox).", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
