const $ = (id) => document.getElementById(id);
const statusPill = $("statusPill");
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const playBtn = $("playBtn");
const pauseBtn = $("pauseBtn");
const fileInput = $("fileInput");
const audioEl = $("audioEl");
const playerStatus = $("playerStatus");
const bufferInfo = $("bufferInfo");
const logBox = $("log");
const consoleToggle = $("consoleToggle");
const consoleContent = $("consoleContent");
const consoleArrow = $("consoleArrow");
const hostControls = $("hostControls");
const trackName = $("trackName");
const currentTime = $("currentTime");
const progressBar = $("progressBar");

// Playback thresholds (hardcoded for simplicity)
const startThresholdKB = 256;
const rebufferThresholdSec = 2.0;
const resumeThresholdSec = 4.0;

const graph = window.P2PGraph || {
  addOrUpdatePeer: () => {},
  removePeer: () => {},
  addLink: () => {},
  removeLink: () => {},
  hasPeer: () => false,
  reset: () => {},
};

let ws = null;
let currentRole = "viewer";
let myPeerId = null;
let currentTrackName = "Unknown Track";
let progressUpdateTimer = null;

// Console toggle
if (consoleToggle) {
  consoleToggle.onclick = () => {
    if (consoleContent.style.display === "none") {
      consoleContent.style.display = "block";
      consoleArrow.textContent = "▲";
    } else {
      consoleContent.style.display = "none";
      consoleArrow.textContent = "▼";
    }
  };
}

