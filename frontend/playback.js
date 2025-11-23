import {appState} from "./state.js";
import {
  createProgressManager,
  setBufferInfo,
  setPlayerStatus,
  setTrackName,
  ui,
} from "./ui.js";
import {appendLog} from "./logger.js";
import {PeerBuffer} from "./peer-buffer.js";

// Playback thresholds (hardcoded for simplicity)
const startThresholdKB = 256;
const rebufferThresholdSec = 2.0;
const resumeThresholdSec = 4.0;
const syncDriftThreshold = 0.1;

const progress = createProgressManager(ui.audioEl);

let playAuthorized = false;
let pbActive = null;
let pbHost = null;
let pbRecv = null;
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

// Sync state
let lastSyncTimestamp = 0;
let syncTimer = null;
let lastHostOffset = 0;
let syncCorrectionInProgress = false;
let hostPositionTimer = null;

let lastPeers = [];

// WebRTC DataChannel P2P for chunk transfer
let rtcConfig = appState.rtcConfig;
const pcByPeer = new Map();
const dcByPeer = new Map();
let primaryUpstreamPeerId = null;
let pendingDataHeader = null; // {index, length}
let inflightMax = 8;
const inflightByPeer = new Map(); // {peerId : in-flight request count}
const requestedChunks = new Set();
const requestTimestamps = new Map(); // {chunkIndex : timestamp}
const requestPeerMap = new Map(); // {chunkIndex : peerId}
let requestTimeoutTimer = null;
const REQUEST_TIMEOUT_MS = 10000;
let requestSchedulerTimer = null;
let recvNumChunks = 0;
let recvChunkSize = 0;
const haveBitmapByPeer = new Map(); // {peerId : Array<0|1>}
let bitmapAnnounceTimer = null;
let peersByChunk = [];
let rrIndex = 0;
const throughput = new Map(); // {peerId : {lastTime, lastBytes, rate}}
let announceTimer = null;

function resetSyncState() {
  lastSyncTimestamp = 0;
  lastHostOffset = 0;
  syncCorrectionInProgress = false;
}

function getBufferedAheadSec() {
  if (!ui.audioEl) return 0;
  const t = ui.audioEl.currentTime || 0;
  const ranges = ui.audioEl.buffered;
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
  if (!ui.audioEl) return;
  if (!playAuthorized) return;
  if (manualPaused) return;
  const startBytes = Math.max(0, Math.floor(startThresholdKB * 1024));
  const playable = pbActive ? pbActive.getLargestContiguousEnd() : 0;
  if (awaitingStart && playable >= startBytes) {
    ui.audioEl
      .play()
      .then(() => {
        awaitingStart = false;
        autoPaused = false;
      })
      .catch(() => {});
  } else if (autoPaused) {
    const ahead = getBufferedAheadSec();
    if (ahead >= resumeThresholdSec) {
      ui.audioEl
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
        if (
          mseAppendedBytes >= fileSizeBytes &&
          mediaSource.readyState === "open"
        ) {
          try {
            mediaSource.endOfStream();
          } catch (_) {}
        }
        maybeStartOrResume();
      } catch (e) {
        setPlayerStatus(`append error: ${e && e.message ? e.message : e}`);
      }
    }
  }, 200);

  if (rebufferTimer) {
    clearInterval(rebufferTimer);
    rebufferTimer = null;
  }
  rebufferTimer = setInterval(() => {
    const ahead = getBufferedAheadSec();
    setBufferInfo(`ahead=${ahead.toFixed(2)}s`);
    if (!awaitingStart && !ui.audioEl.paused && ahead < rebufferThresholdSec) {
      try {
        ui.audioEl.pause();
        autoPaused = true;
        manualPaused = false;
      } catch (_) {}
    } else if (autoPaused) {
      maybeStartOrResume();
    }
  }, 300);
}

function stopAppendLoop() {
  if (appendTimer) {
    clearInterval(appendTimer);
    appendTimer = null;
  }
  if (rebufferTimer) {
    clearInterval(rebufferTimer);
    rebufferTimer = null;
  }
}

