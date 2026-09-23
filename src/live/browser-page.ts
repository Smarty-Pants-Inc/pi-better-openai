// Loopback page for `live.audio: "browser"`. The browser is the WebRTC media peer
// (microphone, speaker, echo cancellation); pi keeps signaling, sideband, and
// delegation. The page never sees provider credentials: the URL fragment holds
// only the local page token. Keep this script free of backticks and `${`.
//
// Audio devices are chosen by label, because browsers rotate device IDs per origin: an exact
// label match first, then a substring match, never the "default"/"communications" aliases.
// A choice made in the page is kept in localStorage and beats the config default that pi sends
// ("audio.defaults"). A missing device warns and falls back to the system default. The page
// never changes operating system audio settings.
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
  select { font: inherit; max-width: 100%; }
  #device-warning { color: #fc6; }
</style>
</head>
<body>
<h1>pi live voice</h1>
<p id="status">Starting…</p>
<p><button id="enable" hidden>Enable audio</button> <button id="reconnect" hidden>Reconnect</button></p>
<p>Microphone <meter id="mic" max="0.3"></meter></p>
<p>Speaker <meter id="speaker" max="0.3"></meter></p>
<p><label>Microphone device <select id="input-device"><option value="">System default</option></select></label></p>
<p><label>Speaker device <select id="output-device"><option value="">System default</option></select></label></p>
<p id="device-warning" role="alert"></p>
<p><small>Keep this tab open. Use headphones for the best barge-in.</small></p>
<script>
"use strict";
const token = decodeURIComponent(location.hash.slice(1));
const $ = (id) => document.getElementById(id);
const audio = new Audio();
audio.autoplay = true;
let ws, pc, stream, remote, context, stopMeter, retry = 0, unlocked = false, live = false;
let unlockWaiters = [];

const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const KINDS = { input: "audioinput", output: "audiooutput" };
const STORE = { input: "pi-live-audio-input", output: "pi-live-audio-output" };
const NAMES = { input: "Microphone", output: "Speaker" };
const configured = { input: "", output: "" };
const warnings = { input: "", output: "" };
let devices = [], openedMic = "", applying = Promise.resolve();

function storage() { try { return window.localStorage; } catch (error) { return undefined; } }
function preferred(kind) {
  try {
    const saved = storage() && storage().getItem(STORE[kind]);
    if (typeof saved === "string") return saved.trim();
  } catch (error) {}
  return configured[kind].trim();
}
function isAlias(device) { return device.deviceId === "default" || device.deviceId === "communications"; }
// Browsers hide labels until microphone permission; warn only once labels are known.
function labelsKnown(kind) { return devices.some((device) => device.kind === KINDS[kind] && device.label); }
function listed(kind) { return devices.filter((device) => device.kind === KINDS[kind] && device.label && !isAlias(device)); }
function chosen(kind) {
  const wanted = preferred(kind).toLowerCase();
  if (!wanted) return undefined;
  const list = listed(kind);
  return list.find((device) => device.label.toLowerCase() === wanted) ||
    list.find((device) => device.label.toLowerCase().includes(wanted));
}
function checkDevice(kind) {
  const wanted = preferred(kind), device = chosen(kind);
  warnings[kind] = wanted && !device && labelsKnown(kind)
    ? NAMES[kind] + ' "' + wanted + '" is not available. Using the system default.' : "";
  return device;
}

function renderDevices() {
  for (const kind of ["input", "output"]) {
    const select = $(kind + "-device"), wanted = preferred(kind), device = chosen(kind);
    const labels = listed(kind).map((item) => item.label);
    const options = [["", "System default"]].concat(labels.map((label) => [label, label]));
    if (wanted && !labels.includes(wanted)) {
      const note = device ? " (" + device.label + ")" : labelsKnown(kind) ? " (not found)" : "";
      options.push([wanted, wanted + note]);
    }
    select.replaceChildren(...options.map((pair) => {
      const option = document.createElement("option");
      option.value = pair[0]; option.textContent = pair[1];
      return option;
    }));
    select.value = wanted;
  }
  $("device-warning").textContent = [warnings.input, warnings.output].filter(Boolean).join(" ");
}

