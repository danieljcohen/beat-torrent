from __future__ import annotations

import asyncio
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Jam Phase 1 - Single Room WS Only")

PEERS_INTERVAL_SEC = 15
STALE_PEER_SEC = 60


@dataclass
class PlaybackState:
    track_id: Optional[str] = None
    status: str = "PAUSE"
    offset_sec: float = 0.0
    timestamp: float = field(default_factory=time.time)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "track_id": self.track_id,
            "status": self.status,
            "offset_sec": self.offset_sec,
            "timestamp": self.timestamp,
        }

    def reset_controls(self) -> None:
        self.status = "PAUSE"
        self.offset_sec = 0.0
        self.timestamp = time.time()

    def apply(self, *, track_id: Any, status: str, offset_sec: float, timestamp: float) -> None:
        self.track_id = track_id
        self.status = status
        self.offset_sec = offset_sec
        self.timestamp = timestamp


@dataclass
class SwarmPeer:
    peer_id: str
    ip: str
    port: Optional[int] = None
    have_count: int = 0
    total_chunks: Optional[int] = None
    chunk_size: Optional[int] = None
    last_seen: float = field(default_factory=time.time)

    def update_from_announce(
        self,
        *,
        port: int,
        have_count: int,
        total_chunks: Optional[int],
        chunk_size: Optional[int],
    ) -> None:
        self.port = port
        self.have_count = have_count
        self.last_seen = time.time()
        if isinstance(total_chunks, int):
            self.total_chunks = total_chunks
        if isinstance(chunk_size, int):
            self.chunk_size = chunk_size

    def bump_have_count(self, delta: int) -> None:
        if delta > 0:
            self.have_count += delta
        self.last_seen = time.time()

    def as_peer_payload(self) -> Dict[str, Any]:
        return {
            "peer_id": self.peer_id,
            "ip": self.ip,
            "port": self.port,
            "have_count": int(self.have_count or 0),
        }


@dataclass
class ConnectionContext:
    websocket: WebSocket
    peer_id: str
    role: str
    display_name: str

    @property
    def is_host(self) -> bool:
        return self.role == "host"

    def is_active_host(self) -> bool:
        return self.is_host and host_id == id(self.websocket)


participants: Set[WebSocket] = set()
host_id: Optional[int] = None
peer_id_by_ws: dict[WebSocket, str] = {}
ws_by_peer_id: dict[str, WebSocket] = {}
playback_state = PlaybackState()
swarms: Dict[str, Dict[str, SwarmPeer]] = {}  # room -> peer_id -> SwarmPeer


class HelloValidationError(Exception):
    def __init__(self, message: str, *, raw_payload: str | None = None) -> None:
        super().__init__(message)
        self.raw_payload = raw_payload

    def __str__(self) -> str:
        base = super().__str__()
        if self.raw_payload is None:
            return base
        return f"{base} (payload={self.raw_payload})"


def generate_peer_id() -> str:
    return secrets.token_hex(3)


async def send_json(ws: WebSocket, payload: Dict[str, Any]) -> None:
    await ws.send_text(json.dumps(payload))


async def send_error(ws: WebSocket, message: str) -> None:
    await send_json(ws, {"type": "ERROR", "message": message})


async def broadcast(payload: Dict[str, Any]) -> None:
    if not participants:
        return
    message_json = json.dumps(payload)
    disconnected = []
    for ws in participants:
        try:
            await ws.send_text(message_json)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        participants.discard(ws)


def get_peer_ip(websocket: WebSocket) -> str:
    return getattr(websocket.client, "host", None) or "0.0.0.0"


def get_swarm(room: str) -> Dict[str, SwarmPeer]:
    return swarms.setdefault(room, {})


