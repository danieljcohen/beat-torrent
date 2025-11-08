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
websocat -t ws://localhost:8000/ws/jam1

Start frontend:
open -n -a "Google Chrome" ./frontend.html
