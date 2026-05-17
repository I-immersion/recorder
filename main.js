// LUMIIA Podcast Recorder v1.2
// Main process : naudiodon2 (PortAudio Float32) → modèle tracks (4 mono + 2 stéréo)
//                mapping canaux libre style Ableton, exports configurables
//
// Architecture audio :
//   PortAudio Float32 ──► main.js
//                           ├─► peaks par canal (lecture Float32 directe)
//                           │   └─► flat peaks par track active → renderer (audio:peaks)
//                           └─► extractTrack (Float→Int24 PCM)
//                               └─► WAV mono ou stéréo par track active
//                                   (writePos explicite, cf fix POSIX pwrite)
//
// Modèle config.tracks :
//   [ {id, kind:"mono", name, channel,  enabled},     // 4 voix mono
//     {id, kind:"stereo", name, channels:[L,R], enabled} ]  // 2 stéréos
//
// Modèle config.exports : { masterWav, masterMp3, stemsWav, stemsMp3 }

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const portAudio = require('naudiodon2');
const { Server: OSCServer, Client: OSCClient } = require('node-osc');
const ffmpegPath = require('ffmpeg-static');

const APP_VERSION = '1.2';

// ─── Configuration persistée ────────────────────────────────────────────────

const CONFIG_DIR = path.join(app.getPath('userData'));
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_OUTPUT = path.join(os.homedir(), 'Podcasts', 'LUMIIA');

const DEFAULT_TRACKS = [
  { id: 'm1', kind: 'mono',   name: 'Voix 1',   channel: 0,           enabled: true  },
  { id: 'm2', kind: 'mono',   name: 'Voix 2',   channel: 1,           enabled: true  },
  { id: 'm3', kind: 'mono',   name: 'Voix 3',   channel: 2,           enabled: false },
  { id: 'm4', kind: 'mono',   name: 'Voix 4',   channel: 3,           enabled: false },
  { id: 's1', kind: 'stereo', name: 'Ambiance', channels: [4, 5],     enabled: false },
  { id: 's2', kind: 'stereo', name: 'Musique',  channels: [6, 7],     enabled: false }
];

const DEFAULT_EXPORTS = {
  masterWav: false,  // master stéréo WAV
  masterMp3: true,   // master stéréo MP3 320k
  stemsWav:  true,   // pistes individuelles WAV (déjà enregistrées en live)
  stemsMp3:  false   // pistes individuelles MP3
};

function loadConfig() {
  const defaults = {
    outputDir: DEFAULT_OUTPUT,
    oscInPort: 7777,
    oscOutHost: '127.0.0.1',
    oscOutPort: 7000,
    oscQueryPort: 7778,
    deviceId: null,
    deviceLabel: null,
    sampleRate: 48000,
    tracks: JSON.parse(JSON.stringify(DEFAULT_TRACKS)),
    exports: { ...DEFAULT_EXPORTS },
    firstRun: true
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // Migration : si pas de tracks (ancienne config v1.1), injecter defaults
      if (!loaded.tracks || !Array.isArray(loaded.tracks) || loaded.tracks.length === 0) {
        loaded.tracks = JSON.parse(JSON.stringify(DEFAULT_TRACKS));
      }
      if (!loaded.exports) {
        loaded.exports = { ...DEFAULT_EXPORTS };
      }
      // Nettoie l'ancien champ pairs s'il traîne (legacy v1.1)
      delete loaded.pairs;
      return { ...defaults, ...loaded };
    }
  } catch (e) {
    console.error('Config corrompue, reset :', e.message);
  }
  return defaults;
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ─── État runtime ───────────────────────────────────────────────────────────

let mainWindow = null;
let oscServer = null;
let oscClient = null;
let oscQueryServer = null;
let audioStream = null;
let currentSession = null;

// ─── WAV : capture Float32, écriture PCM 24-bit ─────────────────────────────

const WAV_HEADER_SIZE = 44;
const SAMPLE_SIZE_FLOAT = 4; // bytes par sample Float32 (interne capture)
const SAMPLE_SIZE_INT24 = 3; // bytes par sample Int24 (sortie WAV)