def peers_payload_for_room(room: str, *, exclude_peer: Optional[str] = None) -> list[Dict[str, Any]]:
    swarm = swarms.get(room, {})
    peers: list[Dict[str, Any]] = []
    for pid, meta in swarm.items():
        if exclude_peer and pid == exclude_peer:
            continue
        if meta.port:
            peers.append(meta.as_peer_payload())
    return peers


async def push_peers_to_room(room: str) -> None:
    swarm = swarms.get(room)
    if not swarm:
        return
    full_list = peers_payload_for_room(room)
    for pid in list(swarm.keys()):
        ws = ws_by_peer_id.get(pid)
        if not ws:
            continue
        peers = [p for p in full_list if p["peer_id"] != pid]
        out = {"type": "PEERS", "room": room, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
        try:
            await send_json(ws, out)
        except Exception:
            pass


async def receive_hello(websocket: WebSocket) -> tuple[str, str]:
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=20.0)
    except asyncio.TimeoutError as exc:
        raise HelloValidationError("HELLO timeout") from exc

    try:
        hello = json.loads(raw)
    except Exception as exc:
        raise HelloValidationError("Invalid HELLO") from exc

    if hello.get("type") != "HELLO":
        raise HelloValidationError("Expected HELLO")

    role = hello.get("role")
    if role not in ("host", "viewer"):
        raise HelloValidationError("Invalid role")

    display_name = hello.get("display_name") or "anon"
    return role, display_name


async def handle_play_pause(ctx: ConnectionContext, msg: Dict[str, Any]) -> None:
    if not ctx.is_active_host():
        await send_error(ctx.websocket, "Only host can control")
        return
    playback_state.apply(
        track_id=msg.get("track_id"),
        status=msg.get("type"),
        offset_sec=msg.get("offset_sec", 0.0),
        timestamp=msg.get("timestamp", time.time()),
    )
    await broadcast({"type": "STATE", "payload": playback_state.to_payload()})


async def handle_signal(ctx: ConnectionContext, msg: Dict[str, Any]) -> None:
    to_peer = msg.get("to")
    blob = msg.get("blob")
    if not to_peer or blob is None:
        await send_error(ctx.websocket, "SIGNAL missing fields")
        return
    dst_ws = ws_by_peer_id.get(to_peer)
    if not dst_ws:
        await send_error(ctx.websocket, f"Peer {to_peer} not found")
        return
    routed = {"type": "SIGNAL", "from": ctx.peer_id, "blob": blob}
    try:
        await send_json(dst_ws, routed)
        print(f"SIGNAL route {ctx.peer_id} -> {to_peer}")
    except Exception:
        pass


def upsert_swarm_peer(room: str, ctx: ConnectionContext) -> SwarmPeer:
    swarm = get_swarm(room)
    peer = swarm.get(ctx.peer_id)
    if peer is None:
        peer = SwarmPeer(peer_id=ctx.peer_id, ip=get_peer_ip(ctx.websocket))
        swarm[ctx.peer_id] = peer
    else:
        peer.ip = get_peer_ip(ctx.websocket) or peer.ip
    return peer


async def handle_announce(ctx: ConnectionContext, msg: Dict[str, Any]) -> None:
    room = msg.get("room")
    if not room:
        await send_error(ctx.websocket, "ANNOUNCE missing room")
        return
    port = msg.get("port")
    if not isinstance(port, int):
        await send_error(ctx.websocket, "ANNOUNCE missing/invalid port")
        return
    total_chunks = msg.get("total_chunks")
    chunk_size = msg.get("chunk_size")
    have_count = int(msg.get("have_count") or 0)

    entry = upsert_swarm_peer(room, ctx)
    entry.update_from_announce(
        port=port,
        have_count=have_count,
        total_chunks=total_chunks,
        chunk_size=chunk_size,
    )
    print(f"ANNOUNCE room={room} peer={ctx.peer_id} ip={entry.ip} port={port} have_count={have_count}")

    await send_json(
        ctx.websocket,
        {"type": "PEERS", "room": room, "peers": peers_payload_for_room(room, exclude_peer=ctx.peer_id), "interval_sec": PEERS_INTERVAL_SEC},
    )
    await push_peers_to_room(room)