// Progress bar update function
function updateProgressDisplay() {
  if (!audioEl) return;
  
  const currentPos = audioEl.currentTime || 0;
  const duration = audioEl.duration;
  
  // Update time display
  if (currentTime) {
    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Only show duration if it's a valid number
    if (duration && isFinite(duration) && duration > 0) {
      currentTime.textContent = `${formatTime(currentPos)} / ${formatTime(duration)}`;
    } else {
      currentTime.textContent = formatTime(currentPos);
    }
  }
  
  // Update progress bar
  if (progressBar && duration && isFinite(duration) && duration > 0) {
    const percent = (currentPos / duration) * 100;
    progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
}

// Start progress updates
function startProgressUpdates() {
  if (progressUpdateTimer) return;
  progressUpdateTimer = setInterval(updateProgressDisplay, 200);
}

// Stop progress updates
function stopProgressUpdates() {
  if (progressUpdateTimer) {
    clearInterval(progressUpdateTimer);
    progressUpdateTimer = null;
  }
}

// Log function
function now() {
  return new Date().toLocaleTimeString();
}

function appendLog(direction, payload) {
  if (!logBox) return;
  const pre = document.createElement("div");
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  pre.textContent = `[${now()}] ${direction} ${text}`;
  logBox.appendChild(pre);
  logBox.scrollTop = logBox.scrollHeight;
  
  // Also log to console for debugging
  console.log(`${direction} ${text}`);
}

function setConnected(connected) {
  if (connected) {
    statusPill.textContent = "connected";
    statusPill.classList.add("ok");
    statusPill.classList.remove("bad");
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    
    // Show host controls only for host role
    if (currentRole === "host" && hostControls) {
      hostControls.style.display = "block";
      playBtn.disabled = false;
      pauseBtn.disabled = false;
    }
  } else {
    statusPill.textContent = "disconnected";
    statusPill.classList.add("bad");
    statusPill.classList.remove("ok");
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    
    if (hostControls) {
      hostControls.style.display = "none";
    }
    if (playBtn) playBtn.disabled = true;
    if (pauseBtn) pauseBtn.disabled = true;
    myPeerId = null;
    playAuthorized = false;
  }
}

let myDisplayName = "User";

connectBtn.onclick = () => {
  const url = $("wsUrl").value.trim();
  const role = [...document.querySelectorAll('input[name="role"]')].find(
    (r) => r.checked
  ).value;
  const displayName = $("displayName").value.trim() || "User";
  myDisplayName = displayName;
  currentRole = role;

  appendLog("→", `Connecting to ${url} ...`);
  ws = new WebSocket(url);

  ws.onopen = () => {
    setConnected(true);
    const hello = {type: "HELLO", role, display_name: displayName};
    ws.send(JSON.stringify(hello));
    appendLog("→", hello);
    // Auto-announce on connect
    announceNow();
  };
  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      // Log incoming messages (except frequent position updates)
      if (msg.type !== "STATE" || !msg.payload || msg.payload.status !== "PLAY" || Math.random() < 0.1) {
        appendLog("←", typeof ev.data === "string" ? ev.data : JSON.stringify(msg));
      }
      if (msg.type === "STATE") {
        const p = msg.payload || {};
        
        // latency estimation
        if (p.timestamp && typeof p.timestamp === "number") {
          const receiveTime = Date.now() / 1000;
          const oneWayLatency = Math.max(0, (receiveTime - p.timestamp) / 2);
          syncLatencySamples.push(oneWayLatency);
          if (syncLatencySamples.length > 10) {
            syncLatencySamples.shift();
          }
          const sorted = [...syncLatencySamples].sort((a, b) => a - b);
          syncLatency = sorted[Math.floor(sorted.length / 2)];
        }

        // Host broadcasts control, all clients honor it
        playAuthorized = p.status === "PLAY";
        if (p.status === "PLAY") {
          startProgressUpdates();
          manualPaused = false;
          // sync to host
          if (
            p.offset_sec !== undefined &&
            typeof p.offset_sec === "number" &&
            audioEl
          ) {
            const receiveTime = Date.now() / 1000;
            const hostTimestamp = p.timestamp || receiveTime;
            const timeSinceHostAction = Math.max(
              0,
              receiveTime - hostTimestamp
            );
            const targetPosition = p.offset_sec + timeSinceHostAction;

            lastHostOffset = p.offset_sec;
            lastSyncTimestamp = hostTimestamp;

            const currentPos = audioEl.currentTime || 0;
            const drift = Math.abs(currentPos - targetPosition);

            if (drift > syncDriftThreshold || currentPos === 0) {
              try {
                const buffered = audioEl.buffered;
                let canSeek = false;
                for (let i = 0; i < buffered.length; i++) {
                  const start = buffered.start(i);
                  const end = buffered.end(i);
                  if (targetPosition >= start && targetPosition <= end) {
                    canSeek = true;
                    break;
                  }
                }

                if (canSeek || currentPos === 0) {
                  audioEl.currentTime = targetPosition;
                  appendLog("ℹ", `Synced to position ${targetPosition.toFixed(2)}s (drift was ${drift.toFixed(2)}s)`);
                }
              } catch (e) {
                appendLog("!", `Sync seek failed: ${e}`);
              }
            }
          }
          maybeStartOrResume();
        } else if (p.status === "PAUSE") {
          stopProgressUpdates();
          updateProgressDisplay(); // Update one last time
          try {
            if (audioEl) audioEl.pause();
            if (
              p.offset_sec !== undefined &&
              typeof p.offset_sec === "number"
            ) {
              const currentPos = audioEl.currentTime || 0;
              const drift = Math.abs(currentPos - p.offset_sec);
              if (drift > syncDriftThreshold) {
                try {
                  audioEl.currentTime = p.offset_sec;
                } catch (e) {
                  appendLog("!", `Pause sync failed: ${e}`);
                }
              }
            }
          } catch (_) {}
          autoPaused = false;
          awaitingStart = true;
        }

        if (p.status === "PLAY") {
          if (currentRole === "viewer") {
            startPeriodicSync();
          } else if (currentRole === "host") {
            startHostPositionBroadcast();
          }
        } else {
          stopPeriodicSync();
          stopHostPositionBroadcast();
        }
      } else if (msg.type === "PEER") {
        if (msg.peer_id) {
          myPeerId = msg.peer_id;
          graph.addOrUpdatePeer(msg.peer_id, {
            isHost: currentRole === "host",
            displayName: myDisplayName,
          });
        }
      } else if (msg.type === "PEERS") {
        lastPeers = msg.peers || [];
        try {
          ensureConnections(msg.peers || []);
          (msg.peers || []).forEach((p) => {
            graph.addOrUpdatePeer(p.peer_id, {
              ip: p.ip,
              port: p.port,
              have: p.have_count,
              displayName: p.display_name,
            });
          });
        } catch (_) {}
      } else if (msg.type === "SIGNAL") {
        const from = msg.from || "(unknown)";
        const blob = msg.blob || {};
        // Handle graph connection events from other peers
        if (blob && blob.graph_event === "PEER_CONNECTED") {
          const peerA = blob.peer_a;
          const peerB = blob.peer_b;
          if (peerA && peerB) {
            graph.addLink(peerA, peerB);
            appendLog("ℹ", `Graph: ${peerA} ↔ ${peerB}`);
          }
        } else if (blob && blob.graph_event === "PEER_DISCONNECTED") {
          const peerA = blob.peer_a;
          const peerB = blob.peer_b;
          if (peerA && peerB) {
            graph.removeLink(peerA, peerB);
            appendLog("ℹ", `Graph: ${peerA} ✗ ${peerB}`);
          }
        }
        // WebRTC signaling
        if (blob && blob.wrtc && from !== "(unknown)") {
          if (blob.wrtc === "offer") {
            const pc = await createPeerConnection(from, false);
            try {
              await pc.setRemoteDescription(
                new RTCSessionDescription(blob.sdp)
              );
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              sendSignal(from, {wrtc: "answer", sdp: answer});
            } catch (e) {
              appendLog("!", "Offer handling failed");
            }
          } else if (blob.wrtc === "answer") {
            try {
              const pc = pcByPeer.get(from);
              if (pc) {
                await pc.setRemoteDescription(
                  new RTCSessionDescription(blob.sdp)
                );
              }
            } catch (e) {
              appendLog("!", "Answer handling failed");
            }
          } else if (blob.wrtc === "ice" && blob.candidate) {
            try {
              const pc = pcByPeer.get(from);
              if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(blob.candidate));
              }
            } catch (_) {}
          }
        } else if (blob && blob.graph_event === "PEER_LEFT") {
          const departed = blob.peer_id;
          if (departed) {
            graph.removePeer(departed);
            if (Array.isArray(lastPeers)) {
              lastPeers = lastPeers.filter((p) => p.peer_id !== departed);
            }
            appendLog("ℹ", `Peer ${departed} disconnected`);
          }
        }
      }
    } catch (_) {}
  };
  ws.onerror = () => appendLog("!", "WebSocket error");
  ws.onclose = (ev) => {
    if (myPeerId) {
      graph.removePeer(myPeerId);
    }
    graph.reset();
    appendLog("!", `WebSocket closed (${ev.code}${ev.reason ? ": " + ev.reason : ""})`);
    setConnected(false);

    // reset sync state
    stopPeriodicSync();
    stopHostPositionBroadcast();
    stopProgressUpdates();
    syncLatency = 0;
    syncLatencySamples = [];
    lastSyncTimestamp = 0;
    lastHostOffset = 0;
    syncCorrectionInProgress = false;
  };
};