function startPeriodicSync() {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    if (!ui.audioEl || !playAuthorized || ui.audioEl.paused) return;
    if (syncCorrectionInProgress) return;

    const currentPos = ui.audioEl.currentTime || 0;
    const now = Date.now() / 1000;

    if (lastSyncTimestamp > 0 && lastHostOffset >= 0) {
      const timeSinceSync = now - lastSyncTimestamp;
      const estimatedHostPos = lastHostOffset + timeSinceSync;
      const drift = Math.abs(currentPos - estimatedHostPos);

      if (drift > syncDriftThreshold) {
        const correctionAmount = drift > 0.5 ? drift : drift * 0.3;
        const targetPos =
          currentPos < estimatedHostPos
            ? currentPos + correctionAmount
            : currentPos - correctionAmount;

        try {
          const buffered = ui.audioEl.buffered;
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
            ui.audioEl.currentTime = targetPos;
            setTimeout(() => {
              syncCorrectionInProgress = false;
            }, 100);
            if (drift > 0.2) {
              appendLog(
                "ℹ",
                `Periodic sync: corrected drift ${drift.toFixed(2)}s`
              );
            }
          }
        } catch (_) {
          syncCorrectionInProgress = false;
        }
      }
    }
  }, 500);
}

function stopPeriodicSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

function startHostPositionBroadcast() {
  if (hostPositionTimer || appState.currentRole !== "host") return;
  hostPositionTimer = setInterval(() => {
    if (!ui.audioEl || !playAuthorized || ui.audioEl.paused) return;
    if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) return;

    const currentPos = ui.audioEl.currentTime || 0;
    const msg = {
      type: "PLAY",
      track_id: "t1",
      offset_sec: currentPos,
      timestamp: Date.now() / 1000,
    };
    try {
      appState.ws.send(JSON.stringify(msg));
    } catch (e) {
      appendLog("!", `Position broadcast failed: ${e}`);
    }
  }, 1500);
}

function stopHostPositionBroadcast() {
  if (hostPositionTimer) {
    clearInterval(hostPositionTimer);
    hostPositionTimer = null;
  }
}