async def handle_have_delta(ctx: ConnectionContext, msg: Dict[str, Any]) -> None:
    room = msg.get("room")
    if not room:
        await send_error(ctx.websocket, "HAVE_DELTA missing room")
        return
    indices = msg.get("indices") or []
    entry = upsert_swarm_peer(room, ctx)
    entry.bump_have_count(len(indices))
    print(f"HAVE_DELTA room={room} peer={ctx.peer_id} +{len(indices)} have_count={entry.have_count}")

    await send_json(
        ctx.websocket,
        {"type": "PEERS", "room": room, "peers": peers_payload_for_room(room, exclude_peer=ctx.peer_id), "interval_sec": PEERS_INTERVAL_SEC},
    )
    await push_peers_to_room(room)


def drop_peer_from_swarms(peer_id: str) -> None:
    for room, swarm in list(swarms.items()):
        if peer_id in swarm:
            swarm.pop(peer_id, None)
        if not swarm:
            swarms.pop(room, None)


@app.websocket("/ws/jam1")
async def ws_jam1(websocket: WebSocket):
    await websocket.accept()
    ctx: Optional[ConnectionContext] = None

    try:
        role, display_name = await receive_hello(websocket)
    except HelloValidationError as exc:
        await websocket.close(code=1008, reason=str(exc))
        return

    global host_id
    if role == "host":
        if host_id is not None:
            await websocket.close(code=1008, reason="Host already assigned")
            return
        host_id = id(websocket)
        playback_state.reset_controls()

    participants.add(websocket)
    peer_id = generate_peer_id()
    peer_id_by_ws[websocket] = peer_id
    ws_by_peer_id[peer_id] = websocket
    ctx = ConnectionContext(websocket=websocket, peer_id=peer_id, role=role, display_name=display_name)

    await send_json(websocket, {"type": "PEER", "peer_id": peer_id})
    await send_json(websocket, {"type": "STATE", "payload": playback_state.to_payload()})

    try:
        while True:
            msg_raw = await websocket.receive_text()
            try:
                msg = json.loads(msg_raw)
            except Exception as exc:
                await send_error(websocket, f"Invalid JSON: {exc}")
                continue

            msg_type = msg.get("type")
            if msg_type in ("PLAY", "PAUSE"):
                await handle_play_pause(ctx, msg)
            elif msg_type == "SIGNAL":
                await handle_signal(ctx, msg)
            elif msg_type == "ANNOUNCE":
                await handle_announce(ctx, msg)
            elif msg_type == "HAVE_DELTA":
                await handle_have_delta(ctx, msg)
            else:
                await send_error(websocket, f"Unknown type: {msg_type}")
    except WebSocketDisconnect:
        pass
    finally:
        if not ctx:
            return
        participants.discard(ctx.websocket)
        peer_id_by_ws.pop(ctx.websocket, None)
        ws_by_peer_id.pop(ctx.peer_id, None)
        drop_peer_from_swarms(ctx.peer_id)
        if ctx.is_active_host():
            host_id = None
            playback_state.reset_controls()


async def cleanup_swarms_task():
    while True:
        await asyncio.sleep(PEERS_INTERVAL_SEC)
        now = time.time()
        rooms_to_refresh = []
        for room, swarm in list(swarms.items()):
            removed = False
            for pid, meta in list(swarm.items()):
                if now - meta.last_seen > STALE_PEER_SEC:
                    swarm.pop(pid, None)
                    removed = True
            if removed and not swarm:
                swarms.pop(room, None)
            elif removed:
                rooms_to_refresh.append(room)
        for room in rooms_to_refresh:
            await push_peers_to_room(room)


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(cleanup_swarms_task())


app.mount("/", StaticFiles(directory="static", html=True), name="static")