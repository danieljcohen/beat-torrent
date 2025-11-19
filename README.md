# 🎵 BeatTorrent — Distributed Peer-to-Peer Music Streaming

BeatTorrent is a distributed, peer-to-peer music streaming system, following the use case of Spotify Jam but the implementation of BitTorrent (pun intended). One user acts as the Host, and all other connected Peers collaboratively stream audio chunks from one another using WebRTC — not from a centralized server. Only control signals are broadcast through the backend.

**Live App**: https://beat-torrent.fly.dev/

**WebSocket Endpoint**: wss://beat-torrent.fly.dev/ws/jam1

## MVP Features

- Single room (jam1) session
- Host-only playback control
- Real-time PLAY/PAUSE broadcast
- Peer discovery + swarm updates
- WebRTC P2P chunk exchange
- Distributed playback using MSE

## TURN Server Configuration

WebRTC connections may fail on restrictive networks (e.g., university WiFi, corporate firewalls) due to NAT traversal issues. TURN (Traversal Using Relays around NAT) servers can relay traffic when direct P2P connections fail.

### Option 1: Use Public TURN Servers (Default)

The app uses free public TURN servers by default. These may have rate limits and are not recommended for production.

### Option 2: Configure Custom TURN Server via Backend

Set environment variables on your server:

```bash
export TURN_SERVER_URL="turn:your-turn-server.com:3478"
export TURN_SERVER_USERNAME="your-username"
export TURN_SERVER_CREDENTIAL="your-password"
```

The backend will automatically send this configuration to clients when they connect.

### Option 3: Configure TURN Server in Frontend

You can also set TURN server configuration in the browser before the script loads:

```html
<script>
  window.TURN_SERVER_URL = "turn:your-turn-server.com:3478";
  window.TURN_SERVER_USERNAME = "your-username";
  window.TURN_SERVER_CREDENTIAL = "your-password";
</script>
<script src="./frontend.js"></script>
```

### Setting Up Your Own TURN Server

#### Using coturn (Recommended)

1. Install coturn:

   ```bash
   # Ubuntu/Debian
   sudo apt-get install coturn

   # macOS
   brew install coturn
   ```

2. Configure `/etc/turnserver.conf`:

   ```
   listening-port=3478
   tls-listening-port=5349
   listening-ip=0.0.0.0
   external-ip=YOUR_PUBLIC_IP
   realm=your-domain.com
   user=username:password
   ```

3. Start coturn:
   ```bash
   sudo systemctl start coturn
   ```

#### Using Metered.ca (Free Tier)

Sign up at https://www.metered.ca/stun-turn and get free TURN server credentials.

#### Using Twilio (Paid)

Twilio provides reliable TURN servers: https://www.twilio.com/stun-turn

### Debugging Connection Issues

The app logs ICE connection states. Look for:

- `ICE relay candidate` - Successfully using TURN server
- `ICE connection failed` - May need TURN server
- `pc() state=connected` - Connection successful

## Notes

One hardcoded room (jam1) where a host can send PLAY/PAUSE and everyone sees it (No HTTP, no files, no P2P)
Host sends messages to server --> server broadcasts

Local use: activate venv, uvicorn app:app --reload --port 8000, open static/index.html

Get IP address: ipconfig getifaddr en0

Terminal 1
python peer.py \
 --listen-port 9003 --seed --num-chunks 120 --chunk-size 4096

Terminal 2
python peer.py \
 --listen-port 9004 --num-chunks 120 --chunk-size 4096 \
 --connect [IP_ADDRESS]:9003 (use ur own IP)