function initMediaSource() {
  if (!ui.audioEl) return;
  try {
    stopAppendLoop();
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
  ui.audioEl.src = mediaObjectUrl;

  if (appState.currentRole === "host") {
    let lastSeekTime = 0;
    ui.audioEl.addEventListener("seeked", () => {
      if (!playAuthorized || ui.audioEl.paused) return;
      const now = Date.now();
      if (now - lastSeekTime < 200) return;
      lastSeekTime = now;

      const currentPos = ui.audioEl.currentTime || 0;
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

function announceNow() {
  if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) {
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
  appState.ws.send(JSON.stringify(msg));
}

function startPeriodicAnnounce() {
  if (announceTimer) return;
  announceTimer = setInterval(() => {
    announceNow();
  }, 10000);
}

function stopPeriodicAnnounce() {
  if (announceTimer) {
    clearInterval(announceTimer);
    announceTimer = null;
  }
}

function startRequestTimeoutChecker() {
  if (requestTimeoutTimer) return;
  requestTimeoutTimer = setInterval(() => {
    const now = Date.now();
    const timedOut = [];
    for (const [chunkIndex, timestamp] of requestTimestamps.entries()) {
      if (now - timestamp > REQUEST_TIMEOUT_MS) {
        timedOut.push(chunkIndex);
      }
    }
    if (timedOut.length > 0) {
      appendLog("!", `${timedOut.length} requests timed out, will retry`);
      for (const idx of timedOut) {
        requestedChunks.delete(idx);
        requestTimestamps.delete(idx);
        requestPeerMap.delete(idx);
      }
      if (pbRecv) {
        scheduleRequests();
      }
    }
  }, 5000);
}

function stopRequestTimeoutChecker() {
  if (requestTimeoutTimer) {
    clearInterval(requestTimeoutTimer);
    requestTimeoutTimer = null;
  }
}

function startRequestScheduler() {
  if (requestSchedulerTimer) return;
  requestSchedulerTimer = setInterval(() => {
    if (pbRecv && pbRecv.haveCount < pbRecv.numChunks) {
      scheduleRequests();
    } else if (pbRecv && pbRecv.haveCount >= pbRecv.numChunks) {
      stopRequestScheduler();
    }
  }, 1000);
}

function stopRequestScheduler() {
  if (requestSchedulerTimer) {
    clearInterval(requestSchedulerTimer);
    requestSchedulerTimer = null;
  }
}

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
  for (let i = 0; i < peersByChunk.length; i++) {
    peersByChunk[i].delete(peerId);
  }
  for (let i = 0; i < bitmap.length; i++) {
    if (bitmap[i]) {
      peersByChunk[i].add(peerId);
    }
  }
}

function markPeerHasChunk(peerId, chunkIndex) {
  if (chunkIndex < 0 || chunkIndex >= peersByChunk.length) return;
  peersByChunk[chunkIndex].add(peerId);
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
  inflightByPeer.clear();
  requestedChunks.clear();
  requestTimestamps.clear();
  requestPeerMap.clear();
  recvNumChunks = 0;
  recvChunkSize = 0;
  haveBitmapByPeer.clear();
  peersByChunk = [];
  stopPeriodicAnnounce();
  stopRequestTimeoutChecker();
  stopRequestScheduler();
}

function sendSignal(to, blob) {
  if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) {
    appendLog("!", "Not connected (WS) for signaling");
    return;
  }
  const msg = {type: "SIGNAL", to, blob};
  appState.ws.send(JSON.stringify(msg));
  appendLog("→", {SIGNAL: blob.wrtc || blob});
}

function broadcastGraphConnection(peerA, peerB, isConnected) {
  if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) return;
  if (!Array.isArray(lastPeers)) return;

  const eventType = isConnected ? "PEER_CONNECTED" : "PEER_DISCONNECTED";
  const blob = {
    graph_event: eventType,
    peer_a: peerA,
    peer_b: peerB,
  };

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
      const lostInflight = inflightByPeer.get(toPeerId) || 0;
      if (lostInflight > 0) {
        appendLog(
          "ℹ",
          `Lost ${lostInflight} inflight requests to ${toPeerId}, will retry`
        );
        const chunksToRetry = [];
        for (const [chunkIdx, peerId] of requestPeerMap.entries()) {
          if (peerId === toPeerId) {
            chunksToRetry.push(chunkIdx);
          }
        }
        for (const chunkIdx of chunksToRetry) {
          requestedChunks.delete(chunkIdx);
          requestTimestamps.delete(chunkIdx);
          requestPeerMap.delete(chunkIdx);
        }
      }
      inflightByPeer.delete(toPeerId);
      haveBitmapByPeer.delete(toPeerId);
      for (let i = 0; i < peersByChunk.length; i++) {
        peersByChunk[i].delete(toPeerId);
      }
      if (pbRecv) {
        scheduleRequests();
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
    const myId = appState.myPeerId;
    appState.graph.addLink(myId, peerId);
    broadcastGraphConnection(myId, peerId, true);

    if (!inflightByPeer.has(peerId)) {
      inflightByPeer.set(peerId, 0);
    }

    if (primaryUpstreamPeerId === null) {
      primaryUpstreamPeerId = peerId;
    }

    const numChunks = currentNumChunks();
    if (numChunks > 0 && !haveBitmapByPeer.has(peerId)) {
      haveBitmapByPeer.set(peerId, new Array(numChunks).fill(0));
    }

    if (pbHost && channel.readyState === "open") {
      const meta = {
        t: "TRACK_META",
        numChunks: pbHost.numChunks,
        chunkSize: pbHost.chunkSize,
        totalSize: pbHost.totalSize,
      };
      channel.send(JSON.stringify(meta));
      sendHaveBitmap(channel);
    } else if (pbRecv && channel.readyState === "open") {
      sendHaveBitmap(channel);
    }
  };
  channel.onclose = () => {
    appendLog("ℹ", `datachannel close (${peerId})`);
    const myId = appState.myPeerId;
    appState.graph.removeLink(myId, peerId);
    broadcastGraphConnection(myId, peerId, false);
    inflightByPeer.delete(peerId);
  };
  channel.onerror = (e) =>
    appendLog(
      "!",
      `datachannel error (${peerId}) ${e && e.message ? e.message : ""}`
    );
  channel.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      handleDCText(ev.data, channel, peerId);
    } else if (ev.data instanceof ArrayBuffer) {
      handleDCBinary(new Uint8Array(ev.data), channel, peerId);
    } else if (ev.data && ev.data.arrayBuffer) {
      ev.data
        .arrayBuffer()
        .then((buf) => handleDCBinary(new Uint8Array(buf), channel, peerId));
    }
  };
}

