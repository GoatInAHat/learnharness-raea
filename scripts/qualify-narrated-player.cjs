const assert = require("node:assert/strict");
const { mkdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const [media, root] = process.argv.slice(-2);
const profile = path.join(root, "electron");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL("data:text/html,<meta charset=utf-8><video controls></video>");
  const payload = JSON.stringify(readFileSync(media).toString("base64"));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const bytes = Uint8Array.from(atob(${payload}), x => x.charCodeAt(0));
    const audio = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes.buffer.slice(0));
    const samples = audio.getChannelData(0);
    let decodedPeak = 0, activeSamples = 0, clippingSamples = 0;
    for (const sample of samples) {
      const a = Math.abs(sample);
      decodedPeak = Math.max(decodedPeak, a);
      if (a > 0.01) activeSamples++;
      if (a >= 1) clippingSamples++;
    }
    const video = document.querySelector('video');
    const url = URL.createObjectURL(new Blob([bytes], {type:'video/mp4'}));
    const event = name => new Promise((resolve,reject) => {
      video.addEventListener(name, resolve, {once:true});
      video.addEventListener('error', () => reject(Error('Media error '+video.error?.code)), {once:true});
      setTimeout(() => reject(Error('Timed out waiting for '+name)), 5000);
    });
    try {
      const loaded = event('loadedmetadata');
      video.src = url;
      await loaded;
      video.muted = true;
      await video.play();
      await new Promise(resolve => setTimeout(resolve, 650));
      const advanced = video.currentTime;
      video.pause();
      const seeked = event('seeked');
      video.currentTime = 9;
      await seeked;
      return {decodedSeconds:audio.duration, decodedChannels:audio.numberOfChannels, decodedPeak, activeSamples, clippingSamples, advanced, seek:video.currentTime, width:video.videoWidth, height:video.videoHeight};
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  })()`);
  assert(result.advanced > 0.2, "The Electron player did not advance");
  assert(result.activeSamples > 4800 && result.clippingSamples === 0, "Decoded audio is silent or clipped");
  assert.equal(result.width, 960);
  assert.equal(result.height, 540);
  console.log(JSON.stringify({ ...result, electron: process.versions.electron }));
  app.exit(0);
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