function notifyPeersOfGraphLeave() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!myPeerId) return;
  const peers = Array.isArray(lastPeers) ? lastPeers : [];
  peers.forEach((peer) => {
    if (!peer || !peer.peer_id || peer.peer_id === myPeerId) return;
    const msg = {
      type: "SIGNAL",
      to: peer.peer_id,
      blob: {graph_event: "PEER_LEFT", peer_id: myPeerId},
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch (_) {}
  });
}

disconnectBtn.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    notifyPeersOfGraphLeave();
    ws.close();
  } else {
    graph.reset();
  }
  ws = null;
};

window.addEventListener("beforeunload", () => {
  notifyPeersOfGraphLeave();
});

function sendControl(type) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    appendLog("!", "Not connected");
    return;
  }
  const offset = audioEl && audioEl.currentTime !== undefined && audioEl.currentTime !== null
      ? audioEl.currentTime : 0;
  const msg = {
    type,
    track_id: "t1",
    offset_sec: offset,
    timestamp: Date.now() / 1000,
  };
  ws.send(JSON.stringify(msg));
  appendLog("→", msg);

  if (type === "PLAY" && currentRole === "host") {
    startHostPositionBroadcast();
  } else if (type === "PAUSE" && currentRole === "host") {
    stopHostPositionBroadcast();
  }
}

playBtn.onclick = () => sendControl("PLAY");
pauseBtn.onclick = () => sendControl("PAUSE");

function announceNow() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  const msg = {
    type: "ANNOUNCE",
    room: "jam1",
    port: 0,
    total_chunks: currentNumChunks(),
    chunk_size: pbHost ? pbHost.chunkSize : pbRecv ? pbRecv.chunkSize : 4096,
    have_count: pbHost ? pbHost.haveCount : pbRecv ? pbRecv.haveCount : 0,
  };
  ws.send(JSON.stringify(msg));
}

// Track last known peers
let lastPeers = [];

// In-browser RAM buffer with contiguous guard
class PeerBuffer {
  constructor(numChunks, chunkSize) {
    this.numChunks = numChunks | 0;
    this.chunkSize = chunkSize | 0;
    this.totalSize = this.numChunks * this.chunkSize;
    this.buffer = new Uint8Array(this.totalSize);
    this.have = new Array(this.numChunks).fill(false);
    this.haveCount = 0;
    this.contiguousChunkEnd = 0; // exclusive
    this.contiguousByteEnd = 0; // exclusive
  }
  setChunk(index, payload) {
    if (index < 0 || index >= this.numChunks) return false;
    if (!(payload instanceof Uint8Array)) return false;
    if (payload.length !== this.chunkSize) return false;
    const start = index * this.chunkSize;
    this.buffer.set(payload, start);
    if (!this.have[index]) {
      this.have[index] = true;
      this.haveCount++;
      // advance contiguous window
      while (
        this.contiguousChunkEnd < this.numChunks &&
        this.have[this.contiguousChunkEnd]
      ) {
        this.contiguousChunkEnd++;
      }
      this.contiguousByteEnd = Math.min(
        this.contiguousChunkEnd * this.chunkSize,
        this.totalSize
      );
    }
    return true;
  }
  readRange(start, length) {
    if (start < 0 || length <= 0) return new Uint8Array(0);
    const maxEnd = Math.min(this.totalSize, this.contiguousByteEnd);
    let end = start + length;
    if (end > maxEnd) end = maxEnd;
    if (start >= end) return new Uint8Array(0);
    // Since we clamp to contiguousByteEnd, the slice is safe
    return this.buffer.slice(start, end);
  }
  getLargestContiguousEnd() {
    return this.contiguousByteEnd;
  }
}

// Minimal MSE player fed from active PeerBuffer (host or viewer)
let pbActive = null; // currently playing buffer
let pbHost = null; // host's buffer (when file loaded)
let pbRecv = null; // viewer's download buffer
let fileSizeBytes = 0;
let mediaSource = null;
let sourceBuffer = null;
let mseAppendedBytes = 0;
let appendTimer = null;
let rebufferTimer = null;
let awaitingStart = true;
let autoPaused = false;
let manualPaused = false;
let mediaObjectUrl = null;
let playAuthorized = false; // controlled by WS STATE from host

// Sync state
let syncLatency = 0; // Estimated one-way latency in seconds
let syncLatencySamples = []; // Samples for latency estimation
let lastSyncTimestamp = 0; // Last sync timestamp from host
let syncTimer = null; // Periodic sync timer
let lastHostOffset = 0; // Last known host offset
let syncDriftThreshold = 0.1; // 100ms drift threshold for correction
let syncCorrectionInProgress = false; // Flag to prevent multiple simultaneous corrections

function setPlayerStatus(text) {
  if (playerStatus) playerStatus.textContent = text;
}

// Periodic synchronization functions
function startPeriodicSync() {
  if (syncTimer) return; // Already running
  // Check for drift every 1 second
  syncTimer = setInterval(() => {
    if (!audioEl || !playAuthorized || audioEl.paused) return;
    if (syncCorrectionInProgress) return;

    const currentPos = audioEl.currentTime || 0;
    const now = Date.now() / 1000;

    // Estimate where host should be based on last known position and time elapsed
    if (lastSyncTimestamp > 0 && lastHostOffset >= 0) {
      const timeSinceSync = now - lastSyncTimestamp;
      const estimatedHostPos = lastHostOffset + timeSinceSync;
      const drift = Math.abs(currentPos - estimatedHostPos);

      // Only correct if drift exceeds threshold
      if (drift > syncDriftThreshold) {
        // Use gradual correction for small drift, immediate for large
        const correctionAmount = drift > 0.5 ? drift : drift * 0.3; // Gradual correction
        const targetPos =
          currentPos < estimatedHostPos
            ? currentPos + correctionAmount
            : currentPos - correctionAmount;

        try {
          const buffered = audioEl.buffered;
          let canSeek = false;
          for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (targetPos >= start && targetPos <= end) {
              canSeek = true;
              break;
            }
          }

          if (canSeek) {
            syncCorrectionInProgress = true;
            audioEl.currentTime = targetPos;
            setTimeout(() => {
              syncCorrectionInProgress = false;
            }, 100);
            if (drift > 0.2) {
              appendLog("ℹ", `Periodic sync: corrected drift ${drift.toFixed(2)}s`);
            }
          }
        } catch (e) {
          syncCorrectionInProgress = false;
        }
      }
    }
  }, 20);
}

function stopPeriodicSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// Host: Broadcast position periodically
let hostPositionTimer = null;
function startHostPositionBroadcast() {
  if (hostPositionTimer || currentRole !== "host") return;
  // Broadcast position every 1-2 seconds when playing
  hostPositionTimer = setInterval(() => {
    if (!audioEl || !playAuthorized || audioEl.paused) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const currentPos = audioEl.currentTime || 0;
    const msg = {
      type: "PLAY",
      track_id: "t1",
      offset_sec: currentPos,
      timestamp: Date.now() / 1000,
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      appendLog("!", `Position broadcast failed: ${e}`);
    }
  }, 1500); // Every 1.5 seconds
}

function stopHostPositionBroadcast() {
  if (hostPositionTimer) {
    clearInterval(hostPositionTimer);
    hostPositionTimer = null;
  }
}

function initMediaSource() {
  if (!audioEl) return;
  // Cleanup previous media source if any
  try {
    if (appendTimer) {
      clearInterval(appendTimer);
      appendTimer = null;
    }
    if (rebufferTimer) {
      clearInterval(rebufferTimer);
      rebufferTimer = null;
    }
    if (mediaSource && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch (_) {}
    }
    if (mediaObjectUrl) {
      try {
        URL.revokeObjectURL(mediaObjectUrl);
      } catch (_) {}
      mediaObjectUrl = null;
    }
  } catch (_) {}
  mediaSource = new MediaSource();
  mediaObjectUrl = URL.createObjectURL(mediaSource);
  audioEl.src = mediaObjectUrl;

  // Host seek to broadcast new positions to sync to
  if (currentRole === "host") {
    let lastSeekTime = 0;
    audioEl.addEventListener("seeked", () => {
      if (!playAuthorized || audioEl.paused) return;
      const now = Date.now();
      if (now - lastSeekTime < 200) return;
      lastSeekTime = now;

      const currentPos = audioEl.currentTime || 0;
      sendControl("PLAY");
      appendLog("ℹ", `Host seeked to ${currentPos.toFixed(2)}s, broadcasting`);
    });
  }

  mediaSource.addEventListener(
    "sourceopen",
    () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        sourceBuffer.mode = "sequence";
        sourceBuffer.addEventListener("updateend", () => {
          maybeStartOrResume();
        });
        setPlayerStatus("MSE ready");
      } catch (e) {
        setPlayerStatus(`MSE init error: ${e && e.message ? e.message : e}`);
      }
    },
    {once: true}
  );
}

function getBufferedAheadSec() {
  if (!audioEl) return 0;
  const t = audioEl.currentTime || 0;
  const ranges = audioEl.buffered;
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (t >= start && t <= end) {
      return Math.max(0, end - t);
    }
  }
  return 0;
}

function maybeStartOrResume() {
  if (!audioEl) return;
  // Only start/resume when host has sent PLAY
  if (!playAuthorized) return;
  // Respect manual pause; don't auto-resume if user paused
  if (manualPaused) return;
  const startBytes = Math.max(0, Math.floor(startThresholdKB * 1024));
  const playable = pbActive ? pbActive.getLargestContiguousEnd() : 0;
  if (awaitingStart && playable >= startBytes) {
    audioEl
      .play()
      .then(() => {
        awaitingStart = false;
        autoPaused = false;
      })
      .catch(() => {});
  } else if (autoPaused) {
    const ahead = getBufferedAheadSec();
    if (ahead >= resumeThresholdSec) {
      audioEl
        .play()
        .then(() => {
          autoPaused = false;
        })
        .catch(() => {});
    }
  }
}

function startAppendLoop() {
  if (appendTimer) {
    clearInterval(appendTimer);
    appendTimer = null;
  }
  mseAppendedBytes = 0;
  awaitingStart = true;
  autoPaused = false;
  manualPaused = false;
  appendTimer = setInterval(() => {
    if (!pbActive || !sourceBuffer || !mediaSource) return;
    if (sourceBuffer.updating) return;
    const playableEnd = Math.min(
      pbActive.getLargestContiguousEnd(),
      fileSizeBytes
    );
    if (mseAppendedBytes >= playableEnd) return;
    const toAppend = pbActive.readRange(
      mseAppendedBytes,
      playableEnd - mseAppendedBytes
    );
    if (toAppend && toAppend.length > 0) {
      try {
        sourceBuffer.appendBuffer(toAppend);
        mseAppendedBytes += toAppend.length;
        setPlayerStatus(`appended=${mseAppendedBytes}/${fileSizeBytes}`);
        // End of stream if fully appended
        if (
          mseAppendedBytes >= fileSizeBytes &&
          mediaSource.readyState === "open"
        ) {
          try {
            mediaSource.endOfStream();
          } catch (_) {}
        }
        // Check if we can start/resume after appending
        maybeStartOrResume();
      } catch (e) {
        setPlayerStatus(`append error: ${e && e.message ? e.message : e}`);
      }
    }
  }, 200);
  // Start/refresh rebuffer monitor
  if (rebufferTimer) {
    clearInterval(rebufferTimer);
    rebufferTimer = null;
  }
  rebufferTimer = setInterval(() => {
    const ahead = getBufferedAheadSec();
    if (bufferInfo) {
      try {
        bufferInfo.textContent = `ahead=${ahead.toFixed(2)}s`;
      } catch (_) {}
    }
    if (!awaitingStart && !audioEl.paused && ahead < rebufferThresholdSec) {
      // Auto-pause to prevent glitching; continue appending
      try {
        audioEl.pause();
        autoPaused = true;
        manualPaused = false;
      } catch (_) {}
    } else if (autoPaused) {
      maybeStartOrResume();
    }
  }, 300);
}