function handleDCText(text, channel, peerId) {
  try {
    const msg = JSON.parse(text);
    if (msg.t === "TRACK_META") {
      recvNumChunks = msg.numChunks | 0;
      recvChunkSize = msg.chunkSize | 0;
      const total = msg.totalSize | 0;
      pbRecv = new PeerBuffer(recvNumChunks, recvChunkSize);
      pbActive = pbRecv;
      fileSizeBytes = total;
      appendLog(
        "ℹ",
        `Received TRACK_META: ${recvNumChunks} chunks, ${recvChunkSize} bytes/chunk, ${total} total bytes`
      );
      setTrackName("Receiving track...");
      initPeersByChunk(recvNumChunks);
      for (const pid of dcByPeer.keys()) {
        if (!haveBitmapByPeer.has(pid)) {
          haveBitmapByPeer.set(pid, new Array(recvNumChunks).fill(0));
        }
      }
      initMediaSource();
      startAppendLoop();
      startPeriodicAnnounce();
      announceNow();
      startRequestTimeoutChecker();
      startRequestScheduler();
      appendLog("ℹ", `Starting chunk requests...`);
      scheduleRequests();
      broadcastHaveBitmap();
    } else if (msg.t === "REQUEST") {
      const idx = msg.index | 0;
      if (!pbHost || !channel || channel.readyState !== "open") return;
      if (idx < 0 || idx >= pbHost.numChunks) return;
      const start = idx * pbHost.chunkSize;
      const payload = pbHost.readRange(start, pbHost.chunkSize);
      const header = {t: "DATA", index: idx, length: payload.length};
      try {
        channel.send(JSON.stringify(header));
        channel.send(payload);
        if (idx % 50 === 0) {
          appendLog("ℹ", `Sent chunk ${idx}/${pbHost.numChunks} to ${peerId}`);
        }
      } catch (_) {
        appendLog("!", `send DATA failed idx=${idx}`);
      }
    } else if (msg.t === "HAVE_BITMAP") {
      const arr = Array.isArray(msg.bitmap) ? msg.bitmap : [];
      const n = currentNumChunks();
      if (n > 0 && arr.length === n) {
        const normalized = new Array(n);
        for (let i = 0; i < n; i++) {
          normalized[i] = arr[i] ? 1 : 0;
        }
        haveBitmapByPeer.set(peerId, normalized);
        updatePeerAvailability(peerId, normalized);
        appendLog("ℹ", `HAVE_BITMAP from ${peerId} received`);
      }
    } else if (msg.t === "HAVE_DELTA_DC") {
      const idx = msg.index | 0;
      const n = currentNumChunks();
      if (idx >= 0 && idx < n) {
        markPeerHasChunk(peerId, idx);
      }
    } else if (msg.t === "DATA") {
      pendingDataHeader = {index: msg.index | 0, length: msg.length | 0};
    }
  } catch (_) {}
}

