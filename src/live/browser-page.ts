// Loopback page for `live.audio: "browser"`. The browser is the WebRTC media peer
// (microphone, speaker, echo cancellation); pi keeps signaling, sideband, and
// delegation. The page never sees provider credentials: the URL fragment holds
// only the local page token. Keep this script free of backticks and `${`.
export const BROWSER_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi live voice</title>
<style>
  body { font: 16px system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #ddd; background: #111; }
  button { font: inherit; padding: .5rem 1rem; }
  meter { width: 100%; }
  #status { margin: 1rem 0; }
</style>
</head>
<body>
<h1>pi live voice</h1>
<p id="status">Starting…</p>
<p><button id="enable" hidden>Enable audio</button> <button id="reconnect" hidden>Reconnect</button></p>
<p>Microphone <meter id="mic" max="0.3"></meter></p>
<p>Speaker <meter id="speaker" max="0.3"></meter></p>
<p><small>Keep this tab open. Use headphones for the best barge-in.</small></p>
<script>
"use strict";
const token = decodeURIComponent(location.hash.slice(1));
const $ = (id) => document.getElementById(id);
const audio = new Audio();
audio.autoplay = true;
let ws, pc, stream, context, stopMeter, retry = 0, unlocked = false, live = false;
let unlockWaiters = [];

function status(text) { $("status").textContent = text; }
function send(message) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function idleText() { return unlocked ? "Connected to pi. Waiting for /live to take the floor…" : "Connected to pi. Click Enable audio."; }
function callText() {
  if (stream && stream.getAudioTracks().every((track) => !track.enabled)) return "Muted in pi.";
  return live ? "Live. Speak to pi." : "Connecting voice…";
}

function hangup() {
  live = false;
  if (stopMeter) { stopMeter(); stopMeter = undefined; }
  if (pc) { pc.close(); pc = undefined; }
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = undefined; }
  audio.srcObject = null;
  $("mic").value = 0; $("speaker").value = 0;
}

function fail(error) {
  const message = (error && error.message) || String(error);
  send({ type: "failure", message: "Browser audio: " + message });
  hangup();
  status("Error: " + message);
}

function rms(analyser, buffer) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function startMeter(remote) {
  if (stopMeter) stopMeter();
  const mic = context.createAnalyser(), speaker = context.createAnalyser();
  mic.fftSize = speaker.fftSize = 1024;
  const micSource = context.createMediaStreamSource(stream);
  const speakerSource = context.createMediaStreamSource(remote);
  micSource.connect(mic);
  speakerSource.connect(speaker);
  const buffer = new Float32Array(1024);
  const timer = setInterval(() => {
    const muted = !stream || stream.getAudioTracks().every((track) => !track.enabled);
    const input = muted ? 0 : rms(mic, buffer), output = rms(speaker, buffer);
    $("mic").value = input; $("speaker").value = output;
    send({ type: "levels", input, output });
  }, 100);
  stopMeter = () => { clearInterval(timer); micSource.disconnect(); speakerSource.disconnect(); };
}

function iceGathered(connection) {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === "complete") return resolve();
    connection.addEventListener("icegatheringstatechange", () => {
      if (connection.iceGatheringState === "complete") resolve();
    });
    setTimeout(resolve, 2000);
  });
}

async function startCall() {
  if (!unlocked) {
    status("pi wants to talk. Click Enable audio.");
    await new Promise((resolve) => unlockWaiters.push(resolve));
  }
  hangup();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const connection = new RTCPeerConnection();
  pc = connection;
  stream.getTracks().forEach((track) => connection.addTrack(track, stream));
  const channel = connection.createDataChannel("oai-events");
  channel.onopen = () => { live = true; send({ type: "open" }); status(callText()); };
  channel.onmessage = (event) => send({ type: "event", payload: String(event.data) });
  connection.ontrack = (event) => {
    audio.srcObject = event.streams[0];
    audio.play().catch(() => {});
    startMeter(event.streams[0]);
  };
  connection.onconnectionstatechange = () => {
    if (pc === connection && connection.connectionState === "failed") fail(new Error("WebRTC connection failed"));
  };
  await connection.setLocalDescription(await connection.createOffer());
  await iceGathered(connection);
  if (pc !== connection) return;
  send({ type: "offer", sdp: connection.localDescription.sdp });
  status("Connecting voice…");
}

async function handle(message) {
  if (message.type === "offer.request") await startCall();
  else if (message.type === "answer" && pc) await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
  else if (message.type === "mute" && stream) {
    stream.getAudioTracks().forEach((track) => { track.enabled = !message.muted; });
    status(callText());
  } else if (message.type === "hangup") { hangup(); status(idleText()); }
}

function connect() {
  $("reconnect").hidden = true;
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onopen = () => { retry = 0; send({ type: "hello", token }); status(idleText()); };
  ws.onmessage = (event) => { handle(JSON.parse(event.data)).catch(fail); };
  ws.onclose = (event) => {
    hangup();
    if (event.code === 4001) { status("pi rejected this page. Open the URL that pi printed."); return; }
    if (event.code === 4000) { status("Another tab took over pi live audio."); $("reconnect").hidden = false; return; }
    // Bounded retries: each refused attempt can print an SSH forwarding error on the client.
    if (event.code === 4002 || retry >= 6) {
      status("pi live voice is off. Run /live in pi, then click Reconnect.");
      $("reconnect").hidden = false;
      return;
    }
    status("Waiting for pi. Run /live in pi…");
    setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
  };
}

$("enable").onclick = async () => {
  try {
    context = new AudioContext();
    await context.resume();
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((track) => track.stop());
    unlocked = true;
    $("enable").hidden = true;
    unlockWaiters.splice(0).forEach((resolve) => resolve());
    status(ws && ws.readyState === WebSocket.OPEN ? idleText() : "Audio enabled. Waiting for pi…");
  } catch (error) {
    status("Microphone unavailable: " + ((error && error.message) || error));
  }
};
$("reconnect").onclick = () => { retry = 0; connect(); };

if (!window.isSecureContext || !navigator.mediaDevices) {
  status("Open this page as http://localhost:PORT (forward the port over SSH); browsers block the microphone elsewhere.");
} else if (!token) {
  status("Missing page token. Open the full URL that pi printed.");
} else {
  $("enable").hidden = false;
  connect();
}
</script>
</body>
</html>
`;