// Auto-load MP3 when file is selected
if (fileInput) {
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    if (!file) return;
    
    const cSize = 4096; // Fixed chunk size
    try {
      setPlayerStatus("reading file...");
      const buf = new Uint8Array(await file.arrayBuffer());
      fileSizeBytes = buf.length;
      const nChunks = Math.ceil(fileSizeBytes / cSize);
      pbHost = new PeerBuffer(nChunks, cSize);
      // Fill chunks; pad final chunk if needed
      for (let idx = 0; idx < nChunks; idx++) {
        const start = idx * cSize;
        const end = Math.min(start + cSize, fileSizeBytes);
        const slice = buf.slice(start, end);
        let payload = slice;
        if (slice.length < cSize) {
          const padded = new Uint8Array(cSize);
          padded.set(slice, 0);
          payload = padded;
        }
        pbHost.setChunk(idx, payload);
      }
      pbActive = pbHost;
      currentTrackName = file.name;
      appendLog("ℹ", `Loaded ${file.name} (${fileSizeBytes} bytes) into RAM as ${nChunks} chunks`);
      
      // Update track name immediately
      if (trackName) {
        trackName.textContent = currentTrackName;
        console.log("Set track name to:", currentTrackName);
      }
      // Initialize availability tables for host
      initPeersByChunk(nChunks);
      // Initialize blank bitmaps for all known peers
      for (const pid of dcByPeer.keys()) {
        if (!haveBitmapByPeer.has(pid)) {
          haveBitmapByPeer.set(pid, new Array(nChunks).fill(0));
        }
      }
      // If a datachannel is already open, push TRACK_META to viewer(s)
      try {
        const meta = {
          t: "TRACK_META",
          numChunks: pbHost.numChunks,
          chunkSize: pbHost.chunkSize,
          totalSize: pbHost.totalSize,
        };
        for (const [pid, ch] of dcByPeer.entries()) {
          if (ch && ch.readyState === "open") {
            try {
              ch.send(JSON.stringify(meta));
            } catch (_) {}
            try {
              sendHaveBitmap(ch);
            } catch (_) {}
          }
        }
        appendLog("ℹ", "Sent TRACK_META to open peers");
      } catch (_) {}
      
      // Announce to tracker
      announceNow();
      
      initMediaSource();
      startAppendLoop();
      
      // Wait for audio element to have duration, then update display
      if (audioEl) {
        audioEl.addEventListener('loadedmetadata', () => {
          updateProgressDisplay();
        }, { once: true });
      }
    } catch (e) {
      setPlayerStatus(`load error: ${e && e.message ? e.message : e}`);
    }
  };
}

// WebRTC DataChannel P2P for chunk transfer
const rtcConfig = {iceServers: [{urls: ["stun:stun.l.google.com:19302"]}]};
// Per-peer connections/channels
const pcByPeer = new Map();
const dcByPeer = new Map();
let primaryUpstreamPeerId = null;
let pendingDataHeader = null; // {index, length}
let inflight = 0;
let inflightMax = 8;
let nextToRequest = 0;
let recvNumChunks = 0;
let recvChunkSize = 0;
// Per-peer HAVE bitmap knowledge and announce throttle
const haveBitmapByPeer = new Map(); // peerId -> Array<0|1>
let bitmapAnnounceTimer = null;
// Availability tables: chunk-to-peers mapping
let peersByChunk = []; // Array<Set<peerId>>
// Round-robin peer selection
let rrIndex = 0;
// Throughput tracking
const throughput = new Map(); // peerId -> {lastTime, lastBytes, rate}

function currentNumChunks() {
  if (pbHost && Number.isFinite(pbHost.numChunks)) return pbHost.numChunks | 0;
  if (pbRecv && Number.isFinite(pbRecv.numChunks)) return pbRecv.numChunks | 0;
  return 0;
}

function buildLocalBitmap() {
  const n = currentNumChunks();
  if (n <= 0) return [];
  const src = pbHost ? pbHost.have : pbRecv ? pbRecv.have : null;
  if (!src || !Array.isArray(src)) return new Array(n).fill(0);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = src[i] ? 1 : 0;
  }
  return out;
}

function sendHaveBitmap(channel) {
  if (!channel || channel.readyState !== "open") return;
  const n = currentNumChunks();
  if (!Number.isFinite(n) || n <= 0) return;
  const bitmap = buildLocalBitmap();
  try {
    channel.send(JSON.stringify({t: "HAVE_BITMAP", bitmap}));
  } catch (_) {}
}

function broadcastHaveBitmap() {
  const n = currentNumChunks();
  if (!Number.isFinite(n) || n <= 0) return;
  for (const [, ch] of dcByPeer.entries()) {
    if (ch && ch.readyState === "open") {
      sendHaveBitmap(ch);
    }
  }
}

function scheduleBitmapAnnounce(delayMs = 300) {
  if (bitmapAnnounceTimer) return;
  bitmapAnnounceTimer = setTimeout(
    () => {
      bitmapAnnounceTimer = null;
      try {
        broadcastHaveBitmap();
      } catch (_) {}
    },
    Math.max(0, delayMs | 0)
  );
}

