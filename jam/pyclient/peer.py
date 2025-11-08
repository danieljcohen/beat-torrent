#!/usr/bin/env python3
import argparse
import os
import socket
import sys
import threading
from typing import Optional, Set, Tuple


def parse_host_port(value: str) -> Tuple[str, int]:
    if ":" not in value:
        raise argparse.ArgumentTypeError("expected HOST:PORT")
    host, port_s = value.rsplit(":", 1)
    try:
        port = int(port_s)
    except ValueError:
        raise argparse.ArgumentTypeError("invalid port")
    if port <= 0 or port > 65535:
        raise argparse.ArgumentTypeError("port out of range")
    return host, port


def send_all(sock: socket.socket, data: bytes) -> None:
    view = memoryview(data)
    total_sent = 0
    while total_sent < len(data):
        sent = sock.send(view[total_sent:])
        if sent == 0:
            raise ConnectionError("Socket connection broken while sending")
        total_sent += sent


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


class PeerState:
    def __init__(self, num_chunks: int, chunk_size: int, seed: bool):
        self.num_chunks = num_chunks
        self.chunk_size = chunk_size
        self.total_size = num_chunks * chunk_size
        self.buffer = bytearray(self.total_size)
        self.have: Set[int] = set()
        self.lock = threading.Lock()
        if seed:
            # Preload backing buffer with random bytes and mark all as present
            for i in range(self.num_chunks):
                start = i * self.chunk_size
                self.buffer[start:start + self.chunk_size] = os.urandom(self.chunk_size)
            self.have = set(range(self.num_chunks))

    def get_chunk(self, index: int) -> Optional[memoryview]:
        if index < 0 or index >= self.num_chunks:
            return None
        with self.lock:
            if index not in self.have:
                return None
            start = index * self.chunk_size
            return memoryview(self.buffer)[start:start + self.chunk_size]

    def set_chunk(self, index: int, payload: bytes) -> None:
        if index < 0 or index >= self.num_chunks:
            return
        if len(payload) != self.chunk_size:
            return
        with self.lock:
            start = index * self.chunk_size
            self.buffer[start:start + self.chunk_size] = payload
            self.have.add(index)

    def have_all(self) -> bool:
        with self.lock:
            return len(self.have) == self.num_chunks


def handle_client(conn: socket.socket, address: Tuple[str, int], state: PeerState) -> None:
    conn_file = conn.makefile("rb")
    try:
        # Send TRACK_META header immediately on connect
        header = f"TRACK_META {state.num_chunks} {state.chunk_size}\n".encode("ascii")
        send_all(conn, header)

        while True:
            line = conn_file.readline()
            if not line:
                # Client closed
                return
            try:
                text = line.decode("ascii", errors="strict").strip()
            except UnicodeDecodeError:
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
            if index < 0 or index >= state.num_chunks:
                continue

            chunk_view = state.get_chunk(index)
            if chunk_view is None:
                # We don't have this chunk; ignore
                continue

            data_header = f"DATA {index} {len(chunk_view)}\n".encode("ascii")
            send_all(conn, data_header)
            send_all(conn, chunk_view)
    finally:
        try:
            conn_file.close()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass


def run_server(listen_port: int, state: PeerState, stop_event: threading.Event) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("0.0.0.0", listen_port))
        server.listen(16)
        server.settimeout(0.5)
        print(f"[peer] listening on 0.0.0.0:{listen_port} (chunks={state.num_chunks}, size={state.chunk_size})")
        try:
            while not stop_event.is_set():
                try:
                    conn, addr = server.accept()
                except socket.timeout:
                    continue
                print(f"[peer] connection from {addr[0]}:{addr[1]}")
                t = threading.Thread(target=handle_client, args=(conn, addr, state), daemon=True)
                t.start()
        except KeyboardInterrupt:
            print("\n[peer] server shutting down")


def run_client(connect_to: Tuple[str, int], inflight: int, state: PeerState) -> None:
    host, port = connect_to
    with socket.create_connection((host, port)) as sock:
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

            if num_chunks != state.num_chunks or chunk_size != state.chunk_size:
                raise ValueError(
                    f"TRACK_META mismatch: remote ({num_chunks},{chunk_size}) != local ({state.num_chunks},{state.chunk_size})"
                )

            print(f"[peer] connected to {host}:{port}; track has chunks={num_chunks}, size={chunk_size}")

            next_to_request = 0
            in_flight = 0

            # Prime the pipeline
            while in_flight < inflight and next_to_request < num_chunks:
                line = f"REQUEST {next_to_request}\n".encode("ascii")
                sock.sendall(line)
                in_flight += 1
                next_to_request += 1

            while not state.have_all():
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
                state.set_chunk(index, payload)
                in_flight = max(0, in_flight - 1)

                preview = payload[:8].hex()
                print(f"[peer] DATA index={index} length={length} preview={preview}")

                # Keep the pipeline full
                while in_flight < inflight and next_to_request < num_chunks:
                    line = f"REQUEST {next_to_request}\n".encode("ascii")
                    sock.sendall(line)
                    in_flight += 1
                    next_to_request += 1

            print("[peer] download complete")
        finally:
            try:
                fp.close()
            except Exception:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Unified peer (seed or leecher) with raw TCP protocol.")
    parser.add_argument("--listen-port", type=int, required=True, help="Port to listen on")
    parser.add_argument("--seed", action="store_true", help="If set, start with all chunks available")
    parser.add_argument("--num-chunks", type=int, required=True, help="Number of chunks in the track")
    parser.add_argument("--chunk-size", type=int, required=True, help="Chunk size in bytes")
    parser.add_argument("--connect", type=parse_host_port, help="Optional HOST:PORT to connect to as leecher")
    parser.add_argument("--inflight", type=int, default=4, help="Max in-flight REQUESTs while leeching")
    args = parser.parse_args()

    if args.listen_port <= 0 or args.listen_port > 65535:
        print("Invalid --listen-port", file=sys.stderr)
        sys.exit(2)
    if args.num_chunks <= 0:
        print("Invalid --num-chunks", file=sys.stderr)
        sys.exit(2)
    if args.chunk_size <= 0:
        print("Invalid --chunk-size", file=sys.stderr)
        sys.exit(2)
    if args.inflight <= 0:
        print("Invalid --inflight", file=sys.stderr)
        sys.exit(2)

    state = PeerState(args.num_chunks, args.chunk_size, seed=args.seed)

    stop_event = threading.Event()
    server_thread = threading.Thread(target=run_server, args=(args.listen_port, state, stop_event), daemon=False)
    server_thread.start()

    # If connect target provided, act as leecher as well
    try:
        if args.connect is not None:
            run_client(args.connect, args.inflight, state)
        # Seed should keep serving until interrupted
        if args.seed:
            server_thread.join()
        else:
            # Not a seed: stop server after leeching or idle
            stop_event.set()
            server_thread.join()
    except KeyboardInterrupt:
        stop_event.set()
        server_thread.join()


if __name__ == "__main__":
    main()