function writeWavHeader(fd, channels, sampleRate, bitsPerSample, dataSize) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(WAV_HEADER_SIZE);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  fs.writeSync(fd, buf, 0, WAV_HEADER_SIZE, 0);
}

function patchWavSizes(fd, dataSize) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(36 + dataSize, 0);
  fs.writeSync(fd, buf, 0, 4, 4);
  buf.writeUInt32LE(dataSize, 0);
  fs.writeSync(fd, buf, 0, 4, 40);
}

// Extrait une track (mono ou stéréo) du buffer Float32 interleaved, retourne
// PCM Int24 little-endian (1 ou 2 canaux) prêt à écrire dans le WAV.
function extractTrack(buffer, totalChannels, track) {
  const ssIn = SAMPLE_SIZE_FLOAT;
  const frameSize = totalChannels * ssIn;
  const numFrames = Math.floor(buffer.length / frameSize);
  const channels = track.kind === 'mono' ? [track.channel] : track.channels;
  const outChans = channels.length;
  const out = Buffer.alloc(numFrames * outChans * SAMPLE_SIZE_INT24);
  let off = 0;
  for (let i = 0; i < numFrames; i++) {
    const base = i * frameSize;
    for (let k = 0; k < outChans; k++) {
      let v = buffer.readFloatLE(base + channels[k] * ssIn);
      if (v > 1) v = 1; else if (v < -1) v = -1;
      let iv = Math.round(v * 8388607);
      if (iv < 0) iv += 16777216;
      out[off++] = iv & 0xff;
      out[off++] = (iv >> 8) & 0xff;
      out[off++] = (iv >> 16) & 0xff;
    }
  }
  return out;
}

// Peaks par canal en lecture Float32 directe.
function computePeaksFloat(buffer, totalChannels) {
  const ss = SAMPLE_SIZE_FLOAT;
  const frameSize = totalChannels * ss;
  const numFrames = Math.floor(buffer.length / frameSize);
  const peaks = new Array(totalChannels).fill(0);
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < totalChannels; c++) {
      const v = buffer.readFloatLE(i * frameSize + c * ss);
      const a = v < 0 ? -v : v;
      if (a > peaks[c]) peaks[c] = a;
    }
  }
  return peaks;
}

// Map peaks par canal → flat peaks dans l'ordre des tracks actives.
// Mono : 1 valeur ; stéréo : 2 valeurs (L, R).
function peaksForActiveTracks(channelPeaks, activeTracks) {
  const out = [];
  for (const t of activeTracks) {
    if (t.kind === 'mono') {
      out.push(channelPeaks[t.channel] || 0);
    } else {
      out.push(channelPeaks[t.channels[0]] || 0);
      out.push(channelPeaks[t.channels[1]] || 0);
    }
  }
  return out;
}

// Tracks "actives" = enabled ET canaux valides pour le device courant.
function isTrackChannelValid(t, totalChannels) {
  if (t.kind === 'mono') return t.channel >= 0 && t.channel < totalChannels;
  if (t.kind === 'stereo') {
    return Array.isArray(t.channels) && t.channels.length === 2
      && t.channels.every(c => c >= 0 && c < totalChannels);
  }
  return false;
}

function getActiveTracks() {
  if (!audioStream) return [];
  return (config.tracks || [])
    .filter(t => t.enabled && isTrackChannelValid(t, audioStream.channels))
    .map(t => ({ ...t })); // copie défensive
}

// Nombre de canaux à demander à PortAudio = max channel index + 1 parmi tracks enabled.
function requiredChannelsForTracks(tracks) {
  let max = 0;
  for (const t of tracks) {
    if (!t.enabled) continue;
    if (t.kind === 'mono') {
      if (t.channel + 1 > max) max = t.channel + 1;
    } else if (t.channels) {
      for (const c of t.channels) {
        if (c + 1 > max) max = c + 1;
      }
    }
  }
  return Math.max(1, max);
}

function sanitizeName(s) {
  return (s || 'track').replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').slice(0, 40);
}

function sanitizeTitle(s) {
  return (s || 'session').replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').slice(0, 60);
}

function timestampStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

function formatHMS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ─── Audio capture (naudiodon2 / PortAudio Float32) ──────────────────────────

