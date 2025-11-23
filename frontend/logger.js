import {ui} from "./ui.js";

export function now() {
  return new Date().toLocaleTimeString();
}

export function appendLog(direction, payload) {
  if (ui.logBox) {
    const pre = document.createElement("div");
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    pre.textContent = `[${now()}] ${direction} ${text}`;
    ui.logBox.appendChild(pre);
    ui.logBox.scrollTop = ui.logBox.scrollHeight;
  }
  console.log(
    `${direction} ${typeof payload === "string" ? payload : JSON.stringify(payload)}`
  );
}
