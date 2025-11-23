export const appState = {
  ws: null,
  currentRole: "viewer",
  myPeerId: null,
  myDisplayName: "User",
  playAuthorized: false,
  lastPeers: [],
  rtcConfig: {iceServers: [{urls: ["stun:stun.l.google.com:19302"]}]},
  graph: window.P2PGraph || {
    addOrUpdatePeer: () => {},
    removePeer: () => {},
    addLink: () => {},
    removeLink: () => {},
    hasPeer: () => false,
    reset: () => {},
  },
};
