"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { exportJianyingDraft, detectJianyingDraftRoot, validateJianyingDraft, PLACEHOLDER } = require("../app/jianying-draft-export");
const root = path.resolve(__dirname, "..", ".codex_tests", "TASK-20260905-DRAMA-JIANYING-DRAFT-001", "native-writer");

async function fixture() {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "case-"));
  const video = path.join(dir, "source.mp4"), audio = path.join(dir, "click.wav");
  // Media-copy fixture; real decode proof is separately exercised by the
  // application FFmpeg tests. No HTTP, paid generation, or GUI is used here.
  await fs.writeFile(video, Buffer.from("native-draft-video-copy-fixture"));
  const wav = Buffer.alloc(44 + 4800 * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  await fs.writeFile(audio, wav);
  return { dir, options: { project: { id: "p1", title: "可编辑粗剪" }, videoClips: [{ shotId: "S01", filePath: video, startSeconds: 0, durationSeconds: 2, sourceStartSeconds: 0.2, width: 1080, height: 1920 }, { shotId: "S02", filePath: video, startSeconds: 2, durationSeconds: 3, sourceStartSeconds: 0, width: 1080, height: 1920 }], subtitles: [{ text: "你终于来了。", startUs: 500000, durationUs: 1000000, speaker: "A" }, { text: "我回来见你。", startUs: 2500000, durationUs: 1500000, speaker: "B" }], catalog: [{ id: "SFX-1", filePath: audio, displayName: "环境风声" }], sfxPlan: { shots: [{ shotId: "S01", cues: [{ effectId: "SFX-1", role: "ambience", programmeTimeSeconds: 0.4, durationSeconds: 0.35, loop: true, gainDb: -20 }] }] }, outputRoot: path.join(dir, "project-exports"), draftRoot: path.join(dir, "native-drafts") } };
}

test("native export has independently editable video, audio and subtitle tracks, stable IDs and bounded loops", async () => {
  const { options } = await fixture();
  await fs.mkdir(options.draftRoot);
  const ownedIndex = path.join(options.draftRoot, "root_meta_info.json");
  await fs.writeFile(ownedIndex, "jianying-owned-index");
  const result = await exportJianyingDraft(options);
  assert.equal(result.registered, true); assert.equal(result.reused, false);
  assert.equal(await fs.readFile(ownedIndex, "utf8"), "jianying-owned-index");
  assert.deepEqual(result.counts, { videos: 2, subtitles: 2, sfxCues: 1, audioTracks: 1 });
  const { content, meta } = await validateJianyingDraft(result.draftPath);
  assert.equal(content.id, meta.draft_id); assert.equal(content.duration, 5000000);
  assert.equal(meta.draft_fold_path, ""); assert.equal(meta.tm_duration, 0);
  assert.deepEqual(content.tracks.map(lane => lane.type), ["video", "audio", "text"]);
  assert.equal(content.tracks[0].segments[0].source_timerange.start, 200000);
  assert.equal(content.tracks[1].segments.length, 4);
  assert.equal(content.tracks[1].segments.reduce((n,s) => n + s.target_timerange.duration, 0), 350000);
  assert.equal(content.materials.audio_fades.length, 4);
  assert.ok(content.materials.audio_fades.every(fade => fade.fade_type === 0 && fade.fade_in_duration >= 0 && fade.fade_out_duration >= 0));
  assert.ok(content.tracks[1].segments.every(s => s.source_timerange.duration <= 100000));
  assert.equal(JSON.parse(content.materials.texts[0].content).text, "你终于来了。");
  assert.ok(content.materials.videos[0].path.startsWith(PLACEHOLDER));
  const names = await fs.readdir(result.installedDraftPath);
  assert.ok(!names.includes("Timelines")); assert.ok(!names.includes("draft_info.json"));
  const second = await exportJianyingDraft(options);
  assert.equal(second.reused, true); assert.equal(second.draftId, result.draftId); assert.equal(second.installedDraftPath, result.installedDraftPath);
});