function handleDCBinary(bytes, channel, peerId) {
  if (!pendingDataHeader || !pbRecv) return;
  const {index, length} = pendingDataHeader;
  pendingDataHeader = null;
  if (bytes.length !== length) {
    appendLog(
      "!",
      `DATA length mismatch idx=${index} got=${bytes.length} expected=${length}`
    );
    return;
  }
  let payload = bytes;
  if (bytes.length !== pbRecv.chunkSize) {
    const padded = new Uint8Array(pbRecv.chunkSize);
    padded.set(bytes, 0);
    payload = padded;
  }
  pbRecv.setChunk(index, payload);

  const currentInflight = inflightByPeer.get(peerId) || 0;
  inflightByPeer.set(peerId, Math.max(0, currentInflight - 1));

  requestedChunks.delete(index);
  requestTimestamps.delete(index);
  requestPeerMap.delete(index);

  if (index % 50 === 0) {
    appendLog(
      "ℹ",
      `Received chunk ${index}/${pbRecv.numChunks} from ${peerId} (${pbRecv.haveCount} total)`
    );
  }
  scheduleRequests();
  scheduleBitmapAnnounce(400);

  const now = performance.now();
  let peerStats = throughput.get(peerId);
  if (!peerStats) {
    peerStats = {lastTime: now, lastBytes: 0, rate: 0};
    throughput.set(peerId, peerStats);
  }
  const deltaBytes = bytes.length;
  const deltaTime = (now - peerStats.lastTime) / 1000;
  if (deltaTime > 0.05) {
    peerStats.rate = deltaBytes / deltaTime;
    peerStats.lastTime = now;
  }
}

function choosePeerForChunk(availablePeers, chunkIndex) {
  if (!availablePeers || availablePeers.length === 0) return null;
  const peersWithChunk = availablePeers.filter((peer) => {
    const bm = haveBitmapByPeer.get(peer.pid);
    return bm && bm[chunkIndex] === 1;
  });
  const candidates =
    peersWithChunk.length > 0 ? peersWithChunk : availablePeers;
  const peer = candidates[rrIndex % candidates.length];
  rrIndex++;
  return peer;
}

function sendRequest(peerId, chunkIndex) {
  const ch = dcByPeer.get(peerId);
  if (!ch || ch.readyState !== "open") {
    appendLog(
      "!",
      `Cannot request chunk ${chunkIndex}: channel to ${peerId} not ready`
    );
    return false;
  }
  if (requestedChunks.has(chunkIndex)) {
    return false;
  }
  const currentInflight = inflightByPeer.get(peerId) || 0;
  if (currentInflight >= inflightMax) {
    return false;
  }
  const msg = {t: "REQUEST", index: chunkIndex};
  try {
    ch.send(JSON.stringify(msg));
    inflightByPeer.set(peerId, currentInflight + 1);
    requestedChunks.add(chunkIndex);
    requestTimestamps.set(chunkIndex, Date.now());
    requestPeerMap.set(chunkIndex, peerId);
    if (chunkIndex === 0 || chunkIndex % 100 === 0) {
      appendLog(
        "ℹ",
        `Requesting chunk ${chunkIndex} from ${peerId} (inflight: ${currentInflight + 1})`
      );
    }
    return true;
  } catch (e) {
    appendLog("!", `Failed to request chunk ${chunkIndex}: ${e}`);
    return false;
  }
}

