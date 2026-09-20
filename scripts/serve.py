#!/usr/bin/env python3
"""Static file server for developing the game.

The same as `python3 -m http.server`, except that it tells the browser never
to cache anything. Without that, editing a module and reloading can quietly
serve you the previous version, which looks exactly like your change not
working.
"""

import argparse
import http.server
import socket
import socketserver


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter output
        pass


def lan_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        addr = s.getsockname()[0]
        s.close()
        return addr
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-p", "--port", type=int, default=8000)
    parser.add_argument("-b", "--bind", default="0.0.0.0")
    args = parser.parse_args()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.bind, args.port), NoCacheHandler) as httpd:
        print(f"Gorilla Football on http://localhost:{args.port}/")
        lan = lan_address()
        if lan:
            print(f"On your phone, same Wi-Fi: http://{lan}:{args.port}/")
        print("Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
