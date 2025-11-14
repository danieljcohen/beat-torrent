# Thought process on how I am going to build this iteratively

## Step1: one hardcoded room (jam1) where a host can send PLAY/PAUSE and everyone sees it (No HTTP, no files, no P2P)
Host sends messages to server --> server broadcasts

How to test step 1:
pre step 1 (optional) - my dependencies are all messed up so I use venv
cd jam
source .venv/bin/activate

1. Start server
uvicorn app:app --reload --port 8000
(I put a 20 sec timeout so send the "HELLO" fast or increase the timeout if ur slow)

2. Start host 
websocat -t ws://localhost:8000/ws/jam1
{"type":"HELLO","role":"host"}

expected response:
{"type": "STATE", "payload": {"track_id": null, "status": "PAUSE", "offset_sec": 0.0, "timestamp": 1762569219.737918}}

3. Start viewer
websocat -t ws://localhost:8000/ws/jam1
{"type":"HELLO","role":"viewer"}

## Step 2: Starting host then viewer is super annoying for testing start 1. Simple web UI to test host message --> server --> all participants
Start server:
websocat -t ws://localhost:8000/ws/jam

Start frontend:
open -n -a "Google Chrome" ./frontend.html

## Step 3: Sending blob between peers through server / storing peer list in server

This is peer discovery through the server, will later replace with connection details to establish connections between peers. This is the setup for peer to peer connections, so although it looks like we sending data through server, this will just be connection details.

Test same way as previous step - I added a button to send a json blob.

## Step 4: No code, just ensuring P2P connection works on network (make sure to test on Duke's campus / on their wifi)

Get IP address:
ipconfig getifaddr en0

Terminal 1 - Start listening for incoming bytes on port 9001
nc -lk 9001 > /tmp/recv_from_viewer.bin

Terminal 2 (separate) - Send 1 MB of random data directly to the host’s IP and port 9001
dd if=/dev/urandom bs=1m count=1 | nc 172.16.21.114 9001

Back to Terminal 1 - check the result:
Ctrl C
ls -lh /tmp/recv_from_viewer.bin

Make sure there is data then ur good

## Step 5: Direct peer to peer data path (long so substeps)

### Step 5.1: minimal raw TCP peer-to-peer connection between a host and a viewer, allowing them to exchange chunked data directly without using the server

How to test
Terminal 1
python peer.py \
  --listen-port 9003 --seed --num-chunks 120 --chunk-size 4096

Terminal 2
python peer.py \
  --listen-port 9004 --num-chunks 120 --chunk-size 4096 \
  --connect [IP_ADDRESS]:9003 (use ur own IP)

## Formatting

1. Install the JavaScript tooling once: `npm install`
2. Run `npm run format` (or `npm run format:check`) to apply Prettier.

Prettier automatically reads `.editorconfig`, so the whitespace rules defined there (LF line endings, trim trailing whitespace, 4-space Python, 2-space HTML/JS, etc.) are enforced whenever you run the formatter or rely on editor integrations.



