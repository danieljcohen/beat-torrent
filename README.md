# 🎵 BeatTorrent — Distributed Peer-to-Peer Music Streaming

BeatTorrent is a distributed, peer-to-peer music streaming system, following the use case of Spotify Jam but the implementation of BitTorrent (pun intended). One user acts as the Host, and all other connected Peers collaboratively stream audio chunks from one another using WebRTC — not from a centralized server. Only control signals are broadcast through the backend.

**Live App**: https://beat-torrent.fly.dev/

**WebSocket Endpoint**: wss://beat-torrent.fly.dev/ws/jam1

## MVP Features
* Single room (jam1) session
* Host-only playback control
* Real-time PLAY/PAUSE broadcast
* Peer discovery + swarm updates
* WebRTC P2P chunk exchange
* Distributed playback using MSE
* Periodic viewer synchronization to host
* TURN server as a fallback to STUN/NAT

## Future Work
* Functionality to multiple rooms
* More viewer interacitivty with room (view song, vote on next, etc)
* Compatibility across web browsers/devices
* Visualization of chunk spread
* Polish UI
* Modularize codebase

## Notes
Local use: activate venv, uvicorn app:app --reload --port 8000, open static/index.html