function scheduleRequests() {
  if (!pbRecv) return;
  const numChunks = pbRecv.numChunks;
  if (numChunks <= 0) return;

  const availablePeers = [];
  for (const [pid, ch] of dcByPeer.entries()) {
    if (ch && ch.readyState === "open") {
      availablePeers.push({pid, ch});
    }
  }
  if (availablePeers.length === 0) return;

  const currentTimeSec = (ui.audioEl && ui.audioEl.currentTime) || 0;
  const bytesPerSec =
    fileSizeBytes > 0 && ui.audioEl && ui.audioEl.duration > 0
      ? fileSizeBytes / ui.audioEl.duration
      : 0;
  const playheadByte = bytesPerSec > 0 ? currentTimeSec * bytesPerSec : 0;
  const playheadChunk =
    pbRecv.chunkSize > 0 ? Math.floor(playheadByte / pbRecv.chunkSize) : 0;

  const startThresholdBytes = Math.max(0, Math.floor(startThresholdKB * 1024));
  const startupChunkThreshold =
    pbRecv.chunkSize > 0
      ? Math.ceil(startThresholdBytes / pbRecv.chunkSize)
      : 10;
  const contiguousEnd = pbRecv.contiguousChunkEnd || 0;
  const endgameThreshold = Math.floor(numChunks * 0.85);
  const safeZoneChunks = 20;

  let phase = "startup";
  if (contiguousEnd >= startupChunkThreshold) {
    if (pbRecv.haveCount >= endgameThreshold) {
      phase = "endgame";
    } else {
      phase = "stable";
    }
  }

  const candidates = [];

  if (phase === "startup") {
    for (let i = 0; i < Math.min(startupChunkThreshold, numChunks); i++) {
      if (!pbRecv.have[i]) {
        candidates.push({index: i, priority: 1000000 - i});
      }
    }
  } else if (phase === "stable") {
    const playbackZoneEnd = Math.min(playheadChunk + safeZoneChunks, numChunks);
    for (let i = playheadChunk; i < playbackZoneEnd; i++) {
      if (i >= 0 && i < numChunks && !pbRecv.have[i]) {
        candidates.push({index: i, priority: 2000000 - i});
      }
    }
    for (let i = playbackZoneEnd; i < numChunks; i++) {
      if (!pbRecv.have[i]) {
        const rarity = peersByChunk[i] ? peersByChunk[i].size : 0;
        const priority = 1000000 - rarity * 10000 + Math.random() * 100;
        candidates.push({index: i, priority});
      }
    }
  } else if (phase === "endgame") {
    for (let i = 0; i < numChunks; i++) {
      if (!pbRecv.have[i]) {
        candidates.push({index: i, priority: 3000000 - i});
      }
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);

  let issued = 0;
  for (const cand of candidates) {
    const idx = cand.index;
    const selectedPeer = choosePeerForChunk(availablePeers, idx);
    if (selectedPeer && sendRequest(selectedPeer.pid, idx)) {
      issued++;
    }
    const totalInflight = Array.from(inflightByPeer.values()).reduce(
      (sum, val) => sum + val,
      0
    );
    if (totalInflight >= inflightMax * availablePeers.length) {
      break;
    }
  }

  if (Math.random() < 0.1 || issued === 0) {
    const totalInflight = Array.from(inflightByPeer.values()).reduce(
      (sum, val) => sum + val,
      0
    );
    appendLog(
      "ℹ",
      `Schedule: phase=${phase}, have=${pbRecv.haveCount}/${numChunks}, candidates=${candidates.length}, issued=${issued}, inflight=${totalInflight}, peers=${availablePeers.length}`
    );
  }

  if (issued === 0 && candidates.length > 0 && availablePeers.length === 0) {
    appendLog(
      "!",
      `No peers available to request chunks from! Need P2P connections.`
    );
  }
}

function ensureConnections(peers) {
  (peers || []).forEach((p) => {
    const pid = p && p.peer_id;
    if (!pid || !appState.myPeerId) return;
    if (pcByPeer.has(pid)) return;
    const initiate = !!(
      appState.myPeerId && String(appState.myPeerId) < String(pid)
    );
    createPeerConnection(pid, initiate).catch(() => {});
  });
}

export function handleIncomingState(p) {
  playAuthorized = p.status === "PLAY";
  if (p.status === "PLAY") {
    progress.start();
    manualPaused = false;
    if (
      p.offset_sec !== undefined &&
      typeof p.offset_sec === "number" &&
      ui.audioEl
    ) {
      const receiveTime = Date.now() / 1000;
      const hostTimestamp = p.timestamp || receiveTime;
      const timeSinceHostAction = Math.max(0, receiveTime - hostTimestamp);
      const targetPosition = p.offset_sec + timeSinceHostAction;

      lastHostOffset = p.offset_sec;
      lastSyncTimestamp = hostTimestamp;

      const currentPos = ui.audioEl.currentTime || 0;
      const drift = Math.abs(currentPos - targetPosition);

      if (drift > syncDriftThreshold || currentPos === 0) {
        try {
          const buffered = ui.audioEl.buffered;
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
            ui.audioEl.currentTime = targetPosition;
            appendLog(
              "ℹ",
              `Synced to position ${targetPosition.toFixed(2)}s (drift was ${drift.toFixed(2)}s)`
            );
          }
        } catch (e) {
          appendLog("!", `Sync seek failed: ${e}`);
        }
      }
    }
    maybeStartOrResume();
  } else if (p.status === "PAUSE") {
    progress.stop();
    progress.update();
    try {
      if (ui.audioEl) ui.audioEl.pause();
      if (p.offset_sec !== undefined && typeof p.offset_sec === "number") {
        const currentPos = ui.audioEl.currentTime || 0;
        const drift = Math.abs(currentPos - p.offset_sec);
        if (drift > syncDriftThreshold) {
          try {
            ui.audioEl.currentTime = p.offset_sec;
          } catch (_) {}
        }
      }
    } catch (_) {}
    autoPaused = false;
    awaitingStart = true;
  }

  if (p.status === "PLAY") {
    if (appState.currentRole === "viewer") {
      startPeriodicSync();
    } else if (appState.currentRole === "host") {
      startHostPositionBroadcast();
    }
  } else {
    stopPeriodicSync();
    stopHostPositionBroadcast();
  }
}

