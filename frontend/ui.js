const $ = (id) => document.getElementById(id);

export const ui = {
  statusPill: $("statusPill"),
  connectBtn: $("connectBtn"),
  disconnectBtn: $("disconnectBtn"),
  playBtn: $("playBtn"),
  pauseBtn: $("pauseBtn"),
  fileInput: $("fileInput"),
  audioEl: $("audioEl"),
  playerStatus: $("playerStatus"),
  bufferInfo: $("bufferInfo"),
  logBox: $("log"),
  consoleToggle: $("consoleToggle"),
  consoleContent: $("consoleContent"),
  consoleArrow: $("consoleArrow"),
  hostControls: $("hostControls"),
  trackName: $("trackName"),
  currentTime: $("currentTime"),
  progressBar: $("progressBar"),
};

export function initConsoleToggle() {
  if (!ui.consoleToggle || !ui.consoleContent || !ui.consoleArrow) return;
  ui.consoleToggle.onclick = () => {
    const hidden = ui.consoleContent.style.display === "none";
    ui.consoleContent.style.display = hidden ? "block" : "none";
    ui.consoleArrow.textContent = hidden ? "▲" : "▼";
  };
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function updateProgressDisplay(audioEl) {
  if (!audioEl) return;
  const currentPos = audioEl.currentTime || 0;
  const duration = audioEl.duration;

  if (ui.currentTime) {
    if (duration && isFinite(duration) && duration > 0) {
      ui.currentTime.textContent = `${formatTime(currentPos)} / ${formatTime(duration)}`;
    } else {
      ui.currentTime.textContent = formatTime(currentPos);
    }
  }

  if (ui.progressBar && duration && isFinite(duration) && duration > 0) {
    const percent = (currentPos / duration) * 100;
    ui.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
}

export function createProgressManager(audioEl) {
  let timer = null;
  return {
    update() {
      updateProgressDisplay(audioEl);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => updateProgressDisplay(audioEl), 200);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export function setConnected(connected, role) {
  if (connected) {
    ui.statusPill.textContent = "connected";
    ui.statusPill.classList.add("ok");
    ui.statusPill.classList.remove("bad");
    ui.connectBtn.disabled = true;
    ui.disconnectBtn.disabled = false;
    if (role === "host" && ui.hostControls) {
      ui.hostControls.style.display = "block";
      ui.playBtn.disabled = false;
      ui.pauseBtn.disabled = false;
    }
  } else {
    ui.statusPill.textContent = "disconnected";
    ui.statusPill.classList.add("bad");
    ui.statusPill.classList.remove("ok");
    ui.connectBtn.disabled = false;
    ui.disconnectBtn.disabled = true;
    if (ui.hostControls) {
      ui.hostControls.style.display = "none";
    }
    if (ui.playBtn) ui.playBtn.disabled = true;
    if (ui.pauseBtn) ui.pauseBtn.disabled = true;
  }
}

export function setPlayerStatus(text) {
  if (ui.playerStatus) ui.playerStatus.textContent = text;
}

export function setTrackName(name) {
  if (ui.trackName) ui.trackName.textContent = name;
}

export function setBufferInfo(text) {
  if (ui.bufferInfo) ui.bufferInfo.textContent = text;
}