function initPeersByChunk(numChunks) {
  peersByChunk = new Array(numChunks | 0);
  for (let i = 0; i < peersByChunk.length; i++) {
    peersByChunk[i] = new Set();
  }
}

function updatePeerAvailability(peerId, bitmap) {
  if (!Array.isArray(bitmap) || bitmap.length !== peersByChunk.length) return;
  // Remove this peer from all chunks first
  for (let i = 0; i < peersByChunk.length; i++) {
    peersByChunk[i].delete(peerId);
  }
  // Add peer to chunks they have
  for (let i = 0; i < bitmap.length; i++) {
    if (bitmap[i]) {
      peersByChunk[i].add(peerId);
    }
  }
}

function markPeerHasChunk(peerId, chunkIndex) {
  if (chunkIndex < 0 || chunkIndex >= peersByChunk.length) return;
  peersByChunk[chunkIndex].add(peerId);
  // Also update bitmap if exists
  const bm = haveBitmapByPeer.get(peerId);
  if (bm && chunkIndex < bm.length) {
    bm[chunkIndex] = 1;
  }
}

function resetP2P() {
  try {
    for (const ch of dcByPeer.values()) {
      try {
        ch.close();
      } catch (_) {}
    }
  } catch (_) {}
  try {
    for (const p of pcByPeer.values()) {
      try {
        p.close();
      } catch (_) {}
    }
  } catch (_) {}
  pcByPeer.clear();
  dcByPeer.clear();
  primaryUpstreamPeerId = null;
  pendingDataHeader = null;
  inflight = 0;
  nextToRequest = 0;
  recvNumChunks = 0;
  recvChunkSize = 0;
  haveBitmapByPeer.clear();
  peersByChunk = [];
}

function sendSignal(to, blob) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    appendLog("!", "Not connected (WS) for signaling");
    return;
  }
  const msg = {type: "SIGNAL", to, blob};
  ws.send(JSON.stringify(msg));
  appendLog("→", {SIGNAL: blob.wrtc || blob});
}

function broadcastGraphConnection(peerA, peerB, isConnected) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!Array.isArray(lastPeers)) return;

  const eventType = isConnected ? "PEER_CONNECTED" : "PEER_DISCONNECTED";
  const blob = {
    graph_event: eventType,
    peer_a: peerA,
    peer_b: peerB,
  };

  // Broadcast to all peers except the two involved in this connection
  lastPeers.forEach((peer) => {
    const pid = peer && peer.peer_id;
    if (!pid || pid === peerA || pid === peerB) return;
    try {
      sendSignal(pid, blob);
    } catch (_) {}
  });
}

async function createPeerConnection(toPeerId, isInitiator) {
  if (pcByPeer.has(toPeerId)) {
    return pcByPeer.get(toPeerId);
  }
  const pc = new RTCPeerConnection(rtcConfig);
  pcByPeer.set(toPeerId, pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(toPeerId, {wrtc: "ice", candidate: e.candidate});
    }
  };
  pc.onconnectionstatechange = () => {
    appendLog("ℹ", `pc(${toPeerId}) state=${pc.connectionState}`);
    if (
      pc.connectionState === "closed" ||
      pc.connectionState === "failed" ||
      pc.connectionState === "disconnected"
    ) {
      try {
        const ch = dcByPeer.get(toPeerId);
        if (ch) {
          try {
            ch.close();
          } catch (_) {}
        }
      } catch (_) {}
      dcByPeer.delete(toPeerId);
      pcByPeer.delete(toPeerId);
      if (primaryUpstreamPeerId === toPeerId) {
        primaryUpstreamPeerId = null;
      }
      // Clean up peer availability
      haveBitmapByPeer.delete(toPeerId);
      for (let i = 0; i < peersByChunk.length; i++) {
        peersByChunk[i].delete(toPeerId);
      }
    }
  };
  if (isInitiator) {
    const dc = pc.createDataChannel("data", {ordered: true});
    dcByPeer.set(toPeerId, dc);
    wireDataChannel(dc, toPeerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(toPeerId, {wrtc: "offer", sdp: offer});
  } else {
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      dcByPeer.set(toPeerId, ch);
      wireDataChannel(ch, toPeerId);
    };
  }
  return pc;
}

function wireDataChannel(channel, peerId) {
  channel.binaryType = "arraybuffer";
  channel.onopen = () => {
    appendLog("ℹ", `datachannel open (${peerId})`);
    const myId = myPeerId;
    graph.addLink(myId, peerId);
    // Broadcast this connection to all other peers so they can update their graphs
    broadcastGraphConnection(myId, peerId, true);
    if (primaryUpstreamPeerId === null) {
      primaryUpstreamPeerId = peerId;
    }
    // If we are the host (have pbHost loaded), send TRACK_META
    if (pbHost && channel.readyState === "open") {
      const meta = {
        t: "TRACK_META",
        numChunks: pbHost.numChunks,
        chunkSize: pbHost.chunkSize,
        totalSize: pbHost.totalSize,
      };
      channel.send(JSON.stringify(meta));
      // Share initial HAVE bitmap
      sendHaveBitmap(channel);
    }
  };
  channel.onclose = () => {
    appendLog("ℹ", `datachannel close (${peerId})`);
    const myId = myPeerId;
    graph.removeLink(myId, peerId);
    // Broadcast disconnection to all other peers
    broadcastGraphConnection(myId, peerId, false);
  };
  channel.onerror = (e) =>
    appendLog("!", `datachannel error (${peerId}) ${e && e.message ? e.message : ""}`);
  channel.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      handleDCText(ev.data, channel, peerId);
    } else if (ev.data instanceof ArrayBuffer) {
      handleDCBinary(new Uint8Array(ev.data), channel, peerId);
    } else {
      // Blob fallback
      if (ev.data && ev.data.arrayBuffer) {
        ev.data
          .arrayBuffer()
          .then((buf) => handleDCBinary(new Uint8Array(buf), channel, peerId));
      }
    }
  };
}

