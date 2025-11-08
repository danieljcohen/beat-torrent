#!/usr/bin/env python3
import argparse
import os
import socket
import sys
from typing import Tuple


def send_all(sock: socket.socket, data: bytes) -> None:
    view = memoryview(data)
    total_sent = 0
    while total_sent < len(data):
        sent = sock.send(view[total_sent:])
        if sent == 0:
            raise ConnectionError("Socket connection broken while sending")
        total_sent += sent


def handle_client(conn: socket.socket, address: Tuple[str, int], num_chunks: int, chunk_size: int) -> None:
    conn_file = conn.makefile("rb")
    try:
        # Send TRACK_META header immediately
        header = f"TRACK_META {num_chunks} {chunk_size}\n".encode("ascii")
        send_all(conn, header)

        while True:
            line = conn_file.readline()
            if not line:
                # Client closed
                return
            try:
                text = line.decode("ascii", errors="strict").strip()
            except UnicodeDecodeError:
                # Ignore non-ascii
                continue

            if not text:
                continue

            parts = text.split()
            if len(parts) != 2 or parts[0] != "REQUEST":
                # Unknown command --> ignore
                continue

            try:
                index = int(parts[1])
            except ValueError:
                continue

            if index < 0 or index >= num_chunks:
                # Out of range --> ignore
                continue

            # Produce dummy bytes for the chunk
            payload = os.urandom(chunk_size) #reused random buffer per response

            data_header = f"DATA {index} {len(payload)}\n".encode("ascii")
            send_all(conn, data_header)
            send_all(conn, payload)
    finally:
        try:
            conn_file.close()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Minimal host peer (raw TCP).")
    parser.add_argument("--port", type=int, required=True, help="Port to listen on")
    parser.add_argument("--num-chunks", type=int, default=16, help="Number of chunks to advertise")
    parser.add_argument("--chunk-size", type=int, default=4096, help="Chunk size in bytes")
    args = parser.parse_args()

    if args.port <= 0 or args.port > 65535:
        print("Invalid --port", file=sys.stderr)
        sys.exit(2)
    if args.num_chunks <= 0:
        print("Invalid --num-chunks", file=sys.stderr)
        sys.exit(2)
    if args.chunk_size <= 0:
        print("Invalid --chunk-size", file=sys.stderr)
        sys.exit(2)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("0.0.0.0", args.port))
        server.listen(8)
        print(f"[host] listening on 0.0.0.0:{args.port} (chunks={args.num_chunks}, size={args.chunk_size})")
        try:
            while True:
                conn, addr = server.accept()
                print(f"[host] connection from {addr[0]}:{addr[1]}")
                try:
                    handle_client(conn, addr, args.num_chunks, args.chunk_size)
                except Exception as exc:
                    print(f"[host] error while handling client {addr}: {exc}", file=sys.stderr)
                finally:
                    print(f"[host] closed {addr[0]}:{addr[1]}")
        except KeyboardInterrupt:
            print("\n[host] shutting down")


if __name__ == "__main__":
    main()