test("changed trim and subtitles get a new fingerprint without overwriting existing draft", async () => {
  const { options } = await fixture();
  const a = await exportJianyingDraft(options);
  const b = await exportJianyingDraft({ ...options, subtitles: [{ ...options.subtitles[0], text: "台词更新。" }] });
  assert.notEqual(a.fingerprint, b.fingerprint); assert.notEqual(a.draftPath, b.draftPath);
  await validateJianyingDraft(a.draftPath);
  const c = await exportJianyingDraft({ ...options, videoClips: options.videoClips.map((clip,i) => i ? clip : { ...clip, sourceStartSeconds: 0.3 }) });
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("same media bytes retain draft identity across timestamp changes but content changes do not", async () => {
  const { options } = await fixture();
  const first = await exportJianyingDraft(options);
  const audio = options.catalog[0].filePath;
  const timestamp = new Date(Date.now() + 60000);
  await fs.utimes(audio, timestamp, timestamp);
  const touched = await exportJianyingDraft(options);
  assert.equal(touched.reused, true);
  assert.equal(touched.fingerprint, first.fingerprint);
  assert.equal(touched.installedDraftPath, first.installedDraftPath);
  const original = await fs.stat(audio);
  const bytes = await fs.readFile(audio);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(audio, bytes);
  await fs.utimes(audio, original.atime, original.mtime);
  const replaced = await exportJianyingDraft(options);
  assert.notEqual(replaced.fingerprint, first.fingerprint);
  assert.equal(replaced.reused, false);
  await validateJianyingDraft(first.draftPath, first.fingerprint);
});

test("native folder adoption may remap metadata ID without causing duplicate export", async () => {
  const { options } = await fixture();
  const first = await exportJianyingDraft(options);
  const metaFile = path.join(first.installedDraftPath, "draft_meta_info.json");
  const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
  meta.draft_id = "DF42EDEE-BB55-4571-A2FB-F50ADF51F5D5";
  meta.draft_fold_path = first.installedDraftPath;
  meta.draft_root_path = path.dirname(first.installedDraftPath);
  meta.draft_name = path.basename(first.installedDraftPath);
  meta.tm_draft_create = Date.now() * 1000;
  await fs.writeFile(metaFile, JSON.stringify(meta));
  const accepted = await validateJianyingDraft(first.installedDraftPath, first.fingerprint);
  assert.equal(accepted.nativeIdentityRemapped, true);
  const second = await exportJianyingDraft(options);
  assert.equal(second.installedDraftPath, first.installedDraftPath);
  assert.deepEqual(JSON.parse(await fs.readFile(metaFile, "utf8")), meta);
  assert.equal((await fs.readdir(options.draftRoot)).filter(x => x.startsWith("puream_drama_")).length, 1);
  await fs.writeFile(metaFile, JSON.stringify({ ...meta, draft_fold_path: path.join(options.draftRoot, "unrelated") }));
  await assert.rejects(validateJianyingDraft(first.installedDraftPath), /身份编号/);
  await fs.writeFile(metaFile, JSON.stringify({ ...meta, draft_root_path: "" }));
  await assert.rejects(validateJianyingDraft(first.installedDraftPath), /身份编号/);
});

test("missing sound and unavailable native directory preserve usable project draft with warning", async () => {
  const { dir, options } = await fixture();
  const blockingFile = path.join(dir, "not-directory"); await fs.writeFile(blockingFile, "keep");
  const result = await exportJianyingDraft({ ...options, catalog: [], draftRoot: blockingFile });
  assert.equal(result.registered, false); assert.equal(result.counts.audioTracks, 0);
  assert.ok(result.warnings.some(w => w.includes("音效"))); assert.ok(result.warnings.some(w => w.includes("自动放入剪映失败")));
  await validateJianyingDraft(result.draftPath);
  assert.equal(await fs.readFile(blockingFile, "utf8"), "keep");
});

test("rejects missing videos, out-of-range captions, and overlapping clips before publication", async () => {
  const { options } = await fixture();
  await assert.rejects(exportJianyingDraft({ ...options, videoClips: [{ ...options.videoClips[0], filePath: "does-not-exist.mp4" }] }), /媒体文件/);
  await assert.rejects(exportJianyingDraft({ ...options, subtitles: [{ text: "越界", startUs: 4900000, durationUs: 1000000 }] }), /字幕超出/);
  await assert.rejects(exportJianyingDraft({ ...options, videoClips: options.videoClips.map((clip,i) => i ? { ...clip, startSeconds: 1 } : clip) }), /重叠/);
});

test("root discovery prioritizes explicit settings and active native tracking, never writes indexes", async () => {
  const { dir } = await fixture();
  const local = path.join(dir, "local"), active = path.join(dir, "active"), lost = path.join(dir, "lost");
  await fs.mkdir(active); await fs.mkdir(lost);
  const tracking = path.join(local, "JianyingPro", "User Data", "Config", "Modules", "draft_tracking.ini");
  await fs.mkdir(path.dirname(tracking), { recursive: true });
  const row = data => `@ByteArray(${Buffer.from(JSON.stringify(data)).toString("base64")})`;
  const original = row({ draft_path: lost, path_lost_time: 5 }) + "\n" + row({ draft_path: active, path_lost_time: 0, draft_path_exist: true });
  await fs.writeFile(tracking, original);
  assert.equal(await detectJianyingDraftRoot({ env: { LOCALAPPDATA: local } }), active);
  assert.equal(await detectJianyingDraftRoot({ settings: { jianyingDraftDirectory: lost }, env: { LOCALAPPDATA: local } }), lost);
  assert.equal(await fs.readFile(tracking, "utf8"), original);
});

test("parallel duplicate clicks share one export and copied resources remain standalone", async () => {
  const { options } = await fixture();
  const [a,b] = await Promise.all([exportJianyingDraft(options), exportJianyingDraft(options)]);
  assert.equal(a.draftPath, b.draftPath);
  const { content } = await validateJianyingDraft(a.draftPath);
  const relative = content.materials.videos[0].path.split("\\").slice(1).join(path.sep);
  const copied = path.join(a.draftPath, relative);
  assert.deepEqual(await fs.readFile(copied), await fs.readFile(options.videoClips[0].filePath));
});

test("cancellation never publishes a partial draft and later retry succeeds", async () => {
  const { options } = await fixture();
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(exportJianyingDraft({ ...options, signal: stopped.signal }), error => error.code === "LOCAL_MEDIA_CANCELLED");
  const controller = new AbortController();
  await assert.rejects(exportJianyingDraft({ ...options, signal: controller.signal, onProgress: ({ percent }) => { if (percent >= 10) controller.abort(); } }), error => error.code === "LOCAL_MEDIA_CANCELLED");
  const names = await fs.readdir(options.outputRoot).catch(() => []);
  assert.equal(names.filter(name => name.startsWith("puream_drama_")).length, 0);
  assert.equal((await exportJianyingDraft(options)).registered, true);
});

test("colliding output file and malformed paths fail without mutating existing files", async () => {
  const { dir, options } = await fixture();
  const collision = path.join(dir, "output-file"); await fs.writeFile(collision, "protected");
  await assert.rejects(exportJianyingDraft({ ...options, outputRoot: collision }));
  assert.equal(await fs.readFile(collision, "utf8"), "protected");
  await assert.rejects(exportJianyingDraft({ ...options, videoClips: [{ ...options.videoClips[0], filePath: "../relative.mp4" }] }), /绝对路径/);
  const a = await exportJianyingDraft(options);
  await fs.writeFile(path.join(a.installedDraftPath, "user-edit.txt"), "keep my edit");
  const b = await exportJianyingDraft(options);
  assert.equal(await fs.readFile(path.join(b.installedDraftPath, "user-edit.txt"), "utf8"), "keep my edit");
});

test("simultaneous different subtitle requests export separate versions", async () => {
  const { options } = await fixture();
  const [a,b] = await Promise.all([exportJianyingDraft(options), exportJianyingDraft({ ...options, subtitles: [{ ...options.subtitles[0], text: "第二版" }] })]);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.notEqual(a.draftId, b.draftId);
});

test("real generated MP4 and bundled Ogg remain independently decodable after native draft export", async t => {
  const ffmpeg = path.resolve(__dirname, "..", "media-tools", "ffmpeg.exe");
  if (!(await fs.stat(ffmpeg).catch(() => null))) { t.skip("Bundled FFmpeg unavailable"); return; }
  const { dir, options } = await fixture();
  const video = path.join(dir, "real.mp4");
  const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=64x96:r=24:d=0.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(generated.status, 0, generated.stderr);
  const audio = path.resolve(__dirname, "..", "app", "assets", "builtin-sfx", "audio", "SFX-001.ogg");
  const result = await exportJianyingDraft({ ...options, videoClips: [{ shotId: "S01", filePath: video, startSeconds: 0, durationSeconds: 0.4, sourceStartSeconds: 0.1, sourceDurationSeconds: 0.5, width: 64, height: 96 }], subtitles: [{ text: "测试", startUs: 0, durationUs: 300000 }], catalog: [{ id: "SFX-1", filePath: audio }], sfxPlan: { cues: [{ effectId: "SFX-1", programmeTimeSeconds: 0.1, durationSeconds: 0.2 }] } });
  const { manifest } = await validateJianyingDraft(result.draftPath);
  for (const resource of manifest.resources) {
    const copied = path.join(result.draftPath, "resources", resource.name);
    const decoded = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-i", copied, "-f", "null", "-"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(decoded.status, 0, decoded.stderr);
  }
  assert.equal(result.counts.audioTracks, 1);
});

test("standalone draft preserves SRT timing provenance and detects same-size media corruption", async () => {
  const { options } = await fixture();
  const result = await exportJianyingDraft({ ...options, subtitleTimingSource: "estimated", subtitleWarnings: ["字幕时间为估算，需播放确认"] });
  const { manifest } = await validateJianyingDraft(result.draftPath);
  assert.equal(manifest.subtitleTimingSource, "estimated");
  assert.ok(manifest.resources.every(resource => /^[a-f0-9]{64}$/.test(resource.sha256)));
  assert.match(await fs.readFile(path.join(result.draftPath, "subtitles.srt"), "utf8"), /00:00:00,500 --> 00:00:01,500/);
  assert.match(await fs.readFile(path.join(result.draftPath, "字幕与音轨说明.txt"), "utf8"), /估算/);
  const target = path.join(result.draftPath, "resources", manifest.resources[0].name);
  const data = await fs.readFile(target); data[0] ^= 0xff; await fs.writeFile(target, data);
  await assert.rejects(validateJianyingDraft(result.draftPath), /校验值/);
});

test("fallback audio probe receives cancellation and never downgrades cancellation to a skipped SFX", async () => {
  const { options, dir } = await fixture();
  const opaqueAudio = path.join(dir, "opaque-audio.mp3");
  await fs.writeFile(opaqueAudio, "probe-fixture-unknown-codec");
  const writerPath = path.resolve(__dirname, "..", "app", "jianying-draft-export.js");
  const actualRequire = require("node:module").createRequire(writerPath);
  const controller = new AbortController();
  let probeCalls = 0;
  const module = { exports: {} };
  require("node:vm").runInNewContext(await fs.readFile(writerPath, "utf8"), {
    require: id => id === "./local-media-context" ? {
      runLocalMediaProcess: async (_executable, args, config) => {
        probeCalls++;
        assert.equal(args.at(-1), opaqueAudio);
        assert.equal(config.timeoutMs, 15000);
        assert.equal(config.signal, controller.signal);
        controller.abort();
        throw Object.assign(new Error("test cancellation"), { code: "LOCAL_MEDIA_CANCELLED" });
      }
    } : actualRequire(id),
    module, exports: module.exports, __dirname: path.dirname(writerPath), process, Buffer, setTimeout, clearTimeout
  }, { filename: writerPath });
  await assert.rejects(module.exports.exportJianyingDraft({ ...options, signal: controller.signal, catalog: [{ id: "SFX-1", filePath: opaqueAudio }] }), error => error.code === "LOCAL_MEDIA_CANCELLED");
  assert.equal(probeCalls, 1);
  assert.deepEqual(await fs.readdir(options.outputRoot).catch(() => []), []);
});
