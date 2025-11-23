import {appState} from "./state.js";
import {appendLog} from "./logger.js";
import {
  handleDisconnectUi,
  handlePauseClick,
  handlePlayClick,
  handleWsClosed,
  handleWsMessage,
  initFileInput,
  notifyPeersOfGraphLeave,
  setRole,
  setRtcConfig,
  handleHaveAnnounce,
} from "./playback.js";
import {initConsoleToggle, setConnected, ui} from "./ui.js";

initConsoleToggle();
initFileInput();

async function fetchIceServers() {
  try {
    const response = await fetch("/api/ice-servers");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data && data.iceServers) {
      setRtcConfig({iceServers: data.iceServers});
      appendLog(
        "ℹ",
        `Loaded ICE servers: ${data.iceServers.length} server(s)`
      );
    }
  } catch (e) {
    appendLog("!", `Failed to load ICE servers: ${e.message}, using STUN only`);
  }
}

let cleanedUp = false;

function cleanupConnection() {
  if (cleanedUp) return;
  cleanedUp = true;
  setConnected(false, appState.currentRole);
  handleDisconnectUi();
  handleWsClosed();
}

function handleOpenWs(role, displayName) {
  setConnected(true, role);
  const hello = {type: "HELLO", role, display_name: displayName};
  appState.ws.send(JSON.stringify(hello));
  appendLog("→", hello);
  fetchIceServers().finally(() => {
    handleHaveAnnounce();
  });
  cleanedUp = false;
}

function handleMessage(ev) {
  try {
    const msg = JSON.parse(ev.data);
    if (
      msg.type !== "STATE" ||
      !msg.payload ||
      msg.payload.status !== "PLAY" ||
      Math.random() < 0.1
    ) {
      appendLog(
        "←",
        typeof ev.data === "string" ? ev.data : JSON.stringify(msg)
      );
    }
    handleWsMessage(msg);
  } catch (e) {
    appendLog("!", `WS parse error: ${e.message || e}`);
  }
}

function handleClosed(ev) {
  appendLog(
    "!",
    `WebSocket closed (${ev.code}${ev.reason ? ": " + ev.reason : ""})`
  );
  cleanupConnection();
  appState.ws = null;
}

function closeCurrentWs() {
  if (appState.ws && appState.ws.readyState === WebSocket.OPEN) {
    notifyPeersOfGraphLeave();
    appState.ws.onclose = null;
    appState.ws.close();
    appendLog("!", "WebSocket closed (client request)");
  }
  appState.ws = null;
  cleanupConnection();
}

function connect() {
  const url = document.getElementById("wsUrl").value.trim();
  const roleInput = [...document.querySelectorAll('input[name="role"]')].find(
    (r) => r.checked
  );
  const role = roleInput ? roleInput.value : "viewer";
  const displayName =
    document.getElementById("displayName").value.trim() || "User";

  appState.myDisplayName = displayName;
  setRole(role);

  appendLog("→", `Connecting to ${url} ...`);
  appState.ws = new WebSocket(url);

  appState.ws.onopen = () => handleOpenWs(role, displayName);
  appState.ws.onmessage = handleMessage;
  appState.ws.onerror = () => appendLog("!", "WebSocket error");
  appState.ws.onclose = handleClosed;
}

ui.connectBtn.onclick = connect;
ui.disconnectBtn.onclick = () => closeCurrentWs();
ui.playBtn.onclick = () => handlePlayClick();
ui.pauseBtn.onclick = () => handlePauseClick();

window.addEventListener("beforeunload", () => notifyPeersOfGraphLeave());