function listAudioDevices() {
  try {
    return portAudio.getDevices()
      .filter(d => d.maxInputChannels > 0)
      .map(d => ({
        id: d.id,
        name: d.name,
        maxChannels: d.maxInputChannels,
        defaultSampleRate: d.defaultSampleRate,
        hostAPIName: d.hostAPIName
      }));
  } catch (e) {
    console.error('Erreur listDevices :', e.message);
    return [];
  }
}

function closeAudioStream() {
  if (!audioStream) return;
  try {
    if (audioStream.ai) {
      audioStream.ai.removeAllListeners();
      try { audioStream.ai.quit(); } catch (_) {}
    }
  } catch (e) {
    console.error('Erreur fermeture stream :', e.message);
  }
  audioStream = null;
}

function openAudioStream(deviceId, channels, sampleRate) {
  closeAudioStream();
  try {
    const ai = new portAudio.AudioIO({
      inOptions: {
        channelCount: channels,
        sampleFormat: portAudio.SampleFormatFloat32,
        sampleRate: sampleRate,
        deviceId: deviceId,
        closeOnError: false,
        framesPerBuffer: 1024
      }
    });

    audioStream = {
      ai,
      deviceId,
      channels,
      sampleRate,
      lastPeaksSent: 0,
      maxPeaks: new Array(channels).fill(0),
      bufferLogged: false
    };

    ai.on('data', (buf) => {
      if (!audioStream || audioStream.ai !== ai) return;

      if (!audioStream.bufferLogged) {
        const expected = 1024 * audioStream.channels * SAMPLE_SIZE_FLOAT;
        console.log(`[audio] 1er buffer Float32 : ${buf.length} bytes (attendu ${expected}) — ${audioStream.channels} canaux @ ${audioStream.sampleRate}Hz`);
        audioStream.bufferLogged = true;
      }

      // 1. Peaks par canal (Float32)
      const peaksPerChannel = computePeaksFloat(buf, audioStream.channels);
      for (let c = 0; c < peaksPerChannel.length; c++) {
        if (peaksPerChannel[c] > audioStream.maxPeaks[c]) audioStream.maxPeaks[c] = peaksPerChannel[c];
      }
      const now = Date.now();
      if (now - audioStream.lastPeaksSent >= 40) {
        const activeTracks = getActiveTracks();
        const trackPeaks = peaksForActiveTracks(audioStream.maxPeaks, activeTracks);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio:peaks', trackPeaks);
        }
        for (let c = 0; c < audioStream.maxPeaks.length; c++) {
          audioStream.maxPeaks[c] *= 0.6;
        }
        audioStream.lastPeaksSent = now;
      }

      // 2. Si enregistrement actif : extraire et écrire chaque track active
      if (currentSession && !currentSession.isPaused) {
        for (const handle of currentSession.handles) {
          const pcmBuf = extractTrack(buf, audioStream.channels, handle.track);
          // FIX v1.1 : position explicite (POSIX pwrite)
          const written = fs.writeSync(handle.fd, pcmBuf, 0, pcmBuf.length, handle.writePos);
          handle.writePos += written;
          handle.dataSize += written;
        }
      }
    });

    ai.on('error', (err) => {
      console.error('AudioStream error :', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio:error', { message: String((err && err.message) || err) });
      }
    });

    ai.start();

    // Tracks actives à renvoyer au renderer (pour UI VU)
    const activeTracks = getActiveTracks();
    return { ok: true, channels, sampleRate, activeTracks };
  } catch (e) {
    console.error('Erreur openAudioStream :', e.message);
    closeAudioStream();
    return { ok: false, error: e.message };
  }
}

// ─── Recording lifecycle ────────────────────────────────────────────────────