export function handlePeerMessage(peerId) {
  appState.myPeerId = peerId;
  appState.graph.addOrUpdatePeer(peerId, {
    isHost: appState.currentRole === "host",
    displayName: appState.myDisplayName,
  });
}

export function handlePeersList(peers) {
  lastPeers = peers || [];
  appState.lastPeers = lastPeers;
  try {
    ensureConnections(peers || []);
    (peers || []).forEach((p) => {
      appState.graph.addOrUpdatePeer(p.peer_id, {
        ip: p.ip,
        port: p.port,
        have: p.have_count,
        displayName: p.display_name,
        isHost: !!p.is_host,
      });
    });
  } catch (_) {}
}

export async function handleSignalMessage(msg) {
  const from = msg.from || "(unknown)";
  const blob = msg.blob || {};
  if (blob && blob.graph_event === "PEER_CONNECTED") {
    const peerA = blob.peer_a;
    const peerB = blob.peer_b;
    if (peerA && peerB) {
      appState.graph.addLink(peerA, peerB);
      appendLog("ℹ", `Graph: ${peerA} ↔ ${peerB}`);
    }
  } else if (blob && blob.graph_event === "PEER_DISCONNECTED") {
    const peerA = blob.peer_a;
    const peerB = blob.peer_b;
    if (peerA && peerB) {
      appState.graph.removeLink(peerA, peerB);
      appendLog("ℹ", `Graph: ${peerA} ✗ ${peerB}`);
    }
  }

  if (blob && blob.wrtc && from !== "(unknown)") {
    if (blob.wrtc === "offer") {
      const pc = await createPeerConnection(from, false);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(blob.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(from, {wrtc: "answer", sdp: answer});
      } catch (_) {
        appendLog("!", "Offer handling failed");
      }
    } else if (blob.wrtc === "answer") {
      try {
        const pc = pcByPeer.get(from);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(blob.sdp));
        }
      } catch (_) {
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
      appState.graph.removePeer(departed);
      if (Array.isArray(lastPeers)) {
        lastPeers = lastPeers.filter((p) => p.peer_id !== departed);
      }
      appendLog("ℹ", `Peer ${departed} disconnected`);
    }
  }
}

export function notifyPeersOfGraphLeave() {
  if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) return;
  if (!appState.myPeerId) return;
  const peers = Array.isArray(lastPeers) ? lastPeers : [];
  peers.forEach((peer) => {
    if (!peer || !peer.peer_id || peer.peer_id === appState.myPeerId) return;
    const msg = {
      type: "SIGNAL",
      to: peer.peer_id,
      blob: {graph_event: "PEER_LEFT", peer_id: appState.myPeerId},
    };
    try {
      appState.ws.send(JSON.stringify(msg));
    } catch (_) {}
  });
}

export function disconnectCleanup() {
  if (appState.myPeerId) {
    appState.graph.removePeer(appState.myPeerId);
  }
  appState.graph.reset();
  stopPeriodicSync();
  stopHostPositionBroadcast();
  progress.stop();
  stopPeriodicAnnounce();
  stopRequestTimeoutChecker();
  stopRequestScheduler();
  resetSyncState();
  playAuthorized = false;
  resetP2P();
  stopAppendLoop();
  pbActive = null;
  pbHost = null;
  pbRecv = null;
  fileSizeBytes = 0;
}