function handleDCText(text, channel, peerId) {
  try {
    const msg = JSON.parse(text);
    if (msg.t === "TRACK_META") {
      // Viewer path: initialize receiver buffer and player
      recvNumChunks = msg.numChunks | 0;
      recvChunkSize = msg.chunkSize | 0;
      const total = msg.totalSize | 0;
      inflight = 0;
      nextToRequest = 0;
      pbRecv = new PeerBuffer(recvNumChunks, recvChunkSize);
      pbActive = pbRecv;
      fileSizeBytes = total;
      appendLog("ℹ", `Received TRACK_META: ${recvNumChunks} chunks, ${recvChunkSize} bytes/chunk, ${total} total bytes`);
      if (trackName) {
        trackName.textContent = "Receiving track...";
      }
      // Initialize availability tables
      initPeersByChunk(recvNumChunks);
      // Initialize blank bitmaps for all known peers
      for (const pid of dcByPeer.keys()) {
        if (!haveBitmapByPeer.has(pid)) {
          haveBitmapByPeer.set(pid, new Array(recvNumChunks).fill(0));
        }
      }
      initMediaSource();
      startAppendLoop();
      // Kick off requests
      appendLog("ℹ", `Starting chunk requests...`);
      scheduleRequests();
      // After knowing numChunks, share our HAVE bitmap
      sendHaveBitmap(channel);
    } else if (msg.t === "REQUEST") {
      // Host path: send requested chunk back
      const idx = msg.index | 0;
      if (!pbHost || !channel || channel.readyState !== "open") return;
      if (idx < 0 || idx >= pbHost.numChunks) return;
      const start = idx * pbHost.chunkSize;
      const payload = pbHost.readRange(start, pbHost.chunkSize);
      // Always send full chunkSize bytes (payload will be chunkSize since pbHost seeded)
      const header = {t: "DATA", index: idx, length: payload.length};
      try {
        channel.send(JSON.stringify(header));
        channel.send(payload);
        if (idx % 50 === 0) { // Log every 50th chunk to avoid spam
          appendLog("ℹ", `Sent chunk ${idx}/${pbHost.numChunks} to ${peerId}`);
        }
      } catch (e) {
        appendLog("!", `send DATA failed idx=${idx}`);
      }
    } else if (msg.t === "HAVE_BITMAP") {
      // Record peer's HAVE bitmap
      const arr = Array.isArray(msg.bitmap) ? msg.bitmap : [];
      const n = currentNumChunks();
      if (n > 0 && arr.length === n) {
        const normalized = new Array(n);
        for (let i = 0; i < n; i++) {
          normalized[i] = arr[i] ? 1 : 0;
        }
        haveBitmapByPeer.set(peerId, normalized);
        // Update availability table
        updatePeerAvailability(peerId, normalized);
        appendLog("ℹ", `HAVE_BITMAP from ${peerId} received`);
      }
    } else if (msg.t === "HAVE_DELTA_DC") {
      // Single chunk update from peer
      const idx = msg.index | 0;
      const n = currentNumChunks();
      if (idx >= 0 && idx < n) {
        markPeerHasChunk(peerId, idx);
      }
    } else if (msg.t === "DATA") {
      // Expect binary next
      pendingDataHeader = {index: msg.index | 0, length: msg.length | 0};
    }
  } catch (_) {
    // ignore
  }
}

function handleDCBinary(bytes, channel, peerId) {
  if (!pendingDataHeader || !pbRecv) return;
  const {index, length} = pendingDataHeader;
  pendingDataHeader = null;
  if (bytes.length !== length) {
    appendLog("!", `DATA length mismatch idx=${index} got=${bytes.length} expected=${length}`);
    return;
  }
  // Ensure chunk is chunkSize, pad if needed
  let payload = bytes;
  if (bytes.length !== pbRecv.chunkSize) {
    const padded = new Uint8Array(pbRecv.chunkSize);
    padded.set(bytes, 0);
    payload = padded;
  }
  pbRecv.setChunk(index, payload);
  inflight = Math.max(0, inflight - 1);
  if (index % 50 === 0) { // Log every 50th chunk to avoid spam
    appendLog("ℹ", `Received chunk ${index}/${pbRecv.numChunks} (${pbRecv.haveCount} total)`);
  }
  scheduleRequests();
  // Throttle broadcast of updated HAVE bitmap
  scheduleBitmapAnnounce(400);

  // Throughput accounting
  const now = performance.now();
  let peerStats = throughput.get(peerId);
  if (!peerStats) {
    peerStats = {lastTime: now, lastBytes: 0, rate: 0};
    throughput.set(peerId, peerStats);
  }

  // bytes.length is the chunk payload size
  const deltaBytes = bytes.length;
  const deltaTime = (now - peerStats.lastTime) / 1000;

  if (deltaTime > 0.05) {
    // update every 50ms
    peerStats.rate = deltaBytes / deltaTime; // bytes/sec
    peerStats.lastTime = now;
  }
}

function getUpstreamDc() {
  let ch = primaryUpstreamPeerId ? dcByPeer.get(primaryUpstreamPeerId) : null;
  if (!ch || ch.readyState !== "open") {
    for (const [pid, c] of dcByPeer.entries()) {
      if (c && c.readyState === "open") {
        primaryUpstreamPeerId = pid;
        return c;
      }
    }
    return null;
  }
  return ch;
}

