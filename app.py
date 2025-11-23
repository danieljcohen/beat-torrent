from __future__ import annotations
import asyncio
import httpx
import json
import os
import time
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from typing import Optional, Set, Dict, Any

load_dotenv()

PEERS_INTERVAL_SEC = 15
STALE_PEER_SEC = 60
HELLO_TIMEOUT_SEC = 20.0

app = FastAPI(title="BeatTorrent")

class NoCacheMiddleware(BaseHTTPMiddleware):
    """Prevent caching issues (added to fix Fly.io deployment errors)."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.endswith(('.js', '.html')):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


app.add_middleware(NoCacheMiddleware)

# Global state
participants: Set[WebSocket] = set()
host_id: Optional[int] = None
host_peer_id: Optional[str] = None
peer_id_by_ws: dict[WebSocket, str] = {}
ws_by_peer_id: dict[str, WebSocket] = {}
display_name_by_peer_id: dict[str, str] = {}

state = {
    "track_id": None,
    "status": "PAUSE",
    "offset_sec": 0.0,
    "timestamp": time.time(),
}

# Swarm tracker: room -> peer_id -> {ip, port, last_seen, have_count, total_chunks?, chunk_size?}
swarms: Dict[str, Dict[str, Dict[str, Any]]] = {}


### Helper functions

def generate_peer_id() -> str:
    return f"p{int(time.time() * 1000) % 1000000:x}"


def build_peer_list(swarm: Dict[str, Dict[str, Any]], exclude_peer_id: Optional[str] = None) -> list[Dict[str, Any]]:
    """Build a list of peer information from a swarm, excluding the specified peer."""
    peers = []
    for pid, meta in swarm.items():
        if pid == exclude_peer_id or "port" not in meta:
            continue
        peers.append({
            "peer_id": pid,
            "ip": meta["ip"],
            "port": meta["port"],
            "have_count": int(meta.get("have_count") or 0),
            "display_name": display_name_by_peer_id.get(pid, "Unknown"),
            "is_host": pid == host_peer_id,
        })
    return peers


async def broadcast(message_json: str):
    """Broadcast a message to all participants."""
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


async def send_peers_update(room: str, exclude_peer_id: Optional[str] = None):
    """Send PEERS update to all peers in a room."""
    swarm = swarms.get(room, {})
    
    for pid, ws in ws_by_peer_id.items():
        if not ws or pid == exclude_peer_id:
            continue
        peers = build_peer_list(swarm, pid)
        out = {"type": "PEERS", "room": room, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
        try:
            await ws.send_text(json.dumps(out))
        except Exception:
            pass


def get_client_ip(websocket: WebSocket) -> str:
    return getattr(websocket.client, "host", None) or "0.0.0.0"


### API endpoints

@app.get("/api/ice-servers")
async def get_ice_servers():
    """Get ICE servers for WebRTC connections. Metered.ca for TURN."""
    metered_domain = os.getenv("METERED_DOMAIN")
    metered_api_key = os.getenv("METERED_API_KEY")
    
    if metered_domain and metered_api_key:
        try:
            async with httpx.AsyncClient() as client:
                url = f"https://{metered_domain}/api/v1/turn/credentials?apiKey={metered_api_key}"
                response = await client.get(url, timeout=5.0)
                
                if response.status_code == 200:
                    ice_servers = response.json()
                    
                    # Filter only TURNS (s=TLS) on port 443 to work on Dukeblue
                    filtered_servers = []
                    for server in ice_servers:
                        urls = server.get('urls', server.get('url', ''))
                        if isinstance(urls, str):
                            if urls.startswith('turns:') and ':443' in urls:
                                filtered_servers.append(server)
                        elif isinstance(urls, list):
                            for url in urls:
                                if url.startswith('turns:') and ':443' in url:
                                    filtered_servers.append({'urls': url, **{k: v for k, v in server.items() if k != 'urls'}})
                    
                    if filtered_servers:
                        return {"iceServers": filtered_servers}
                    print("Warning: No TURNS-443 servers found, using all servers")
                    return {"iceServers": ice_servers}
                print(f"Metered API error: {response.status_code}")
        except Exception as e:
            print(f"Failed to fetch Metered credentials: {e}")
    
    # Fallback to STUN
    return {"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]}


@app.websocket("/ws/jam1")
async def ws_jam1(websocket: WebSocket):
    """Main WebSocket handler."""
    await websocket.accept()

    # Handle HELLO message
    try:
        hello_raw = await asyncio.wait_for(websocket.receive_text(), timeout=HELLO_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        await websocket.close(code=1008, reason="HELLO timeout")
        return

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

    # Host assignment
    global host_id, host_peer_id
    is_host = role == "host"
    if is_host:
        if host_id is not None:
            await websocket.close(code=1008, reason="Host already assigned")
            return
        host_id = id(websocket)
        state["status"] = "PAUSE"
        state["offset_sec"] = 0.0
        state["timestamp"] = time.time()

    # Register participant
    participants.add(websocket)
    my_peer_id = generate_peer_id()
    peer_id_by_ws[websocket] = my_peer_id
    ws_by_peer_id[my_peer_id] = websocket
    display_name_by_peer_id[my_peer_id] = display_name

    if is_host:
        host_peer_id = my_peer_id

    await websocket.send_text(json.dumps({"type": "PEER", "peer_id": my_peer_id}))
    await websocket.send_text(json.dumps({"type": "STATE", "payload": state}))

    # Message handling loop
    try:
        while True:
            msg_raw = await websocket.receive_text()
            try:
                msg = json.loads(msg_raw)
            except Exception as e:
                await websocket.send_text(json.dumps({"type": "ERROR", "message": f"Invalid JSON: {e}"}))
                continue

            msg_type = msg.get("type")

            if msg_type in ("PLAY", "PAUSE"):
                if not is_host or id(websocket) != host_id:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": "Only host can control"}))
                    continue

                state["track_id"] = msg["track_id"]
                state["status"] = msg_type
                state["offset_sec"] = msg["offset_sec"]
                state["timestamp"] = msg["timestamp"]
                await broadcast(json.dumps({"type": "STATE", "payload": state}))

            elif msg_type == "SIGNAL":
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
                room = msg.get("room")
                if not room:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": "ANNOUNCE missing room"}))
                    continue
                
                port = msg.get("port")
                if not isinstance(port, int):
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": "ANNOUNCE missing/invalid port"}))
                    continue

                swarm = swarms.setdefault(room, {})
                entry = swarm.get(caller_id) or {}
                entry.update({
                    "ip": get_client_ip(websocket),
                    "port": port,
                    "last_seen": time.time(),
                    "have_count": int(msg.get("have_count") or 0),
                })
                
                if isinstance(msg.get("total_chunks"), int):
                    entry["total_chunks"] = msg["total_chunks"]
                if isinstance(msg.get("chunk_size"), int):
                    entry["chunk_size"] = msg["chunk_size"]
                
                swarm[caller_id] = entry
                print(f"ANNOUNCE room={room} peer={caller_id} ip={entry['ip']} port={port} have_count={entry['have_count']}, swarm now has {len(swarm)} peers")
                
                peers = build_peer_list(swarm, caller_id)
                resp = {"type": "PEERS", "room": room, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
                await websocket.send_text(json.dumps(resp))
                await send_peers_update(room, caller_id)

            elif msg_type == "HAVE_DELTA":
                caller_id = peer_id_by_ws.get(websocket, "unknown")
                room = msg.get("room")
                if not room:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": "HAVE_DELTA missing room"}))
                    continue
                
                indices = msg.get("indices") or []
                swarm = swarms.setdefault(room, {})
                entry = swarm.get(caller_id) or {"ip": get_client_ip(websocket), "port": None}
                entry["last_seen"] = time.time()
                
                if indices:
                    entry["have_count"] = int(entry.get("have_count") or 0) + len(indices)
                
                swarm[caller_id] = entry
                print(f"HAVE_DELTA room={room} peer={caller_id} +{len(indices)} have_count={entry.get('have_count', 0)}")
                
                peers = build_peer_list(swarm, caller_id)
                resp = {"type": "PEERS", "room": room, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
                await websocket.send_text(json.dumps(resp))
                await send_peers_update(room, caller_id)

            else:
                await websocket.send_text(json.dumps({"type": "ERROR", "message": f"Unknown type: {msg_type}"}))
                
    except WebSocketDisconnect:
        pass

    finally:
        # Cleanup on disconnect
        participants.discard(websocket)
        pid = peer_id_by_ws.pop(websocket, None)
        if pid:
            ws_by_peer_id.pop(pid, None)
            display_name_by_peer_id.pop(pid, None)
            for track_id, swarm in swarms.items():
                if pid in swarm:
                    swarm.pop(pid, None)
                if not swarm:
                    swarms.pop(track_id, None)
        if is_host and host_id == id(websocket):
            host_id = None
            host_peer_id = None
            state["status"] = "PAUSE"
            state["offset_sec"] = 0.0
            state["timestamp"] = time.time()


### Background tasks

async def cleanup_swarms_task():
    """Periodically clean up stale peers from swarms."""
    while True:
        await asyncio.sleep(PEERS_INTERVAL_SEC)
        now = time.time()
        to_notify: Dict[str, list[str]] = {}

        for track_id, swarm in swarms.items():
            removed = False
            stale_peers = [pid for pid, meta in swarm.items() if now - float(meta.get("last_seen") or 0) > STALE_PEER_SEC]
            for pid in stale_peers:
                swarm.pop(pid, None)
                removed = True
            if removed and not swarm:
                swarms.pop(track_id, None)
            if removed and swarm:
                to_notify[track_id] = list(swarm.keys())

        # Push updated PEERS to remaining peers in affected swarms
        for track_id, peer_ids in to_notify.items():
            swarm = swarms.get(track_id) or {}
            
            for pid in peer_ids:
                ws = ws_by_peer_id.get(pid)
                if not ws:
                    continue
                peers = build_peer_list(swarm, pid)
                out = {"type": "PEERS", "room": track_id, "peers": peers, "interval_sec": PEERS_INTERVAL_SEC}
                try:
                    await ws.send_text(json.dumps(out))
                except Exception:
                    pass


@app.on_event("startup")
async def on_startup():
    _ = asyncio.create_task(cleanup_swarms_task())


app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")