// Every element or context that can play audio follows the chosen speaker.
async function applySpeaker() {
  const wanted = preferred("output"), device = checkDevice("output");
  for (const target of [audio, context]) {
    if (!target) continue;
    if (typeof target.setSinkId !== "function") {
      if (target === audio && device) warnings.output = "This browser cannot choose a speaker. Using the system default.";
      continue;
    }
    try { await target.setSinkId(device ? device.deviceId : ""); } catch (error) {
      warnings.output = 'Speaker "' + wanted + '" could not be used. Using the system default.';
      await Promise.resolve(target.setSinkId("")).catch(() => {});
    }
  }
}

async function openMicrophone() {
  const device = checkDevice("input");
  if (!device) { openedMic = ""; return navigator.mediaDevices.getUserMedia({ audio: MIC }); }
  try {
    const opened = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, MIC, { deviceId: { exact: device.deviceId } }) });
    openedMic = device.deviceId;
    return opened;
  } catch (error) {
    warnings.input = 'Microphone "' + preferred("input") + '" could not be opened. Using the system default.';
    openedMic = "";
    return navigator.mediaDevices.getUserMedia({ audio: MIC });
  }
}

function micNeedsSwitch() {
  const track = stream && stream.getAudioTracks()[0];
  if (!track) return false;
  const device = chosen("input");
  return track.readyState === "ended" || (device ? device.deviceId : "") !== openedMic;
}

// Mid-call, swap the microphone track in place so the WebRTC call keeps running.
async function switchMicrophone() {
  const connection = pc, previous = stream;
  const next = await openMicrophone();
  if (pc !== connection || stream !== previous) { next.getTracks().forEach((track) => track.stop()); return; }
  const muted = previous.getAudioTracks().every((track) => !track.enabled);
  const track = next.getAudioTracks()[0];
  track.enabled = !muted;
  const sender = connection.getSenders().find((item) => !item.track || item.track.kind === "audio");
  if (sender) await sender.replaceTrack(track);
  previous.getTracks().forEach((item) => item.stop());
  stream = next;
  if (remote) startMeter(remote);
}

function applyDevices() {
  applying = applying.then(async () => {
    try { devices = (await navigator.mediaDevices.enumerateDevices()) || []; } catch (error) { devices = []; }
    checkDevice("input");
    await applySpeaker();
    if (pc && micNeedsSwitch()) await switchMicrophone();
  }).catch(() => {}).then(renderDevices);
  return applying;
}

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
  remote = undefined; openedMic = "";
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
  await applyDevices();
  stream = await openMicrophone();
  renderDevices();
  const connection = new RTCPeerConnection();
  pc = connection;
  stream.getTracks().forEach((track) => connection.addTrack(track, stream));
  const channel = connection.createDataChannel("oai-events");
  channel.onopen = () => { live = true; send({ type: "open" }); status(callText()); };
  channel.onmessage = (event) => send({ type: "event", payload: String(event.data) });
  connection.ontrack = (event) => {
    remote = event.streams[0];
    audio.srcObject = remote;
    audio.play().catch(() => {});
    startMeter(remote);
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
  else if (message.type === "audio.defaults") {
    configured.input = typeof message.inputDevice === "string" ? message.inputDevice : "";
    configured.output = typeof message.outputDevice === "string" ? message.outputDevice : "";
    await applyDevices();
  }
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
    await applyDevices();
    unlockWaiters.splice(0).forEach((resolve) => resolve());
    status(ws && ws.readyState === WebSocket.OPEN ? idleText() : "Audio enabled. Waiting for pi…");
  } catch (error) {
    status("Microphone unavailable: " + ((error && error.message) || error));
  }
};
$("reconnect").onclick = () => { retry = 0; connect(); };
for (const kind of ["input", "output"]) {
  $(kind + "-device").onchange = () => {
    try { storage().setItem(STORE[kind], $(kind + "-device").value); } catch (error) {}
    applyDevices();
  };
}

if (!window.isSecureContext || !navigator.mediaDevices) {
  status("Open this page as http://localhost:PORT (forward the port over SSH); browsers block the microphone elsewhere.");
} else if (!token) {
  status("Missing page token. Open the full URL that pi printed.");
} else {
  $("enable").hidden = false;
  if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => { applyDevices(); });
  applyDevices();
  connect();
}
</script>
</body>
</html>
`;
