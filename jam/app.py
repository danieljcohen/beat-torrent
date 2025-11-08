from __future__ import annotations

import asyncio
import json
import time
from typing import Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI(title="Jam Phase 1 - Single Room WS Only")

participants: Set[WebSocket] = set()
host_id: Optional[int] = None

# shared state
state = {
    "track_id": None,
    "status": "PAUSE",
    "offset_sec": 0.0,
    "timestamp": time.time(),
}


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
    global host_id
    is_host = role == "host"
    if is_host:
        if host_id is not None:
            await websocket.close(code=1008, reason="Host already assigned")
            return
        host_id = id(websocket)

    # Add participant
    participants.add(websocket)

    # Send initial STATE immediately
    await websocket.send_text(json.dumps({"type": "STATE", "payload": state}))

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
                # Only host can control
                if not is_host or id(websocket) != host_id:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": "Only host can control"}))
                    continue

                # Update state
                state["track_id"] = msg["track_id"]
                state["status"] = msg_type
                state["offset_sec"] = msg["offset_sec"]
                state["timestamp"] = msg["timestamp"]

                # Broadcast STATE to all (including sender)
                out = json.dumps({"type": "STATE", "payload": state})
                await broadcast(out)
            else:
                await websocket.send_text(json.dumps({"type": "ERROR", "message": f"Unknown type: {msg_type}"}))
                
    except WebSocketDisconnect:
        pass
    finally:
        # Cleanup on disconnect
        participants.discard(websocket)
        if is_host and host_id == id(websocket):
            # Clear host if it was this socket
            host_id = None