function startSession(opts) {
  if (currentSession) {
    console.warn('Session déjà active, stop forcé');
    stopSession();
  }
  if (!audioStream) {
    return { ok: false, error: "Aucun stream audio ouvert." };
  }
  const activeTracks = getActiveTracks();
  if (activeTracks.length === 0) {
    return { ok: false, error: "Aucune piste active. Active au moins une piste dans Configuration." };
  }

  const now = new Date();
  const title = sanitizeTitle(opts.title);
  const folderName = `${timestampStr(now)}_${title}`;
  const folder = path.join(config.outputDir, folderName);
  fs.mkdirSync(folder, { recursive: true });

  const sr = audioStream.sampleRate;
  const handles = [];

  // Index = position dans config.tracks (1-indexé, stable même si filter actives)
  const trackIndexById = new Map();
  (config.tracks || []).forEach((t, i) => trackIndexById.set(t.id, i + 1));

  for (const track of activeTracks) {
    const idx = trackIndexById.get(track.id) || 0;
    const safeName = sanitizeName(track.name);
    const fileName = `track_${idx}_${safeName}.wav`;
    const filePath = path.join(folder, fileName);
    const numChans = track.kind === 'mono' ? 1 : 2;
    const fd = fs.openSync(filePath, 'w');
    writeWavHeader(fd, numChans, sr, 24, 0);
    handles.push({
      track,           // {id, kind, name, channel|channels, enabled}
      idx,
      fd,
      filePath,
      fileName,
      writePos: WAV_HEADER_SIZE,
      dataSize: 0,
      numChannels: numChans
    });
  }

  currentSession = {
    folder, folderName, title,
    startMs: Date.now(),
    pausedMs: 0,
    pauseStartMs: null,
    sampleRate: sr,
    handles,
    markers: [],
    isPaused: false,
    activeTracksSnapshot: activeTracks // utilisé pour generateExports
  };

  sendOSCState('recording');
  return { ok: true, folder, folderName, trackCount: handles.length };
}

function pauseSession() {
  if (!currentSession || currentSession.isPaused) return;
  currentSession.isPaused = true;
  currentSession.pauseStartMs = Date.now();
  sendOSCState('paused');
}

function resumeSession() {
  if (!currentSession || !currentSession.isPaused) return;
  currentSession.pausedMs += Date.now() - currentSession.pauseStartMs;
  currentSession.pauseStartMs = null;
  currentSession.isPaused = false;
  sendOSCState('recording');
}

function addMarker(note) {
  if (!currentSession) return null;
  const elapsedMs = Date.now() - currentSession.startMs - currentSession.pausedMs;
  const marker = {
    timeMs: elapsedMs,
    timeStr: formatHMS(elapsedMs / 1000),
    note: note || ''
  };
  currentSession.markers.push(marker);
  return marker;
}

async function stopSession() {
  if (!currentSession) return null;
  const session = currentSession;
  currentSession = null;

  // 1. Patch headers + close
  for (const handle of session.handles) {
    try { patchWavSizes(handle.fd, handle.dataSize); }
    catch (e) { console.error('Patch header:', e.message); }
    try { fs.closeSync(handle.fd); } catch (_) {}
  }

  // 2. markers.txt
  if (session.markers.length > 0) {
    const lines = session.markers.map(m => `${m.timeStr}\t${m.note}`).join('\n');
    fs.writeFileSync(path.join(session.folder, 'markers.txt'), lines + '\n');
  }

  // 3. session.json
  const meta = {
    title: session.title,
    folderName: session.folderName,
    startedAt: new Date(session.startMs).toISOString(),
    durationMs: Date.now() - session.startMs - session.pausedMs,
    sampleRate: session.sampleRate,
    deviceLabel: config.deviceLabel || null,
    tracks: session.handles.map(h => ({
      idx: h.idx,
      id: h.track.id,
      kind: h.track.kind,
      name: h.track.name,
      fileName: h.fileName,
      numChannels: h.numChannels,
      dataSize: h.dataSize
    })),
    markers: session.markers,
    appVersion: APP_VERSION,
    exportsConfig: config.exports
  };
  fs.writeFileSync(path.join(session.folder, 'session.json'), JSON.stringify(meta, null, 2));

  sendOSCState('idle');

  // 4. Exports en arrière-plan
  generateExports(session).catch(err => console.error('Erreur exports :', err));

  return session.folder;
}

