from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Optional, Set, Dict, Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

# Load environment variables
load_dotenv()

app = FastAPI(title="Jam Phase 1 - Single Room WS Only")

# Middleware to add no-cache headers for JS files
class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        # Add no-cache headers for JS files to prevent caching issues
        if request.url.path.endswith(('.js', '.html')):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

app.add_middleware(NoCacheMiddleware)

@app.get("/health")
def root():
    return {"status": "ok"}

@app.get("/api/ice-servers")
async def get_ice_servers():
    """Fetch ICE servers from Metered.ca API - includes TURN servers for restrictive networks"""
    metered_domain = os.getenv("METERED_DOMAIN")
    metered_api_key = os.getenv("METERED_API_KEY")
    
    # Try to fetch from Metered.ca API
    if metered_domain and metered_api_key:
        try:
            async with httpx.AsyncClient() as client:
                url = f"https://{metered_domain}/api/v1/turn/credentials?apiKey={metered_api_key}"
                response = await client.get(url, timeout=5.0)
                
                if response.status_code == 200:
                    ice_servers = response.json()
                    
                    # Filter to ONLY TURNS on port 443 for university/restrictive networks
                    # This is the only protocol that reliably works through firewalls
                    filtered_servers = []
                    for server in ice_servers:
                        urls = server.get('urls', server.get('url', ''))
                        # Keep only TURNS (with 's' = TLS) on port 443
                        if isinstance(urls, str):
                            if urls.startswith('turns:') and ':443' in urls:
                                filtered_servers.append(server)
                        elif isinstance(urls, list):
                            for url in urls:
                                if url.startswith('turns:') and ':443' in url:
                                    filtered_servers.append({'urls': url, **{k: v for k, v in server.items() if k != 'urls'}})
                    
                    if filtered_servers:
                        return {"iceServers": filtered_servers}
                    else:
                        print(f"Warning: No TURNS-443 servers found, using all servers")
                        return {"iceServers": ice_servers}
                else:
                    print(f"Metered API error: {response.status_code}")
        except Exception as e:
            print(f"Failed to fetch Metered credentials: {e}")
    
    # Fallback to STUN only
    return {"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]}

@app.get("/api/room/{room_name}/host")
def check_host(room_name: str):
    """Check if a host is currently connected for the given room."""
    return {"has_host": host_id is not None}

participants: Set[WebSocket] = set()
host_id: Optional[int] = None
host_peer_id: Optional[str] = None  # Track host's peer_id for easy lookup
peer_id_by_ws: dict[WebSocket, str] = {}
ws_by_peer_id: dict[str, WebSocket] = {} #support for multiple rooms (tho not yet implemented)
display_name_by_peer_id: dict[str, str] = {} # Track display names for each peer

# shared state
state = {
    "track_id": None,
    "status": "PAUSE",
    "offset_sec": 0.0,
    "timestamp": time.time(),
}

# swarm tracker (single-track room):
# room -> peer_id -> {ip, port, last_seen, have_count, total_chunks?, chunk_size?}
swarms: Dict[str, Dict[str, Dict[str, Any]]] = {}
PEERS_INTERVAL_SEC = 15
STALE_PEER_SEC = 60


async def broadcast(message_json: str):
    """Best-effort broadcast to all participants."""
    if not participants:
        return
    disconnected = []
    for ws in participants:
        try:
            await ws.send_text(message_json)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        participants.discard(ws)

def generate_peer_id() -> str:
    # Simple short (unique) peer id
    return f"p{int(time.time() * 1000) % 1000000:x}"


@app.websocket("/ws/jam1")
async def ws_jam1(websocket: WebSocket):
    await websocket.accept()

    # Expect HELLO within 20 seconds
    try:
        hello_raw = await asyncio.wait_for(websocket.receive_text(), timeout=20.0)
    except asyncio.TimeoutError:
        await websocket.close(code=1008, reason="HELLO timeout")
        return

    # Parse HELLO
    try:
        hello = json.loads(hello_raw)
        if hello.get("type") != "HELLO":
            await websocket.close(code=1008, reason="Expected HELLO")
            return
        role = hello.get("role")
        display_name = hello.get("display_name") or "anon"
        if role not in ("host", "viewer"):
            await websocket.close(code=1008, reason="Invalid role")
            return
    except Exception:
        await websocket.close(code=1008, reason="Invalid HELLO")
        return

    # Host assignment (only one host allowed)
    global host_id, host_peer_id
    is_host = role == "host"
    if is_host:
        if host_id is not None:
            await websocket.close(code=1008, reason="Host already assigned")
            return
        host_id = id(websocket)
        # Reset state to PAUSE when new host connects
        state["status"] = "PAUSE"
        state["offset_sec"] = 0.0
        state["timestamp"] = time.time()

    # Add participant
    participants.add(websocket)

    # Assign peer id and send to this socket
    my_peer_id = generate_peer_id()
    peer_id_by_ws[websocket] = my_peer_id
    ws_by_peer_id[my_peer_id] = websocket
    display_name_by_peer_id[my_peer_id] = display_name
    if is_host:
        host_peer_id = my_peer_id
    await websocket.send_text(json.dumps({"type": "PEER", "peer_id": my_peer_id}))

    # Send initial STATE immediately
    await websocket.send_text(json.dumps({"type": "STATE", "payload": state}))

    async def push_peers_to_room(room: str):
        swarm = swarms.get(room, {})
        # Build full list once
        full = []
        for pid, meta in swarm.items():
            if "port" in meta:
                full.append({
                    "peer_id": pid,
                    "ip": meta.get("ip"),
                    "port": meta.get("port"),
                    "have_count": int(meta.get("have_count") or 0),
                    "display_name": display_name_by_peer_id.get(pid, "Unknown"),
                    "is_host": pid == host_peer_id,
                })
        print(f"push_peers_to_room: room={room}, swarm has {len(full)} peers")
        # Push to ALL connected peers (not just those in swarm)
        # This ensures host gets updates even if they haven't announced yet
        for pid, ws in ws_by_peer_id.items():
            if not ws:
                continue
            peers = [p for p in full if p["peer_id"] != pid]
            out = {"type": "PEERS", "room": room, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
            print(f"  Sending PEERS to {pid}: {len(peers)} peers")
            try:
                await ws.send_text(json.dumps(out))
            except Exception as e:
                print(f"  Failed to send to {pid}: {e}")

    try:
        while True:
            msg_raw = await websocket.receive_text()
            try:
                msg = json.loads(msg_raw)
            except Exception:
                continue

            msg_type = msg.get("type")

            if msg_type in ("PLAY", "PAUSE"):
                # Only host can control
                if not is_host or id(websocket) != host_id:
                    continue
                # Update state
                state["track_id"] = msg["track_id"]
                state["status"] = msg_type
                state["offset_sec"] = msg["offset_sec"]
                state["timestamp"] = msg["timestamp"]

                # Broadcast STATE to all (including sender)
                out = json.dumps({"type": "STATE", "payload": state})
                await broadcast(out)
            elif msg_type == "SIGNAL":
                # Letting peers send blob to eachoter --> later replace with connection offer between peers (bittorrent style peer discovery)
                to_peer = msg["to"]
                blob = msg["blob"]
                dst_ws = ws_by_peer_id.get(to_peer)
                if dst_ws:
                    from_peer = peer_id_by_ws.get(websocket, "unknown")
                    routed = json.dumps({"type": "SIGNAL", "from": from_peer, "blob": blob})
                    try:
                        await dst_ws.send_text(routed)
                        print(f"SIGNAL route {from_peer} -> {to_peer}")
                    except Exception:
                        pass
            elif msg_type == "ANNOUNCE":
                caller_id = peer_id_by_ws.get(websocket, "unknown")
                ip = getattr(websocket.client, "host", None) or "0.0.0.0"
                now = time.time()
                room = msg.get("room")
                port = msg.get("port")
                total_chunks = msg.get("total_chunks")
                chunk_size = msg.get("chunk_size")
                have_count = int(msg.get("have_count") or 0)
                swarm = swarms.setdefault(room, {})
                entry = swarm.get(caller_id) or {}
                entry["ip"] = ip
                entry["port"] = port
                entry["last_seen"] = now
                entry["have_count"] = have_count
                if isinstance(total_chunks, int):
                    entry["total_chunks"] = total_chunks
                if isinstance(chunk_size, int):
                    entry["chunk_size"] = chunk_size
                swarm[caller_id] = entry
                try:
                    print(f"ANNOUNCE room={room} peer={caller_id} ip={ip} port={port} have_count={have_count}, swarm now has {len(swarm)} peers")
                except Exception:
                    pass
                # Build peers list excluding caller, include have_count
                peers = []
                for pid, meta in swarm.items():
                    if pid == caller_id:
                        continue
                    if "port" in meta:
                        peers.append({
                            "peer_id": pid,
                            "ip": meta["ip"],
                            "port": meta["port"],
                            "have_count": int(meta.get("have_count") or 0),
                            "display_name": display_name_by_peer_id.get(pid, "Unknown"),
                            "is_host": pid == host_peer_id,
                        })
                resp = {"type": "PEERS", "room": room, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
                await websocket.send_text(json.dumps(resp))
                # Broadcast updated peers to everyone in the room
                await push_peers_to_room(room)
            elif msg_type == "HAVE_DELTA":
                caller_id = peer_id_by_ws.get(websocket, "unknown")
                now = time.time()
                room = msg.get("room")
                indices = msg.get("indices") or []
                swarm = swarms.setdefault(room, {})
                entry = swarm.get(caller_id) or {"ip": getattr(websocket.client, "host", None) or "0.0.0.0", "port": None}
                entry["last_seen"] = now
                if indices:
                    prev = int(entry.get("have_count") or 0)
                    entry["have_count"] = prev + len(indices)
                swarm[caller_id] = entry
                try:
                    print(f"HAVE_DELTA room={room} peer={caller_id} +{len(indices)} have_count={int(entry.get('have_count') or 0)}")
                except Exception:
                    pass
                # Reply with current peers including have_count
                peers = []
                for pid, meta in swarm.items():
                    if pid == caller_id:
                        continue
                    if "port" in meta:
                        peers.append({
                            "peer_id": pid,
                            "ip": meta["ip"],
                            "port": meta["port"],
                            "have_count": int(meta.get("have_count") or 0),
                            "display_name": display_name_by_peer_id.get(pid, "Unknown"),
                            "is_host": pid == host_peer_id,
                        })
                resp = {"type": "PEERS", "room": room, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
                await websocket.send_text(json.dumps(resp))
                # Broadcast updated peers to everyone in the room
                await push_peers_to_room(room)
                
    except WebSocketDisconnect:
        pass
    finally:
        # Cleanup on disconnect
        participants.discard(websocket)
        pid = peer_id_by_ws.pop(websocket, None)
        if pid:
            ws_by_peer_id.pop(pid, None)
            display_name_by_peer_id.pop(pid, None)
            # Remove from any swarm
            for track_id, swarm in list(swarms.items()):
                if pid in swarm:
                    swarm.pop(pid, None)
                if not swarm:
                    swarms.pop(track_id, None)
        if is_host and host_id == id(websocket):
            # Clear host if it was this socket and reset state to PAUSE
            host_id = None
            host_peer_id = None
            state["status"] = "PAUSE"
            state["offset_sec"] = 0.0
            state["timestamp"] = time.time()


async def cleanup_swarms_task():
    while True:
        await asyncio.sleep(PEERS_INTERVAL_SEC)
        now = time.time()
        to_notify: Dict[str, list[str]] = {}
        # Remove stale peers
        for track_id, swarm in list(swarms.items()):
            removed = False
            for pid, meta in list(swarm.items()):
                last_seen = float(meta.get("last_seen") or 0)
                if now - last_seen > STALE_PEER_SEC:
                    swarm.pop(pid, None)
                    removed = True
            if removed and not swarm:
                swarms.pop(track_id, None)
            if removed and swarm:
                to_notify[track_id] = list(swarm.keys())
        # Push updated PEERS to remaining peers in affected swarms
        for track_id, peer_ids in to_notify.items():
            swarm = swarms.get(track_id) or {}
            # Build full peers list for this track once
            full_list = []
            for pid, meta in swarm.items():
                if "port" in meta:
                    full_list.append({
                        "peer_id": pid,
                        "ip": meta["ip"],
                        "port": meta["port"],
                        "have_count": int(meta.get("have_count") or 0),
                        "display_name": display_name_by_peer_id.get(pid, "Unknown"),
                        "is_host": pid == host_peer_id,
                    })
            for pid in peer_ids:
                ws = ws_by_peer_id.get(pid)
                if not ws:
                    continue
                # Exclude receiver from list
                peers = [p for p in full_list if p["peer_id"] != pid]
                out = {"type": "PEERS", "room": track_id, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
                try:
                    await ws.send_text(json.dumps(out))
                except Exception:
                    pass


@app.on_event("startup")
async def on_startup():
    # Start background cleanup
    asyncio.create_task(cleanup_swarms_task())


app.mount("/", StaticFiles(directory="static", html=True), name="static")