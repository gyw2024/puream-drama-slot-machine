"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const VOICE_PROFILE_AUDIT_VERSION = 1;

function wavChunk(buffer, name) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === name) return { start, size: Math.min(size, buffer.length - start) };
    offset = start + size + (size % 2);
  }
  return null;
}

function readWavMono(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw Object.assign(new Error("音色画像目前只校验 WAV 音频"), { code: "VOICE_AUDIT_WAV_REQUIRED" });
  }
  const fmt = wavChunk(buffer, "fmt ");
  const data = wavChunk(buffer, "data");
  if (!fmt || !data || fmt.size < 16) throw Object.assign(new Error("WAV 音频结构不完整"), { code: "VOICE_AUDIT_WAV_INVALID" });
  const format = buffer.readUInt16LE(fmt.start);
  const channels = buffer.readUInt16LE(fmt.start + 2);
  const sampleRate = buffer.readUInt32LE(fmt.start + 4);
  const bits = buffer.readUInt16LE(fmt.start + 14);
  if (![1, 3].includes(format) || ![16, 24, 32].includes(bits) || channels < 1 || channels > 8 || sampleRate < 8000) {
    throw Object.assign(new Error("WAV 编码不支持音色画像"), { code: "VOICE_AUDIT_WAV_UNSUPPORTED" });
  }
  const bytes = bits / 8;
  const frameBytes = bytes * channels;
  const frames = Math.floor(data.size / frameBytes);
  const samples = new Float64Array(frames);
  const read = offset => {
    if (format === 3 && bits === 32) return buffer.readFloatLE(offset);
    if (bits === 16) return buffer.readInt16LE(offset) / 32768;
    if (bits === 24) return buffer.readIntLE(offset, 3) / 8388608;
    return buffer.readInt32LE(offset) / 2147483648;
  };
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const base = data.start + frame * frameBytes;
    for (let channel = 0; channel < channels; channel += 1) sum += read(base + channel * bytes);
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate, channels, bits, format, buffer };
}

function median(values = []) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pitchFrames(samples, sampleRate) {
  const targetRate = 8000;
  const stride = Math.max(1, Math.round(sampleRate / targetRate));
  const down = new Float64Array(Math.floor(samples.length / stride));
  for (let i = 0; i < down.length; i += 1) down[i] = samples[i * stride];
  const actualRate = sampleRate / stride;
  const frameLength = Math.round(actualRate * 0.04);
  const hop = Math.round(actualRate * 0.02);
  const minLag = Math.max(2, Math.floor(actualRate / 400));
  const maxLag = Math.min(frameLength - 3, Math.ceil(actualRate / 55));
  const pitches = [];
  let inspected = 0;
  for (let start = 0; start + frameLength <= down.length; start += hop) {
    inspected += 1;
    let mean = 0;
    for (let i = 0; i < frameLength; i += 1) mean += down[start + i];
    mean /= frameLength;
    let energy = 0;
    for (let i = 0; i < frameLength; i += 1) {
      const value = down[start + i] - mean;
      energy += value * value;
    }
    const rms = Math.sqrt(energy / frameLength);
    if (rms < 0.012) continue;
    let bestLag = 0;
    let bestCorrelation = 0;
    const correlations = [];
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let cross = 0;
      let left = 0;
      let right = 0;
      for (let i = 0; i < frameLength - lag; i += 1) {
        const a = down[start + i] - mean;
        const b = down[start + i + lag] - mean;
        cross += a * b;
        left += a * a;
        right += b * b;
      }
      const correlation = left > 0 && right > 0 ? cross / Math.sqrt(left * right) : 0;
      correlations.push([lag, correlation]);
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }
    if (bestCorrelation < 0.48 || !bestLag) continue;
    const preferred = correlations.find(([lag, value], index) => index > 0
      && index < correlations.length - 1
      && value >= bestCorrelation * 0.9
      && value >= correlations[index - 1][1]
      && value >= correlations[index + 1][1]);
    pitches.push(actualRate / (preferred?.[0] || bestLag));
  }
  return { pitches: pitches.filter(value => value >= 55 && value <= 400), inspected };
}

function perceivedGender(medianF0Hz) {
  const f0 = Number(medianF0Hz) || 0;
  if (!f0) return { gender: "", confidence: 0 };
  if (f0 <= 150) return { gender: "male", confidence: Math.min(0.99, 0.82 + (150 - f0) / 240) };
  if (f0 <= 165) return { gender: "male", confidence: 0.7 };
  if (f0 >= 200) return { gender: "female", confidence: Math.min(0.99, 0.82 + (f0 - 200) / 500) };
  if (f0 >= 185) return { gender: "female", confidence: 0.7 };
  return { gender: "", confidence: 0.35 };
}

function auditVoiceFile(filePath, declaredGender = "") {
  const { samples, sampleRate, channels, bits, buffer } = readWavMono(filePath);
  const { pitches, inspected } = pitchFrames(samples, sampleRate);
  const medianF0Hz = median(pitches);
  const profile = perceivedGender(medianF0Hz);
  const normalizedDeclared = String(declaredGender || "").trim().toLowerCase();
  const mismatch = Boolean(normalizedDeclared && profile.gender && normalizedDeclared !== profile.gender && profile.confidence >= 0.7);
  return {
    version: VOICE_PROFILE_AUDIT_VERSION,
    ok: samples.length > sampleRate * 0.6 && pitches.length >= 3,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    duration: Number((samples.length / sampleRate).toFixed(3)),
    audioSpec: { container: "wav", codec: bits === 16 ? "pcm_s16le" : bits === 24 ? "pcm_s24le" : "pcm", channels, sampleRate },
    medianF0Hz: Number(medianF0Hz.toFixed(1)),
    voicedFrameRatio: Number((pitches.length / Math.max(1, inspected)).toFixed(3)),
    acousticGender: profile.gender,
    confidence: Number(profile.confidence.toFixed(2)),
    declaredGender: normalizedDeclared,
    mismatch,
    verified: !mismatch && Boolean(profile.gender) && profile.confidence >= 0.7,
    auditedAt: new Date().toISOString()
  };
}

module.exports = {
  VOICE_PROFILE_AUDIT_VERSION,
  auditVoiceFile,
  perceivedGender,
  readWavMono
};