// ─── Exports (master mixdown + stems MP3 selon config.exports) ───────────────

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`)));
    proc.on('error', reject);
  });
}

async function generateExports(session) {
  const exportCfg = config.exports || DEFAULT_EXPORTS;
  const wavFiles = session.handles.map(h => path.join(session.folder, h.fileName)).filter(p => fs.existsSync(p));
  if (wavFiles.length === 0) return;

  // 1. Master (mixdown amix de toutes les tracks)
  if (exportCfg.masterWav || exportCfg.masterMp3) {
    const masterWav = path.join(session.folder, 'master_stereo.wav');
    const inputs = [];
    wavFiles.forEach(f => { inputs.push('-i', f); });
    const filter = `${wavFiles.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${wavFiles.length}:duration=longest:normalize=0,alimiter=limit=0.95`;
    const args = ['-y', ...inputs, '-filter_complex', filter, '-ac', '2', '-c:a', 'pcm_s24le', masterWav];
    try {
      await runFfmpeg(args);
      if (exportCfg.masterMp3) {
        const masterMp3 = path.join(session.folder, 'master_stereo.mp3');
        await runFfmpeg(['-y', '-i', masterWav, '-codec:a', 'libmp3lame', '-b:a', '320k', masterMp3]);
      }
      if (!exportCfg.masterWav) {
        // Si MP3 demandé mais pas WAV : on supprime le WAV intermédiaire
        try { fs.unlinkSync(masterWav); } catch (_) {}
      }
    } catch (e) {
      console.error('Erreur master :', e.message);
    }
  }

  // 2. Stems MP3 (les WAV existent déjà — on génère juste les MP3 si demandés)
  if (exportCfg.stemsMp3) {
    for (const h of session.handles) {
      const inWav = path.join(session.folder, h.fileName);
      if (!fs.existsSync(inWav)) continue;
      const outMp3 = inWav.replace(/\.wav$/, '.mp3');
      try {
        await runFfmpeg(['-y', '-i', inWav, '-codec:a', 'libmp3lame', '-b:a', '320k', outMp3]);
      } catch (e) {
        console.error(`Erreur stem MP3 ${h.fileName} :`, e.message);
      }
    }
  }

  // 3. Si stemsWav désactivé, on supprime les WAV (rare mais demandable)
  if (!exportCfg.stemsWav) {
    for (const h of session.handles) {
      const wav = path.join(session.folder, h.fileName);
      try { if (fs.existsSync(wav)) fs.unlinkSync(wav); } catch (_) {}
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('master-ready', { folder: session.folder });
  }
}

// ─── Sessions list/delete/repair ────────────────────────────────────────────

function listSessions() {
  if (!fs.existsSync(config.outputDir)) return [];
  const entries = fs.readdirSync(config.outputDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const folder = path.join(config.outputDir, e.name);
      const metaPath = path.join(folder, 'session.json');
      let meta = null;
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
      }
      let trackCount = 0, totalBytes = 0, hasMp3 = false;
      try {
        const files = fs.readdirSync(folder);
        for (const f of files) {
          if (/^track_.*\.wav$/.test(f)) {
            trackCount++;
            try { totalBytes += fs.statSync(path.join(folder, f)).size; } catch (_) {}
          }
          if (f === 'master_stereo.mp3') hasMp3 = true;
        }
      } catch (_) {}
      return { folderName: e.name, folder, meta, trackCount, totalBytes, hasMp3 };
    })
    .filter(s => s.meta || s.trackCount > 0)
    .sort((a, b) => {
      const da = (a.meta && a.meta.startedAt) || a.folderName;
      const db = (b.meta && b.meta.startedAt) || b.folderName;
      return db.localeCompare(da);
    });
  return entries;
}

function deleteSession(folder) {
  const abs = path.resolve(folder);
  const outAbs = path.resolve(config.outputDir);
  if (!abs.startsWith(outAbs + path.sep) && abs !== outAbs) {
    return { ok: false, error: 'Dossier hors zone autorisée' };
  }
  if (abs === outAbs) return { ok: false, error: 'Refus suppression racine' };
  try { fs.rmSync(abs, { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function repairAllSessions() {
  const report = { scanned: 0, repaired: 0, alreadyOk: 0, failed: [] };
  const sessions = listSessions();
  for (const s of sessions) {
    const sr = (s.meta && s.meta.sampleRate) || 48000;
    try {
      const files = fs.readdirSync(s.folder).filter(f => /^track_.*\.wav$/.test(f));
      for (const f of files) {
        report.scanned++;
        const fp = path.join(s.folder, f);
        const fd = fs.openSync(fp, 'r+');
        try {
          const hb = Buffer.alloc(WAV_HEADER_SIZE);
          fs.readSync(fd, hb, 0, WAV_HEADER_SIZE, 0);
          const isRiff = hb.slice(0, 4).toString('ascii') === 'RIFF'
                      && hb.slice(8, 12).toString('ascii') === 'WAVE'
                      && hb.slice(36, 40).toString('ascii') === 'data';
          if (isRiff) { report.alreadyOk++; }
          else {
            const stat = fs.fstatSync(fd);
            const dataSize = Math.max(0, stat.size - WAV_HEADER_SIZE);
            // Détecter channels depuis la track meta si dispo, sinon défaut 2
            let chans = 2;
            if (s.meta && Array.isArray(s.meta.tracks)) {
              const trackMeta = s.meta.tracks.find(t => t.fileName === f);
              if (trackMeta) chans = trackMeta.numChannels || 2;
            }
            writeWavHeader(fd, chans, sr, 24, dataSize);
            report.repaired++;
          }
        } finally { try { fs.closeSync(fd); } catch (_) {} }
      }
    } catch (e) {
      report.failed.push({ folder: s.folderName, error: e.message });
    }
  }
  return report;
}

// ─── OSC IN/OUT + OSCQuery ──────────────────────────────────────────────────

function setupOSC() {
  if (oscServer) { try { oscServer.close(); } catch (_) {} oscServer = null; }
  if (oscClient) { try { oscClient.close(); } catch (_) {} oscClient = null; }

  try {
    oscServer = new OSCServer(config.oscInPort, '0.0.0.0', () => {
      console.log(`OSC IN écoute sur :${config.oscInPort}`);
    });
    oscServer.on('message', msg => {
      const [addr, ...args] = msg;
      handleOSCMessage(addr, args);
    });
    oscServer.on('error', err => console.error('OSC server error :', err.message));
  } catch (e) {
    console.error('Impossible de démarrer OSC server :', e.message);
  }

  try {
    oscClient = new OSCClient(config.oscOutHost, config.oscOutPort);
    console.log(`OSC OUT vers ${config.oscOutHost}:${config.oscOutPort}`);
  } catch (e) {
    console.error('Impossible de créer OSC client :', e.message);
  }
}

function handleOSCMessage(addr, args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('osc-in', { addr, args });
  }
  switch (addr) {
    case '/podcast/rec':    if (mainWindow) mainWindow.webContents.send('cmd-rec',    { title: args[0] || null }); break;
    case '/podcast/stop':   if (mainWindow) mainWindow.webContents.send('cmd-stop');   break;
    case '/podcast/pause':  if (mainWindow) mainWindow.webContents.send('cmd-pause');  break;
    case '/podcast/marker': if (mainWindow) mainWindow.webContents.send('cmd-marker', { note: args[0] || '' }); break;
    case '/podcast/new':    if (mainWindow) mainWindow.webContents.send('cmd-new',    { title: args[0] || null }); break;
  }
}

function sendOSC(addr, ...args) {
  if (!oscClient) return;
  try { oscClient.send(addr, ...args); } catch (_) {}
}

function sendOSCState(state) { sendOSC('/podcast/state', state); }

function buildOscQueryDescriptor() {
  return {
    DESCRIPTION: 'LUMIIA Podcast Recorder',
    FULL_PATH: '/', ACCESS: 0,
    CONTENTS: {
      podcast: {
        FULL_PATH: '/podcast', ACCESS: 0,
        CONTENTS: {
          rec:    { FULL_PATH: '/podcast/rec',    ACCESS: 2, TYPE: 's' },
          stop:   { FULL_PATH: '/podcast/stop',   ACCESS: 2, TYPE: ''  },
          pause:  { FULL_PATH: '/podcast/pause',  ACCESS: 2, TYPE: ''  },
          marker: { FULL_PATH: '/podcast/marker', ACCESS: 2, TYPE: 's' },
          new:    { FULL_PATH: '/podcast/new',    ACCESS: 2, TYPE: 's' },
          state:  { FULL_PATH: '/podcast/state',  ACCESS: 1, TYPE: 's' }
        }
      }
    }
  };
}

function setupOSCQuery() {
  if (oscQueryServer) { try { oscQueryServer.close(); } catch (_) {} oscQueryServer = null; }
  try {
    oscQueryServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      if (req.url && req.url.indexOf('HOST_INFO') >= 0) {
        res.end(JSON.stringify({
          NAME: 'LUMIIA Podcast Recorder',
          OSC_PORT: config.oscInPort,
          OSC_TRANSPORT: 'UDP',
          EXTENSIONS: { ACCESS: true, TYPE: true, DESCRIPTION: true }
        }));
        return;
      }
      res.end(JSON.stringify(buildOscQueryDescriptor()));
    });
    oscQueryServer.on('error', err => console.error('OSCQuery server error :', err.message));
    oscQueryServer.listen(config.oscQueryPort, () => {
      console.log(`OSCQuery HTTP sur :${config.oscQueryPort}`);
    });
  } catch (e) {
    console.error('Impossible de démarrer OSCQuery :', e.message);
  }
}

// ─── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('app:version', () => APP_VERSION);
ipcMain.handle('config:get', () => config);

ipcMain.handle('config:set', (_evt, patch) => {
  const oldOscIn = config.oscInPort;
  const oldOscOutHost = config.oscOutHost;
  const oldOscOutPort = config.oscOutPort;
  const oldOscQuery = config.oscQueryPort;
  config = { ...config, ...patch };
  saveConfig(config);
  if (config.oscInPort !== oldOscIn || config.oscOutHost !== oldOscOutHost || config.oscOutPort !== oldOscOutPort) {
    setupOSC();
  }
  if (config.oscQueryPort !== oldOscQuery) {
    setupOSCQuery();
  }
  return config;
});

ipcMain.handle('config:choose-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: config.outputDir
  });
  if (result.canceled || !result.filePaths[0]) return null;
  config.outputDir = result.filePaths[0];
  saveConfig(config);
  return config.outputDir;
});

ipcMain.handle('audio:list-devices', () => listAudioDevices());

ipcMain.handle('audio:open', (_evt, { deviceId, channels, sampleRate }) => {
  const id = (deviceId === null || deviceId === undefined) ? -1 : parseInt(deviceId, 10);
  // Si channels non spécifié, on calcule depuis les tracks enabled
  const reqChans = channels && channels > 0 ? channels : requiredChannelsForTracks(config.tracks || []);
  return openAudioStream(id, reqChans, sampleRate || 48000);
});

ipcMain.handle('audio:close', () => { closeAudioStream(); return { ok: true }; });

ipcMain.handle('audio:state', () => {
  if (!audioStream) return { isOpen: false };
  return {
    isOpen: true,
    deviceId: audioStream.deviceId,
    channels: audioStream.channels,
    sampleRate: audioStream.sampleRate,
    activeTracks: getActiveTracks()
  };
});

ipcMain.handle('rec:start',  (_evt, opts) => startSession(opts || {}));
ipcMain.handle('rec:pause',  () => { pauseSession();  return { ok: true }; });
ipcMain.handle('rec:resume', () => { resumeSession(); return { ok: true }; });
ipcMain.handle('rec:stop',   async () => await stopSession());

ipcMain.handle('rec:marker', (_evt, { note }) => {
  const m = addMarker(note);
  if (m) sendOSC('/podcast/marker', m.timeStr, m.note || '');
  return m;
});

ipcMain.handle('sessions:list',        () => listSessions());
ipcMain.handle('sessions:reveal',      (_evt, folder) => { shell.showItemInFolder(folder); });
ipcMain.handle('sessions:open-folder', (_evt, folder) => { shell.openPath(folder); });
ipcMain.handle('sessions:delete',      (_evt, folder) => deleteSession(folder));
ipcMain.handle('sessions:repair-all',  () => repairAllSessions());

// ─── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820,
    minWidth: 1024, minHeight: 720,
    backgroundColor: '#0a0a1e',
    title: 'LUMIIA Podcast Recorder',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  setupOSC();
  setupOSCQuery();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (currentSession) await stopSession();
  closeAudioStream();
  if (oscServer) { try { oscServer.close(); } catch (_) {} }
  if (oscClient) { try { oscClient.close(); } catch (_) {} }
  if (oscQueryServer) { try { oscQueryServer.close(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (currentSession) await stopSession();
  closeAudioStream();
});