function choosePeerForChunk(availablePeers, chunkIndex) {
  if (!availablePeers || availablePeers.length === 0) return null;

  // Filter peers that have this chunk
  const peersWithChunk = availablePeers.filter((peer) => {
    const bm = haveBitmapByPeer.get(peer.pid);
    return bm && bm[chunkIndex] === 1;
  });

  // If no peer has it (bitmap incomplete), use all peers
  const candidates =
    peersWithChunk.length > 0 ? peersWithChunk : availablePeers;

  // Round-robin selection
  const peer = candidates[rrIndex % candidates.length];
  rrIndex++;
  return peer;
}

function sendRequest(peerId, chunkIndex) {
  const ch = dcByPeer.get(peerId);
  if (!ch || ch.readyState !== "open") {
    appendLog("!", `Cannot request chunk ${chunkIndex}: channel to ${peerId} not ready`);
    return false;
  }
  const msg = {t: "REQUEST", index: chunkIndex};
  try {
    ch.send(JSON.stringify(msg));
    inflight++;
    if (chunkIndex === 0 || chunkIndex % 100 === 0) { // Log first and every 100th
      appendLog("ℹ", `Requesting chunk ${chunkIndex} from ${peerId}`);
    }
    return true;
  } catch (e) {
    appendLog("!", `Failed to request chunk ${chunkIndex}: ${e}`);
    return false;
  }
}

// Smart chunk scheduler: 3-phase strategy
function scheduleRequests() {
  if (!pbRecv) return;
  const numChunks = pbRecv.numChunks;
  if (numChunks <= 0) return;

  // Gather available peers
  const availablePeers = [];
  for (const [pid, ch] of dcByPeer.entries()) {
    if (ch && ch.readyState === "open") {
      availablePeers.push({pid, ch});
    }
  }
  if (availablePeers.length === 0) return;

  // Determine current playback position (in chunks)
  const currentTimeSec = (audioEl && audioEl.currentTime) || 0;
  const bytesPerSec =
    fileSizeBytes > 0 && audioEl && audioEl.duration > 0
      ? fileSizeBytes / audioEl.duration
      : 0;
  const playheadByte = bytesPerSec > 0 ? currentTimeSec * bytesPerSec : 0;
  const playheadChunk =
    pbRecv.chunkSize > 0 ? Math.floor(playheadByte / pbRecv.chunkSize) : 0;

  // Phase detection
  const startThresholdBytes = Math.max(0, Math.floor(startThresholdKB * 1024));
  const startupChunkThreshold =
    pbRecv.chunkSize > 0
      ? Math.ceil(startThresholdBytes / pbRecv.chunkSize)
      : 10;
  const contiguousEnd = pbRecv.contiguousChunkEnd || 0;
  const endgameThreshold = Math.floor(numChunks * 0.85); // last 15%
  const safeZoneChunks = 20; // ~20 chunks ahead of playhead

  let phase = "startup";
  if (contiguousEnd >= startupChunkThreshold) {
    if (pbRecv.haveCount >= endgameThreshold) {
      phase = "endgame";
    } else {
      phase = "stable";
    }
  }

  // Build candidate list based on phase
  const candidates = [];

  if (phase === "startup") {
    // PHASE 1: Sequential from 0 until startupChunkThreshold
    for (let i = 0; i < Math.min(startupChunkThreshold, numChunks); i++) {
      if (!pbRecv.have[i]) {
        candidates.push({index: i, priority: 1000000 - i}); // high priority, sequential
      }
    }
  } else if (phase === "stable") {
    // PHASE 2: Split-zone strategy
    const playbackZoneEnd = Math.min(playheadChunk + safeZoneChunks, numChunks);

    // Playback zone: sequential near playhead
    for (let i = playheadChunk; i < playbackZoneEnd; i++) {
      if (i >= 0 && i < numChunks && !pbRecv.have[i]) {
        candidates.push({index: i, priority: 2000000 - i}); // highest priority
      }
    }

    // Swarm zone: rarest-first beyond safe zone
    for (let i = playbackZoneEnd; i < numChunks; i++) {
      if (!pbRecv.have[i]) {
        const rarity = peersByChunk[i] ? peersByChunk[i].size : 0;
        // Lower rarity = higher priority (rarest first)
        const priority = 1000000 - rarity * 10000 + Math.random() * 100;
        candidates.push({index: i, priority});
      }
    }
  } else if (phase === "endgame") {
    // PHASE 3: Sequential tail, fill any gaps
    for (let i = 0; i < numChunks; i++) {
      if (!pbRecv.have[i]) {
        candidates.push({index: i, priority: 3000000 - i});
      }
    }
  }

  // Sort by priority (highest first)
  candidates.sort((a, b) => b.priority - a.priority);

  // Issue requests up to inflightMax using round-robin peer selection
  let issued = 0;
  for (const cand of candidates) {
    if (inflight >= inflightMax) break;
    const idx = cand.index;

    // Use round-robin to select peer for this chunk
    const selectedPeer = choosePeerForChunk(availablePeers, idx);

    if (selectedPeer && sendRequest(selectedPeer.pid, idx)) {
      issued++;
    }
  }
  
  if (issued === 0 && candidates.length > 0 && availablePeers.length === 0) {
    appendLog("!", `No peers available to request chunks from! Need P2P connections.`);
  }
}

function ensureConnections(peers) {
  (peers || []).forEach((p) => {
    const pid = p && p.peer_id;
    if (!pid || !myPeerId) return;
    if (pcByPeer.has(pid)) return;
    const initiate = !!(myPeerId && String(myPeerId) < String(pid));
    createPeerConnection(pid, initiate).catch(() => {});
  });
}
