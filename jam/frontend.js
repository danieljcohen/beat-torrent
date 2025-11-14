    const $ = (id) => document.getElementById(id);
    const logBox = $('log');
    const statusPill = $('statusPill');
    const stateLine = $('stateLine');
    const connectBtn = $('connectBtn');
    const disconnectBtn = $('disconnectBtn');
    const playBtn = $('playBtn');
    const pauseBtn = $('pauseBtn');
    const myPeerIdInput = $('myPeerId');
    const toPeerIdInput = $('toPeerId');
    const signalBlobInput = $('signalBlob');
    const signalBtn = $('signalBtn');
    const connectP2pBtn = $('connectP2pBtn');
    const disconnectP2pBtn = $('disconnectP2pBtn');
    const roomName = $('roomName');
    const announcePort = $('announcePort');
    const totalChunks = $('totalChunks');
    const chunkSize = $('chunkSize');
    const haveCount = $('haveCount');
    const autoAnnounce = $('autoAnnounce');
    const announceBtn = $('announceBtn');
    const deltaIndices = $('deltaIndices');
    const sendDeltaBtn = $('sendDeltaBtn');
    const runPhase1Btn = $('runPhase1Btn');
    const fileInput = $('fileInput');
    const loadMp3Btn = $('loadMp3Btn');
    const audioEl = $('audioEl');
    const playerStatus = $('playerStatus');
    const bufferInfo = $('bufferInfo');
    const startThresholdKB = $('startThresholdKB');
    const rebufferThresholdSec = $('rebufferThresholdSec');
    const resumeThresholdSec = $('resumeThresholdSec');

    let ws = null;
    let currentRole = 'viewer';
    function now() { return new Date().toLocaleTimeString(); }
    function appendLog(direction, payload) {
      const pre = document.createElement('div');
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      pre.textContent = `[${now()}] ${direction} ${text}`;
      logBox.appendChild(pre);
      logBox.scrollTop = logBox.scrollHeight;
    }
    function setConnected(connected) {
      if (connected) {
        statusPill.textContent = 'connected';
        statusPill.classList.add('ok'); statusPill.classList.remove('bad');
        connectBtn.disabled = true; disconnectBtn.disabled = false;
        playBtn.disabled = (currentRole !== 'host'); pauseBtn.disabled = (currentRole !== 'host'); signalBtn.disabled = false;
      } else {
        statusPill.textContent = 'disconnected';
        statusPill.classList.add('bad'); statusPill.classList.remove('ok');
        connectBtn.disabled = false; disconnectBtn.disabled = true;
        playBtn.disabled = true; pauseBtn.disabled = true; signalBtn.disabled = true;
        myPeerIdInput.value = '(none)';
        playAuthorized = false;
      }
    }

    connectBtn.onclick = () => {
      const url = $('wsUrl').value.trim();
      const role = [...document.querySelectorAll('input[name="role"]')].find(r => r.checked).value;
      const displayName = $('displayName').value.trim() || 'Debug';
      currentRole = role;

      appendLog('→', `Connecting to ${url} ...`);
      ws = new WebSocket(url);

      ws.onopen = () => {
        setConnected(true);
        const hello = { type: 'HELLO', role, display_name: displayName };
        ws.send(JSON.stringify(hello));
        appendLog('→', hello);
        if (autoAnnounce.checked) {
          announceNow();
        }
      };
      ws.onmessage = async (ev) => {
        appendLog('←', ev.data);
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'STATE') {
            const p = msg.payload || {};
            stateLine.textContent = `STATE: track=${p.track_id ?? '(none)'} status=${p.status} offset=${p.offset_sec} ts=${p.timestamp}`;
            // Host broadcasts control, all clients honor it
            playAuthorized = (p.status === 'PLAY');
            if (p.status === 'PLAY') {
              manualPaused = false;
              maybeStartOrResume();
            } else if (p.status === 'PAUSE') {
              try { if (audioEl) audioEl.pause(); } catch (_) {}
              autoPaused = false;
              // Keep awaitingStart true to require threshold on next PLAY
              awaitingStart = true;
            }
          } else if (msg.type === 'PEER') {
            if (msg.peer_id) {
              myPeerIdInput.value = msg.peer_id;
            }
          } else if (msg.type === 'PEERS') {
            renderSwarm(msg.peers || []);
            try { ensureConnections(msg.peers || []); } catch (_) {}
          } else if (msg.type === 'SIGNAL') {
            const from = msg.from || '(unknown)';
            const blob = msg.blob || {};
            // WebRTC signaling
            if (blob && blob.wrtc && from !== '(unknown)') {
              if (blob.wrtc === 'offer') {
                // Answerer path
                const pc = await createPeerConnection(from, false);
                try {
                  await pc.setRemoteDescription(new RTCSessionDescription(blob.sdp));
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);
                  sendSignal(from, { wrtc: 'answer', sdp: answer });
                } catch (e) {
                  appendLog('!', `offer handling failed`);
                }
              } else if (blob.wrtc === 'answer') {
                try {
                  const pc = pcByPeer.get(from);
                  if (pc) {
                    await pc.setRemoteDescription(new RTCSessionDescription(blob.sdp));
                  }
                } catch (e) {
                  appendLog('!', `answer handling failed`);
                }
              } else if (blob.wrtc === 'ice' && blob.candidate) {
                try {
                  const pc = pcByPeer.get(from);
                  if (pc) {
                    await pc.addIceCandidate(new RTCIceCandidate(blob.candidate));
                  }
                } catch (e) {
                  // ignore
                }
              }
            } else {
              // Show who sent it and the blob contents
              appendLog('←', `SIGNAL from ${from}: ${JSON.stringify(msg.blob)}`);
            }
          }
        } catch (_) {}
      };
      ws.onerror = () => appendLog('!', 'WebSocket error');
      ws.onclose = (ev) => {
        appendLog('!', `WebSocket closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`);
        setConnected(false);
      };
    };

    disconnectBtn.onclick = () => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      ws = null;
    };

    function sendControl(type) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendLog('!', 'Not connected');
        return;
      }
      const msg = {
        type,
        track_id: $('trackId').value || null,
        offset_sec: parseFloat($('offsetSec').value || '0') || 0,
        timestamp: Date.now() / 1000,
      };
      ws.send(JSON.stringify(msg));
      appendLog('→', msg);
    }

    playBtn.onclick = () => sendControl('PLAY');
    pauseBtn.onclick = () => sendControl('PAUSE');

    signalBtn.onclick = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendLog('!', 'Not connected');
        return;
      }
      const to = toPeerIdInput.value.trim();
      if (!to) {
        appendLog('!', 'Enter target peer id');
        return;
      }
      let blob;
      try {
        blob = JSON.parse(signalBlobInput.value || '{}');
      } catch (e) {
        appendLog('!', `Invalid JSON: ${e}`);
        return;
      }
      const msg = { type: 'SIGNAL', to, blob };
      ws.send(JSON.stringify(msg));
      appendLog('→', msg);
    };

    function announceNow() {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendLog('!', 'Not connected');
        return;
      }
      const msg = {
        type: 'ANNOUNCE',
        room: roomName.value || 'jam1',
        port: parseInt(announcePort.value || '0', 10),
        total_chunks: parseInt(totalChunks.value || '0', 10),
        chunk_size: parseInt(chunkSize.value || '0', 10),
        have_count: parseInt(haveCount.value || '0', 10),
      };
      ws.send(JSON.stringify(msg));
      appendLog('→', msg);
    }
    announceBtn.onclick = announceNow;

    sendDeltaBtn.onclick = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendLog('!', 'Not connected');
        return;
      }
      const indices = (deltaIndices.value || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n));
      const msg = {
        type: 'HAVE_DELTA',
        room: roomName.value || 'jam1',
        indices,
      };
      ws.send(JSON.stringify(msg));
      appendLog('→', msg);
    };

    // Swarm rendering
    const swarmTable = document.querySelector('#swarmTable tbody');
    let lastPeers = [];
    function renderSwarm(peers){
      lastPeers = peers || [];
      if (!swarmTable) return;
      swarmTable.innerHTML = '';
      lastPeers.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td>${p.peer_id}</td><td>${p.ip}</td><td>${p.port}</td><td>${p.have_count ?? 0}</td>`;
        swarmTable.appendChild(tr);
      });
    }


    // In-browser RAM buffer with contiguous guard
    class PeerBuffer {
      constructor(numChunks, chunkSize){
        this.numChunks = numChunks|0;
        this.chunkSize = chunkSize|0;
        this.totalSize = this.numChunks * this.chunkSize;
        this.buffer = new Uint8Array(this.totalSize);
        this.have = new Array(this.numChunks).fill(false);
        this.haveCount = 0;
        this.contiguousChunkEnd = 0; // exclusive
        this.contiguousByteEnd = 0;  // exclusive
      }
      setChunk(index, payload){
        if (index < 0 || index >= this.numChunks) return false;
        if (!(payload instanceof Uint8Array)) return false;
        if (payload.length !== this.chunkSize) return false;
        const start = index * this.chunkSize;
        this.buffer.set(payload, start);
        if (!this.have[index]) {
          this.have[index] = true;
          this.haveCount++;
          // advance contiguous window
          while (this.contiguousChunkEnd < this.numChunks && this.have[this.contiguousChunkEnd]) {
            this.contiguousChunkEnd++;
          }
          this.contiguousByteEnd = Math.min(this.contiguousChunkEnd * this.chunkSize, this.totalSize);
        }
        return true;
      }
      readRange(start, length){
        if (start < 0 || length <= 0) return new Uint8Array(0);
        const maxEnd = Math.min(this.totalSize, this.contiguousByteEnd);
        let end = start + length;
        if (end > maxEnd) end = maxEnd;
        if (start >= end) return new Uint8Array(0);
        // Since we clamp to contiguousByteEnd, the slice is safe
        return this.buffer.slice(start, end);
      }
      getLargestContiguousEnd(){
        return this.contiguousByteEnd;
      }
    }


    // Minimal MSE player fed from active PeerBuffer (host or viewer)
    let pbActive = null;      // currently playing buffer
    let pbHost = null;        // host's buffer (when file loaded)
    let pbRecv = null;        // viewer's download buffer
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

    function setPlayerStatus(text){
      if (playerStatus) playerStatus.textContent = text;
    }

    function initMediaSource(){
      if (!audioEl) return;
      // Cleanup previous media source if any
      try {
        if (appendTimer) { clearInterval(appendTimer); appendTimer = null; }
        if (rebufferTimer) { clearInterval(rebufferTimer); rebufferTimer = null; }
        if (mediaSource && mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream(); } catch (_) {}
        }
        if (mediaObjectUrl) {
          try { URL.revokeObjectURL(mediaObjectUrl); } catch (_) {}
          mediaObjectUrl = null;
        }
      } catch (_) {}
      mediaSource = new MediaSource();
      mediaObjectUrl = URL.createObjectURL(mediaSource);
      audioEl.src = mediaObjectUrl;
      mediaSource.addEventListener('sourceopen', () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', () => {
            maybeStartOrResume();
          });
          setPlayerStatus('MSE ready');
        } catch (e) {
          setPlayerStatus(`MSE init error: ${e && e.message ? e.message : e}`);
        }
      }, { once: true });
    }

    function getBufferedAheadSec(){
      if (!audioEl) return 0;
      const t = audioEl.currentTime || 0;
      const ranges = audioEl.buffered;
      for (let i=0;i<ranges.length;i++){
        const start = ranges.start(i);
        const end = ranges.end(i);
        if (t >= start && t <= end) {
          return Math.max(0, end - t);
        }
      }
      return 0;
    }

    function maybeStartOrResume(){
      if (!audioEl) return;
      // Only start/resume when host has sent PLAY
      if (!playAuthorized) return;
      // Respect manual pause; don't auto-resume if user paused
      if (manualPaused) return;
      const startKB = parseFloat(startThresholdKB && startThresholdKB.value ? startThresholdKB.value : '256') || 256;
      const startBytes = Math.max(0, Math.floor(startKB * 1024));
      const playable = pbActive ? pbActive.getLargestContiguousEnd() : 0;
      if (awaitingStart && playable >= startBytes) {
        audioEl.play().then(() => {
          awaitingStart = false;
          autoPaused = false;
        }).catch(() => {});
      } else if (autoPaused) {
        const threshSec = Math.max(0.1, parseFloat(rebufferThresholdSec && rebufferThresholdSec.value ? rebufferThresholdSec.value : '2.0') || 2.0);
        let resumeSec = parseFloat(resumeThresholdSec && resumeThresholdSec.value ? resumeThresholdSec.value : '4.0');
        if (!Number.isFinite(resumeSec) || resumeSec <= 0) resumeSec = Math.max(threshSec * 2, threshSec + 0.5);
        const ahead = getBufferedAheadSec();
        if (ahead >= resumeSec) {
          audioEl.play().then(() => { autoPaused = false; }).catch(() => {});
        }
      }
    }

    function startAppendLoop(){
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
        const playableEnd = Math.min(pbActive.getLargestContiguousEnd(), fileSizeBytes);
        if (mseAppendedBytes >= playableEnd) return;
        const toAppend = pbActive.readRange(mseAppendedBytes, playableEnd - mseAppendedBytes);
        if (toAppend && toAppend.length > 0) {
          try {
            sourceBuffer.appendBuffer(toAppend);
            mseAppendedBytes += toAppend.length;
            setPlayerStatus(`appended=${mseAppendedBytes}/${fileSizeBytes}`);
            // End of stream if fully appended
            if (mseAppendedBytes >= fileSizeBytes && mediaSource.readyState === 'open') {
              try { mediaSource.endOfStream(); } catch (_) {}
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
          try { bufferInfo.textContent = `ahead=${ahead.toFixed(2)}s`; } catch (_) {}
        }
        const threshSec = Math.max(0.1, parseFloat(rebufferThresholdSec && rebufferThresholdSec.value ? rebufferThresholdSec.value : '2.0') || 2.0);
        if (!awaitingStart && !audioEl.paused && ahead < threshSec) {
          // Auto-pause to prevent glitching; continue appending
          try { audioEl.pause(); autoPaused = true; manualPaused = false; } catch (_) {}
        } else if (autoPaused) {
          maybeStartOrResume();
        }
      }, 300);
    }

    if (loadMp3Btn) {
      loadMp3Btn.onclick = async () => {
        const file = (fileInput && fileInput.files && fileInput.files[0]) ? fileInput.files[0] : null;
        if (!file) {
          appendLog('!', 'Select an MP3 file first');
          return;
        }
        const cSize = parseInt(chunkSize.value || '0', 10);
        if (!Number.isFinite(cSize) || cSize <= 0) {
          appendLog('!', 'Invalid Chunk Size');
          return;
        }
        try {
          setPlayerStatus('reading file...');
          const buf = new Uint8Array(await file.arrayBuffer());
          fileSizeBytes = buf.length;
          const nChunks = Math.ceil(fileSizeBytes / cSize);
          if (totalChunks) totalChunks.value = String(nChunks);
          pbHost = new PeerBuffer(nChunks, cSize);
          // Fill chunks; pad final chunk if needed
          for (let idx=0; idx<nChunks; idx++){
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
          if (haveCount) haveCount.value = String(pbActive.haveCount);
          appendLog('ℹ', `Loaded ${file.name} (${fileSizeBytes} bytes) into RAM as ${nChunks} chunks`);
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
            const meta = { t: 'TRACK_META', numChunks: pbHost.numChunks, chunkSize: pbHost.chunkSize, totalSize: pbHost.totalSize };
            for (const [pid, ch] of dcByPeer.entries()) {
              if (ch && ch.readyState === 'open') {
                try { ch.send(JSON.stringify(meta)); } catch (_) {}
                try { sendHaveBitmap(ch); } catch (_) {}
              }
            }
            appendLog('ℹ', 'Sent TRACK_META to open peers');
          } catch (_) {}
          initMediaSource();
          startAppendLoop();
        } catch (e) {
          setPlayerStatus(`load error: ${e && e.message ? e.message : e}`);
        }
      };
    }

    // WebRTC DataChannel P2P for chunk transfer
    const rtcConfig = { 
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] },
        // Free TURN servers (use for testing only, get your own for production)
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ],
      // Force relay for restrictive networks (university WiFi):
      iceTransportPolicy: 'relay'
    };
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

    function currentNumChunks(){
      if (pbHost && Number.isFinite(pbHost.numChunks)) return pbHost.numChunks|0;
      if (pbRecv && Number.isFinite(pbRecv.numChunks)) return pbRecv.numChunks|0;
      return 0;
    }

    function buildLocalBitmap(){
      const n = currentNumChunks();
      if (n <= 0) return [];
      const src = pbHost ? pbHost.have : (pbRecv ? pbRecv.have : null);
      if (!src || !Array.isArray(src)) return new Array(n).fill(0);
      const out = new Array(n);
      for (let i=0;i<n;i++){ out[i] = src[i] ? 1 : 0; }
      return out;
    }

    function sendHaveBitmap(channel){
      if (!channel || channel.readyState !== 'open') return;
      const n = currentNumChunks();
      if (!Number.isFinite(n) || n <= 0) return;
      const bitmap = buildLocalBitmap();
      try { channel.send(JSON.stringify({ t: 'HAVE_BITMAP', bitmap })); } catch (_) {}
    }

    function broadcastHaveBitmap(){
      const n = currentNumChunks();
      if (!Number.isFinite(n) || n <= 0) return;
      for (const [, ch] of dcByPeer.entries()){
        if (ch && ch.readyState === 'open') {
          sendHaveBitmap(ch);
        }
      }
    }

    function scheduleBitmapAnnounce(delayMs = 300){
      if (bitmapAnnounceTimer) return;
      bitmapAnnounceTimer = setTimeout(() => {
        bitmapAnnounceTimer = null;
        try { broadcastHaveBitmap(); } catch (_) {}
      }, Math.max(0, delayMs|0));
    }

    function initPeersByChunk(numChunks){
      peersByChunk = new Array(numChunks|0);
      for (let i=0; i<peersByChunk.length; i++){
        peersByChunk[i] = new Set();
      }
    }

    function updatePeerAvailability(peerId, bitmap){
      if (!Array.isArray(bitmap) || bitmap.length !== peersByChunk.length) return;
      // Remove this peer from all chunks first
      for (let i=0; i<peersByChunk.length; i++){
        peersByChunk[i].delete(peerId);
      }
      // Add peer to chunks they have
      for (let i=0; i<bitmap.length; i++){
        if (bitmap[i]) {
          peersByChunk[i].add(peerId);
        }
      }
    }

    function markPeerHasChunk(peerId, chunkIndex){
      if (chunkIndex < 0 || chunkIndex >= peersByChunk.length) return;
      peersByChunk[chunkIndex].add(peerId);
      // Also update bitmap if exists
      const bm = haveBitmapByPeer.get(peerId);
      if (bm && chunkIndex < bm.length) {
        bm[chunkIndex] = 1;
      }
    }

    function resetP2P(){
      try { for (const ch of dcByPeer.values()) { try { ch.close(); } catch (_) {} } } catch (_) {}
      try { for (const p of pcByPeer.values()) { try { p.close(); } catch (_) {} } } catch (_) {}
      pcByPeer.clear();
      dcByPeer.clear();
      primaryUpstreamPeerId = null;
      pendingDataHeader = null;
      inflight = 0; nextToRequest = 0;
      recvNumChunks = 0; recvChunkSize = 0;
      haveBitmapByPeer.clear();
      peersByChunk = [];
    }

    function sendSignal(to, blob){
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendLog('!', 'Not connected (WS) for signaling');
        return;
      }
      const msg = { type: 'SIGNAL', to, blob };
      ws.send(JSON.stringify(msg));
      appendLog('→', {SIGNAL: blob});
    }

    async function createPeerConnection(toPeerId, isInitiator){
      if (pcByPeer.has(toPeerId)) {
        return pcByPeer.get(toPeerId);
      }
      const pc = new RTCPeerConnection(rtcConfig);
      pcByPeer.set(toPeerId, pc);
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendSignal(toPeerId, { wrtc: 'ice', candidate: e.candidate });
        }
      };
      pc.onconnectionstatechange = () => {
        appendLog('ℹ', `pc(${toPeerId}) state=${pc.connectionState}`);
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          try { const ch = dcByPeer.get(toPeerId); if (ch) { try { ch.close(); } catch (_) {} } } catch (_) {}
          dcByPeer.delete(toPeerId);
          pcByPeer.delete(toPeerId);
          if (primaryUpstreamPeerId === toPeerId) {
            primaryUpstreamPeerId = null;
          }
          // Clean up peer availability
          haveBitmapByPeer.delete(toPeerId);
          for (let i=0; i<peersByChunk.length; i++){
            peersByChunk[i].delete(toPeerId);
          }
        }
      };
      if (isInitiator) {
        const dc = pc.createDataChannel('data', { ordered: true });
        dcByPeer.set(toPeerId, dc);
        wireDataChannel(dc, toPeerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(toPeerId, { wrtc: 'offer', sdp: offer });
      } else {
        pc.ondatachannel = (ev) => {
          const ch = ev.channel;
          dcByPeer.set(toPeerId, ch);
          wireDataChannel(ch, toPeerId);
        };
      }
      return pc;
    }

    function wireDataChannel(channel, peerId){
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => {
        appendLog('ℹ', `datachannel open (${peerId})`);
        if (primaryUpstreamPeerId === null) {
          primaryUpstreamPeerId = peerId;
        }
        // If we are the host (have pbHost loaded), send TRACK_META
        if (pbHost && channel.readyState === 'open') {
          const meta = { t: 'TRACK_META', numChunks: pbHost.numChunks, chunkSize: pbHost.chunkSize, totalSize: pbHost.totalSize };
          channel.send(JSON.stringify(meta));
          // Share initial HAVE bitmap
          sendHaveBitmap(channel);
        }
      };
      channel.onclose = () => appendLog('ℹ', `datachannel close (${peerId})`);
      channel.onerror = (e) => appendLog('!', `datachannel error (${peerId}) ${e && e.message ? e.message : ''}`);
      channel.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          handleDCText(ev.data, channel, peerId);
        } else if (ev.data instanceof ArrayBuffer) {
          handleDCBinary(new Uint8Array(ev.data), channel, peerId);
        } else {
          // Blob fallback
          if (ev.data && ev.data.arrayBuffer) {
            ev.data.arrayBuffer().then(buf => handleDCBinary(new Uint8Array(buf), channel, peerId));
          }
        }
      };
    }

    function handleDCText(text, channel, peerId){
      try {
        const msg = JSON.parse(text);
        if (msg.t === 'TRACK_META') {
          // Viewer path: initialize receiver buffer and player
          recvNumChunks = msg.numChunks|0;
          recvChunkSize = msg.chunkSize|0;
          const total = msg.totalSize|0;
          inflight = 0;
          nextToRequest = 0;
          pbRecv = new PeerBuffer(recvNumChunks, recvChunkSize);
          pbActive = pbRecv;
          fileSizeBytes = total;
          if (totalChunks) totalChunks.value = String(recvNumChunks);
          if (chunkSize) chunkSize.value = String(recvChunkSize);
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
          scheduleRequests();
          // After knowing numChunks, share our HAVE bitmap
          sendHaveBitmap(channel);
        } else if (msg.t === 'REQUEST') {
          // Host path: send requested chunk back
          const idx = msg.index|0;
          if (!pbHost || !channel || channel.readyState !== 'open') return;
          if (idx < 0 || idx >= pbHost.numChunks) return;
          const start = idx * pbHost.chunkSize;
          const payload = pbHost.readRange(start, pbHost.chunkSize);
          // Always send full chunkSize bytes (payload will be chunkSize since pbHost seeded)
          const header = { t: 'DATA', index: idx, length: payload.length };
          try {
            channel.send(JSON.stringify(header));
            channel.send(payload);
          } catch (e) {
            appendLog('!', `send DATA failed idx=${idx}`);
          }
        } else if (msg.t === 'HAVE_BITMAP') {
          // Record peer's HAVE bitmap
          const arr = Array.isArray(msg.bitmap) ? msg.bitmap : [];
          const n = currentNumChunks();
          if (n > 0 && arr.length === n) {
            const normalized = new Array(n);
            for (let i=0;i<n;i++){ normalized[i] = arr[i] ? 1 : 0; }
            haveBitmapByPeer.set(peerId, normalized);
            // Update availability table
            updatePeerAvailability(peerId, normalized);
            appendLog('ℹ', `HAVE_BITMAP from ${peerId} received`);
          }
        } else if (msg.t === 'HAVE_DELTA_DC') {
          // Single chunk update from peer
          const idx = msg.index|0;
          const n = currentNumChunks();
          if (idx >= 0 && idx < n) {
            markPeerHasChunk(peerId, idx);
            appendLog('ℹ', `HAVE_DELTA_DC from ${peerId} chunk=${idx}`);
          }
        } else if (msg.t === 'DATA') {
          // Expect binary next
          pendingDataHeader = { index: msg.index|0, length: msg.length|0 };
        }
      } catch (_) {
        // ignore
      }
    }

    function handleDCBinary(bytes, channel, peerId){
      if (!pendingDataHeader || !pbRecv) return;
      const { index, length } = pendingDataHeader;
      pendingDataHeader = null;
      if (bytes.length !== length) {
        appendLog('!', `DATA length mismatch idx=${index} got=${bytes.length} expected=${length}`);
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
      if (haveCount) haveCount.value = String(pbRecv.haveCount);
      scheduleRequests();
      // Throttle broadcast of updated HAVE bitmap
      scheduleBitmapAnnounce(400);
    }

    function getUpstreamDc(){
      let ch = primaryUpstreamPeerId ? dcByPeer.get(primaryUpstreamPeerId) : null;
      if (!ch || ch.readyState !== 'open') {
        for (const [pid, c] of dcByPeer.entries()) {
          if (c && c.readyState === 'open') {
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
      const peersWithChunk = availablePeers.filter(peer => {
        const bm = haveBitmapByPeer.get(peer.pid);
        return bm && bm[chunkIndex] === 1;
      });

      // If no peer has it (bitmap incomplete), use all peers
      const candidates = peersWithChunk.length > 0 ? peersWithChunk : availablePeers;
      
      // Round-robin selection
      const peer = candidates[rrIndex % candidates.length];
      rrIndex++;
      return peer;
    }

    function sendRequest(peerId, chunkIndex) {
      const ch = dcByPeer.get(peerId);
      if (!ch || ch.readyState !== 'open') return false;
      const msg = { t: 'REQUEST', index: chunkIndex };
      try {
        ch.send(JSON.stringify(msg));
        inflight++;
        return true;
      } catch (_) {
        return false;
      }
    }

    // Smart chunk scheduler: 3-phase strategy
    function scheduleRequests(){
      if (!pbRecv) return;
      const numChunks = pbRecv.numChunks;
      if (numChunks <= 0) return;

      // Gather available peers
      const availablePeers = [];
      for (const [pid, ch] of dcByPeer.entries()) {
        if (ch && ch.readyState === 'open') {
          availablePeers.push({ pid, ch });
        }
      }
      if (availablePeers.length === 0) return;

      // Determine current playback position (in chunks)
      const currentTimeSec = (audioEl && audioEl.currentTime) || 0;
      const bytesPerSec = fileSizeBytes > 0 && audioEl && audioEl.duration > 0 ? fileSizeBytes / audioEl.duration : 0;
      const playheadByte = bytesPerSec > 0 ? currentTimeSec * bytesPerSec : 0;
      const playheadChunk = pbRecv.chunkSize > 0 ? Math.floor(playheadByte / pbRecv.chunkSize) : 0;

      // Phase detection
      const startThresholdBytes = Math.max(0, Math.floor((parseFloat(startThresholdKB && startThresholdKB.value ? startThresholdKB.value : '256') || 256) * 1024));
      const startupChunkThreshold = pbRecv.chunkSize > 0 ? Math.ceil(startThresholdBytes / pbRecv.chunkSize) : 10;
      const contiguousEnd = pbRecv.contiguousChunkEnd || 0;
      const endgameThreshold = Math.floor(numChunks * 0.85); // last 15%
      const safeZoneChunks = 20; // ~20 chunks ahead of playhead

      let phase = 'startup';
      if (contiguousEnd >= startupChunkThreshold) {
        if (pbRecv.haveCount >= endgameThreshold) {
          phase = 'endgame';
        } else {
          phase = 'stable';
        }
      }

      // Build candidate list based on phase
      const candidates = [];

      if (phase === 'startup') {
        // PHASE 1: Sequential from 0 until startupChunkThreshold
        for (let i = 0; i < Math.min(startupChunkThreshold, numChunks); i++) {
          if (!pbRecv.have[i]) {
            candidates.push({ index: i, priority: 1000000 - i }); // high priority, sequential
          }
        }
      } else if (phase === 'stable') {
        // PHASE 2: Split-zone strategy
        const playbackZoneEnd = Math.min(playheadChunk + safeZoneChunks, numChunks);
        
        // Playback zone: sequential near playhead
        for (let i = playheadChunk; i < playbackZoneEnd; i++) {
          if (i >= 0 && i < numChunks && !pbRecv.have[i]) {
            candidates.push({ index: i, priority: 2000000 - i }); // highest priority
          }
        }

        // Swarm zone: rarest-first beyond safe zone
        for (let i = playbackZoneEnd; i < numChunks; i++) {
          if (!pbRecv.have[i]) {
            const rarity = peersByChunk[i] ? peersByChunk[i].size : 0;
            // Lower rarity = higher priority (rarest first)
            const priority = 1000000 - (rarity * 10000) + (Math.random() * 100);
            candidates.push({ index: i, priority });
          }
        }
      } else if (phase === 'endgame') {
        // PHASE 3: Sequential tail, fill any gaps
        for (let i = 0; i < numChunks; i++) {
          if (!pbRecv.have[i]) {
            candidates.push({ index: i, priority: 3000000 - i });
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
    }

    function ensureConnections(peers){
      const myId = (myPeerIdInput && myPeerIdInput.value && myPeerIdInput.value !== '(none)') ? myPeerIdInput.value : null;
      (peers || []).forEach(p => {
        const pid = p && p.peer_id;
        if (!pid) return;
        if (pcByPeer.has(pid)) return;
        const initiate = !!(myId && String(myId) < String(pid));
        createPeerConnection(pid, initiate).catch(() => {});
      });
    }

    if (connectP2pBtn) {
      connectP2pBtn.onclick = async () => {
        const to = (toPeerIdInput && toPeerIdInput.value || '').trim();
        if (!to) { appendLog('!', 'Enter target peer id'); return; }
        if (!ws || ws.readyState !== WebSocket.OPEN) { appendLog('!', 'Connect WS first'); return; }
        await createPeerConnection(to, true);
      };
    }
    if (disconnectP2pBtn) {
      disconnectP2pBtn.onclick = () => {
        resetP2P();
        appendLog('ℹ', 'P2P disconnected');
      };
    }