export function sendControl(type) {
  if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) {
    appendLog("!", "Not connected");
    return;
  }
  const offset =
    ui.audioEl &&
    ui.audioEl.currentTime !== undefined &&
    ui.audioEl.currentTime !== null
      ? ui.audioEl.currentTime
      : 0;
  const msg = {
    type,
    track_id: "t1",
    offset_sec: offset,
    timestamp: Date.now() / 1000,
  };
  appState.ws.send(JSON.stringify(msg));
  appendLog("→", msg);

  if (type === "PLAY" && appState.currentRole === "host") {
    startHostPositionBroadcast();
  } else if (type === "PAUSE" && appState.currentRole === "host") {
    stopHostPositionBroadcast();
  }
}

function setHostBuffer(buffer, chunkSize, totalSize, filename) {
  pbHost = buffer;
  pbActive = pbHost;
  fileSizeBytes = totalSize;
  setTrackName(filename || "Unknown Track");
  initPeersByChunk(pbHost.numChunks);
  for (const pid of dcByPeer.keys()) {
    if (!haveBitmapByPeer.has(pid)) {
      haveBitmapByPeer.set(pid, new Array(pbHost.numChunks).fill(0));
    }
  }
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
  announceNow();
  startPeriodicAnnounce();
  initMediaSource();
  startAppendLoop();
  if (ui.audioEl) {
    ui.audioEl.addEventListener(
      "loadedmetadata",
      () => {
        progress.update();
      },
      {once: true}
    );
  }
}

async function loadFile(file) {
  if (!file) return;
  const cSize = 4096;
  try {
    setPlayerStatus("reading file...");
    const buf = new Uint8Array(await file.arrayBuffer());
    const totalSize = buf.length;
    const nChunks = Math.ceil(totalSize / cSize);
    const buffer = new PeerBuffer(nChunks, cSize);
    for (let idx = 0; idx < nChunks; idx++) {
      const start = idx * cSize;
      const end = Math.min(start + cSize, totalSize);
      const slice = buf.slice(start, end);
      let payload = slice;
      if (slice.length < cSize) {
        const padded = new Uint8Array(cSize);
        padded.set(slice, 0);
        payload = padded;
      }
      buffer.setChunk(idx, payload);
    }
    appendLog(
      "ℹ",
      `Loaded ${file.name} (${totalSize} bytes) into RAM as ${nChunks} chunks`
    );
    setHostBuffer(buffer, cSize, totalSize, file.name);
  } catch (e) {
    setPlayerStatus(`load error: ${e && e.message ? e.message : e}`);
  }
}

export function initFileInput() {
  if (!ui.fileInput) return;
  ui.fileInput.onchange = async () => {
    const file =
      ui.fileInput.files && ui.fileInput.files[0]
        ? ui.fileInput.files[0]
        : null;
    await loadFile(file);
  };
}

export function setRtcConfig(newConfig) {
  rtcConfig = newConfig || rtcConfig;
  appState.rtcConfig = rtcConfig;
}

export function handleHaveAnnounce() {
  announceNow();
}

export function handleWsClosed() {
  disconnectCleanup();
}

export function handleStatePlayPause(status) {
  if (status === "PLAY") {
    playAuthorized = true;
  } else {
    playAuthorized = false;
  }
}

export function setRole(role) {
  appState.currentRole = role;
}

export function handleWsMessage(msg) {
  if (msg.type === "STATE") {
    const p = msg.payload || {};
    handleStatePlayPause(p.status);
    handleIncomingState(p);
  } else if (msg.type === "PEER") {
    if (msg.peer_id) {
      handlePeerMessage(msg.peer_id);
    }
  } else if (msg.type === "PEERS") {
    handlePeersList(msg.peers || []);
  } else if (msg.type === "SIGNAL") {
    handleSignalMessage(msg);
  }
}

export function handleDisconnectUi() {
  playAuthorized = false;
  appState.myPeerId = null;
}

export function handlePlayClick() {
  manualPaused = false;
  sendControl("PLAY");
}

export function handlePauseClick() {
  manualPaused = true;
  sendControl("PAUSE");
  stopHostPositionBroadcast();
}
