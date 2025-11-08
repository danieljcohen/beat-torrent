#!/usr/bin/env python3
import argparse
import socket
import sys
from typing import Tuple


def recv_line(fp) -> str:
    line = fp.readline()
    if not line:
        raise ConnectionError("Connection closed while reading line")
    return line.decode("ascii", errors="strict").strip()


def recv_exact(fp, num_bytes: int) -> bytes:
    data = fp.read(num_bytes)
    if data is None or len(data) != num_bytes:
        raise ConnectionError("Connection closed while reading payload")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="Minimal viewer peer (raw TCP).")
    parser.add_argument("--host", required=True, help="Host/IP to connect to")
    parser.add_argument("--port", type=int, required=True, help="Port to connect to")
    parser.add_argument("--inflight", type=int, default=4, help="Max in-flight REQUESTs")
    args = parser.parse_args()

    if args.port <= 0 or args.port > 65535:
        print("Invalid --port", file=sys.stderr)
        sys.exit(2)
    if args.inflight <= 0:
        print("Invalid --inflight", file=sys.stderr)
        sys.exit(2)

    with socket.create_connection((args.host, args.port)) as sock:
        fp = sock.makefile("rb")
        try:
            meta = recv_line(fp)
            parts = meta.split()
            if len(parts) != 3 or parts[0] != "TRACK_META":
                raise ValueError(f"Unexpected greeting: {meta!r}")

            try:
                num_chunks = int(parts[1])
                chunk_size = int(parts[2])
            except ValueError:
                raise ValueError(f"Bad TRACK_META numbers: {meta!r}")

            print(f"[viewer] connected; track has chunks={num_chunks}, size={chunk_size}")

            next_to_request = 0
            in_flight = 0
            received = 0

            # Prime the pipeline up to inflight window
            while in_flight < args.inflight and next_to_request < num_chunks:
                line = f"REQUEST {next_to_request}\n".encode("ascii")
                sock.sendall(line)
                in_flight += 1
                next_to_request += 1

            while received < num_chunks:
                header = recv_line(fp)
                hparts = header.split()
                if len(hparts) != 3 or hparts[0] != "DATA":
                    # Ignore unknown lines while connected
                    continue

                try:
                    index = int(hparts[1])
                    length = int(hparts[2])
                except ValueError:
                    continue

                payload = recv_exact(fp, length)
                received += 1
                in_flight = max(0, in_flight - 1)

                # Log a concise message with a short hex preview
                preview = payload[:8].hex()
                print(f"[viewer] DATA index={index} length={length} preview={preview}")

                # Keep the pipeline full
                while in_flight < args.inflight and next_to_request < num_chunks:
                    line = f"REQUEST {next_to_request}\n".encode("ascii")
                    sock.sendall(line)
                    in_flight += 1
                    next_to_request += 1

            print("[viewer] done")
        finally:
            try:
                fp.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()


