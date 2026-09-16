"use strict";

// Native field shapes follow PUREAM desktop jianyingWriter.js minimal-import
// contract and its shipped draft_content template. No Jianying-owned index,
// watcher log, Timelines or attachment scaffold is generated or modified.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { runLocalMediaProcess } = require("./local-media-context");
const PLACEHOLDER = "##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##";
const CONTRACT_VERSION = 3;
const running = new Map();
const uid = () => crypto.randomUUID().toUpperCase();
const us = n => Math.round(Number(n) * 1e6);
const portable = name => `${PLACEHOLDER}\\resources\\${name}`;
const safeName = value => String(value || "短剧").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 48).replace(/[. ]+$/, "") || "短剧";
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const json = file => fsp.readFile(file, "utf8").then(JSON.parse);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const readableDir = async candidate => !!candidate && !!(await fsp.stat(candidate).catch(() => null))?.isDirectory();
async function fileHash(file, signal) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) { checkCancelled(signal); hash.update(chunk); }
  return hash.digest("hex");
}
function checkCancelled(signal) {
  if (signal?.aborted) { const error = new Error("剪映草稿导出已取消，原视频和已完成草稿已保留"); error.code = "LOCAL_MEDIA_CANCELLED"; throw error; }
}

async function detectJianyingDraftRoot({ settings = {}, env = process.env } = {}) {
  const explicit = settings.jianyingDraftDirectory || settings.jianyingDraftRoot || settings.draftDirectory || env.JIANYING_DRAFT_ROOT;
  if (explicit) return path.resolve(String(explicit));
  const local = env.LOCALAPPDATA || "";
  if (!local) return "";
  const userRoot = path.join(local, "JianyingPro", "User Data");
  const fallback = path.join(userRoot, "Projects", "com.lveditor.draft");
  const candidates = [];
  const add = async (candidate, score) => {
    if (!candidate || !(await readableDir(candidate))) return;
    const resolved = path.resolve(candidate);
    const existing = candidates.find(row => row.path.toLowerCase() === resolved.toLowerCase());
    if (existing) existing.score = Math.max(existing.score, score);
    else candidates.push({ path: resolved, score });
  };
  const tracking = await fsp.readFile(path.join(userRoot, "Config", "Modules", "draft_tracking.ini"), "utf8").catch(() => "");
  // Newer Qt builds wrap current root JSON in @Variant rather than @ByteArray.
  const decodedQt = tracking.replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (const match of decodedQt.matchAll(/[A-Za-z0-9+/]{48,}={0,2}/g)) {
    try {
      const row = JSON.parse(Buffer.from(match[0], "base64").toString("utf8"));
      if (row.draft_path_exist !== false && finite(row.path_lost_time) === 0) await add(row.draft_path, 100 + finite(row.path_create_time));
    } catch { /* Other Qt payloads are not draft root descriptors. */ }
  }
  for (const root of [fallback]) {
    const meta = await json(path.join(root, "root_meta_info.json")).catch(() => ({}));
    await add(meta.root_path, 10);
    for (const draft of meta.all_draft_store || []) await add(draft.draft_root_path || (draft.draft_fold_path && path.dirname(draft.draft_fold_path)), 9);
  }
  // Respect the companion desktop application's explicitly configured root.
  const configCandidates = env.APPDATA ? [path.join(env.APPDATA, "@puream", "desktop", "config.json"), path.join(env.APPDATA, "PUREAM", "config.json")] : [];
  for (const file of configCandidates) {
    const config = await json(file).catch(() => ({}));
    await add(config.draftDirectory || config.settings?.draftDirectory, 50);
  }
  await add(fallback, 1);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.path || "";
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  let firstError = null;
  const output = new Array(items.length);
  // Settle in-flight copies before staging cleanup; Promise.all's early reject
  // would otherwise race another worker still writing into the same folder.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!firstError && next < items.length) {
      const index = next++;
      try { output[index] = await fn(items[index], index); }
      catch (error) { firstError ||= error; }
    }
  }));
  if (firstError) throw firstError;
  return output;
}

function oggDuration(buffer) {
  let rate = 0, maximum = 0n;
  const signature = buffer.indexOf(Buffer.from([1, ...Buffer.from("vorbis")]));
  if (signature >= 0 && signature + 16 <= buffer.length) rate = buffer.readUInt32LE(signature + 12);
  if (buffer.includes(Buffer.from("OpusHead"))) rate = 48000;
  let offset = 0;
  while (offset + 27 <= buffer.length) {
    if (buffer.toString("ascii", offset, offset + 4) !== "OggS") break;
    const granule = buffer.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule > maximum) maximum = granule;
    const segments = buffer[offset + 26];
    if (offset + 27 + segments > buffer.length) break;
    let length = 27 + segments;
    for (let i = 0; i < segments; i++) length += buffer[offset + 27 + i];
    offset += length;
  }
  return rate > 0 ? Number(maximum) / rate : 0;
}

async function audioDuration(effect, signal) {
  checkCancelled(signal);
  if (finite(effect.durationSeconds) > 0) return Number(effect.durationSeconds);
  const stat = await fsp.stat(effect.filePath);
  if (stat.size <= 64 * 1024 * 1024) {
    const data = await fsp.readFile(effect.filePath);
    if (data.toString("ascii", 0, 4) === "OggS") {
      const duration = oggDuration(data);
      if (duration > 0) return duration;
    }
    if (data.toString("ascii", 0, 4) === "RIFF") {
      let rate = 0, bytes = 0;
      for (let at = 12; at + 8 <= data.length;) {
        const name = data.toString("ascii", at, at + 4), size = data.readUInt32LE(at + 4);
        if (name === "fmt " && size >= 16 && at + 24 <= data.length) rate = data.readUInt32LE(at + 16);
        if (name === "data") bytes += Math.min(size, data.length - at - 8);
        at += 8 + size + (size % 2);
      }
      if (rate > 0 && bytes > 0) return bytes / rate;
    }
  }
  const ffmpeg = [process.resourcesPath && path.join(process.resourcesPath, "media-tools", "ffmpeg.exe"), path.join(__dirname, "..", "media-tools", "ffmpeg.exe")].find(file => file && fs.existsSync(file));
  if (!ffmpeg) throw new Error(`无法读取音效时长：${effect.id}`);
  const { stderr } = await runLocalMediaProcess(ffmpeg, ["-hide_banner", "-i", effect.filePath], { timeoutMs: 15000, signal });
  checkCancelled(signal);
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = match && Number(match[1]) * 3600 + Number(match?.[2] || 0) * 60 + Number(match?.[3] || 0);
  if (!(seconds > 0)) throw new Error(`音效时长无效：${effect.id}`);
  return seconds;
}

function nativeContent(id, title, duration, width, height) {
  const bucketNames = "ai_translates audio_balances audio_effects audio_fades audio_track_indexes audios beats canvases chromas color_curves digital_humans drafts effects flowers green_screens handwrites hsl images log_color_wheels loudnesses manual_deformations masks material_animations material_colors multi_language_refs placeholders plugin_effects primary_color_wheels realtime_denoises shapes smart_crops smart_relights sound_channel_mappings speeds stickers tail_leaders text_templates texts time_marks transitions video_effects video_trackings videos vocal_beautifys vocal_separations".split(" ");
  const platform = { app_id: 3704, app_source: "lv", app_version: "3.9.0", device_id: "", hard_disk_id: "", mac_address: "", os: "windows", os_version: "" };
  return { canvas_config: { width, height, ratio: "original" }, color_space: -1,
    config: { adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1, lyrics_recognition_id: "", lyrics_sync: true, lyrics_taskinfo: [], maintrack_adsorb: true, material_save_mode: 0, original_sound_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_recognition_id: "", subtitle_sync: true, subtitle_taskinfo: [], video_mute: false, zoom_info_params: null },
    cover: null, create_time: 0, duration, extra_info: null, fps: 24, free_render_index_mode_on: false, group_container: null, id,
    keyframes: Object.fromEntries("adjusts audios effects filters handwrites stickers texts videos".split(" ").map(key => [key, []])),
    last_modified_platform: platform, materials: Object.fromEntries(bucketNames.map(key => [key, []])), mutable_config: null,
    name: title, new_version: "69.0.0", platform, relationships: [], render_index_track_mode_on: false, retouch_cover: null,
    source: "default", static_cover_image_path: "", tracks: [], update_time: 0, version: 360000 };
}

function nativeMeta(id) {
  return { cloud_package_completed_time: "", draft_cloud_capcut_purchase_info: "", draft_cloud_last_action_download: false,
    draft_cloud_materials: [], draft_cloud_purchase_info: "", draft_cloud_template_id: "", draft_cloud_tutorial_info: "", draft_cloud_videocut_purchase_info: "", draft_cover: "", draft_deeplink_url: "",
    draft_enterprise_info: { draft_enterprise_extra: "", draft_enterprise_id: "", draft_enterprise_name: "", enterprise_material: [] },
    draft_fold_path: "", draft_id: id, draft_is_ai_packaging_used: false, draft_is_ai_shorts: false, draft_is_ai_translate: false,
    draft_is_article_video_draft: false, draft_is_from_deeplink: "false", draft_is_invisible: false,
    draft_materials: [0, 1, 2, 3, 6, 7, 8].map(type => ({ type, value: [] })), draft_materials_copied_info: [], draft_name: "", draft_new_version: "",
    draft_removable_storage_device: "", draft_root_path: "", draft_segment_extra_info: [], draft_type: "", tm_draft_cloud_completed: "", tm_draft_cloud_modified: 0, tm_draft_removed: 0, tm_duration: 0 };
}

function track(type, name) { return { attribute: 0, flag: type === "text" ? 1 : 0, id: uid(), is_default_name: false, name, segments: [], type }; }
function segment(content, materialId, start, duration, sourceStart, type, volume = 1, renderIndex = 0) {
  const speedId = uid();
  content.materials.speeds.push({ curve_speed: null, id: speedId, mode: 0, speed: 1, type: "speed" });
  const result = { enable_adjust: true, enable_color_correct_adjust: false, enable_color_curves: true, enable_color_match_adjust: false, enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false,
    last_nonzero_volume: volume, reverse: false, track_attribute: 0, track_render_index: 0, visible: true, id: uid(), material_id: materialId,
    target_timerange: { start, duration }, common_keyframes: [], keyframe_refs: [], source_timerange: sourceStart === null ? null : { start: sourceStart, duration },
    speed: 1, volume, extra_material_refs: [speedId], is_tone_modify: false, clip: null, hdr_settings: null, render_index: renderIndex };
  if (type !== "audio") {
    result.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: type === "text" ? -0.72 : 0 } };
    result.uniform_scale = { on: true, value: 1 };
  }
  return result;
}

function subtitleMaterial(id, text) {
  // Use the native default font, not a fabricated remote resource ID or a
  // machine-specific drive-letter font/effect placeholder.
  return { id, content: JSON.stringify({ styles: [{ fill: { alpha: 1, content: { render_type: "solid", solid: { alpha: 1, color: [1, 1, 1] } } }, range: [0, text.length], size: 14, bold: false, italic: false, underline: false,
    strokes: [{ content: { solid: { alpha: 1, color: [0, 0, 0] } }, width: 0.08 }] }], text }),
    typesetting: 0, alignment: 1, letter_spacing: 0, line_spacing: 0.02, line_feed: 1, line_max_width: 0.82, force_apply_line_max_width: false, check_flag: 7, type: "subtitle", global_alpha: 1,
    font_id: "", font_name: "", font_path: "", font_resource_id: "", font_title: "none", fonts: [] };
}

async function validateJianyingDraft(directory, expectedFingerprint, signal) {
  checkCancelled(signal);
  const content = await json(path.join(directory, "draft_content.json"));
  const meta = await json(path.join(directory, "draft_meta_info.json"));
  const manifest = await json(path.join(directory, "puream_source.json"));
  if (expectedFingerprint && manifest.fingerprint !== expectedFingerprint) throw new Error("草稿版本指纹不一致");
  const uuid = value => typeof value === "string" && /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value);
  // Jianying 11.3's folder importer assigns a management ID in meta while
  // retaining the timeline ID in draft_content. They are different namespaces
  // after native adoption. Accept only metadata bound to this exact folder;
  // unpublished drafts still require equal IDs. Never rewrite native indexes.
  const nativeIdentityRemapped = uuid(meta.draft_id) && path.isAbsolute(String(meta.draft_fold_path || ""))
    && path.isAbsolute(String(meta.draft_root_path || ""))
    && path.resolve(meta.draft_fold_path) === path.resolve(directory)
    && path.resolve(meta.draft_root_path) === path.dirname(path.resolve(directory))
    && meta.draft_name === path.basename(path.resolve(directory))
    && Number(meta.tm_draft_create) > 0;
  if (!uuid(content.id) || (content.id !== meta.draft_id && !nativeIdentityRemapped)) throw new Error("草稿身份编号不一致");
  const materials = Object.values(content.materials || {}).flat();
  const byId = new Map(materials.map(item => [item.id, item]));
  for (const item of materials) for (const field of ["path", "media_path"]) if (item[field]) {
    const prefix = `${PLACEHOLDER}\\`;
    if (!item[field].startsWith(prefix)) throw new Error("草稿媒体不是可迁移的本地资源引用");
    const relative = item[field].slice(prefix.length).split("\\").join(path.sep);
    const target = path.resolve(directory, relative);
    if (!target.startsWith(path.resolve(directory) + path.sep) || !(await fsp.stat(target).catch(() => null))?.isFile()) throw new Error("草稿媒体文件丢失");
  }
  const ids = new Set();
  for (const lane of content.tracks) for (const clip of lane.segments) {
    if (ids.has(clip.id)) throw new Error("草稿片段编号重复");
    ids.add(clip.id);
    if (!byId.has(clip.material_id) || clip.extra_material_refs.some(id => !byId.has(id))) throw new Error("草稿片段素材引用无效");
    const range = clip.target_timerange;
    if (!(range.duration > 0) || range.start < 0 || range.start + range.duration > content.duration + 2) throw new Error("草稿时间线越界");
    if (clip.source_timerange && clip.source_timerange.start + clip.source_timerange.duration > finite(byId.get(clip.material_id).duration) + 2) throw new Error("草稿源媒体裁剪越界");
  }
  for (const resource of manifest.resources || []) {
    const file = path.join(directory, "resources", resource.name);
    const stat = await fsp.stat(file);
    if (stat.size !== resource.size) throw new Error("草稿媒体文件不完整");
    if (resource.sha256 && await fileHash(file, signal) !== resource.sha256) throw new Error("草稿媒体校验值不一致，原文件不会被覆盖");
  }
  return { content, meta, manifest, nativeIdentityRemapped: content.id !== meta.draft_id && nativeIdentityRemapped };
}

async function publishCopy(source, root, folderName, fingerprint, signal) {
  checkCancelled(signal);
  await fsp.mkdir(root, { recursive: true });
  let target = path.join(path.resolve(root), folderName);
  if (await readableDir(target)) {
    try { await validateJianyingDraft(target, fingerprint, signal); return target; } catch (error) { if (error.code === "LOCAL_MEDIA_CANCELLED") throw error; target += `-${crypto.randomUUID().slice(0, 8)}`; }
  }
  const stagingParent = path.join(path.dirname(path.resolve(root)), ".puream-drama-staging");
  await fsp.mkdir(stagingParent, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(stagingParent, "export-"));
  try {
    const entries = await fsp.readdir(source);
    await mapLimit(entries, 3, async entry => { checkCancelled(signal); await fsp.cp(path.join(source, entry), path.join(staging, entry), { recursive: true, force: false, errorOnExist: true }); checkCancelled(signal); });
    await validateJianyingDraft(staging, fingerprint, signal);
    checkCancelled(signal);
    await fsp.rename(staging, target);
    const now = new Date();
    await fsp.utimes(target, now, now).catch(() => {});
    await fsp.utimes(root, now, now).catch(() => {});
    return target;
  } finally {
    // Only remove the exact unique staging child that this invocation owns.
    if (path.dirname(staging) === stagingParent) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rmdir(stagingParent).catch(() => {});
  }
}

async function buildExport(options) {
  const { project = {}, videoClips = [], subtitles = [], subtitleTimingSource = "unspecified", subtitleWarnings = [], sfxPlan = {}, catalog = [], outputRoot, draftRoot, onProgress, signal } = options;
  checkCancelled(signal);
  if (!outputRoot || !path.isAbsolute(outputRoot)) throw new Error("剪映草稿输出目录必须是项目内的绝对路径");
  if (!videoClips.length) throw new Error("没有可导出的分镜视频，请先生成或导入视频");
  const warnings = [...(Array.isArray(subtitleWarnings) ? subtitleWarnings : [])];
  const notify = (stage, percent) => { try { onProgress?.({ stage, percent }); } catch { /* Progress display must not break export. */ } };
  notify("检查分镜和音效", 3);
  const clips = videoClips.map(clip => ({ ...clip, startSeconds: finite(clip.startSeconds), sourceStartSeconds: finite(clip.sourceStartSeconds), durationSeconds: finite(clip.durationSeconds) }));
  let previousEnd = 0;
  for (const clip of clips) {
    if (clip.durationSeconds <= 0 || clip.sourceStartSeconds < 0 || Math.abs(clip.startSeconds - previousEnd) > 0.000002) throw new Error(`分镜 ${clip.shotId || ""} 时间线无效、重叠或有空隙，请整理连续时间轴后重试`);
    if (finite(clip.sourceDurationSeconds) > 0 && clip.sourceStartSeconds + clip.durationSeconds > finite(clip.sourceDurationSeconds) + 0.000002) throw new Error(`分镜 ${clip.shotId || ""} 裁剪超出原视频时长`);
    previousEnd = clip.startSeconds + clip.durationSeconds;
  }
  const duration = us(previousEnd);
  const resources = new Map();
  const addResource = async filePath => {
    checkCancelled(signal);
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("媒体文件路径必须是已存在的本地绝对路径");
    const source = path.resolve(filePath || "");
    if (resources.has(source)) return resources.get(source);
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat?.isFile() || !stat.size) throw new Error(`媒体文件不存在或为空：${path.basename(source)}`);
    const name = `${digest(source).slice(0, 16)}${path.extname(source).toLowerCase() || ".bin"}`;
    const item = { source, name, size: stat.size, mtimeMs: stat.mtimeMs };
    resources.set(source, item);
    item.sha256 = await fileHash(source, signal);
    const hashedStat = await fsp.stat(source);
    if (hashedStat.size !== item.size || hashedStat.mtimeMs !== item.mtimeMs) throw new Error("导出期间媒体文件发生变化，请等待当前操作完成后重试");
    return item;
  };
  await mapLimit(clips, 4, clip => addResource(clip.filePath));
  const byEffect = new Map((Array.isArray(catalog) ? catalog : catalog.effects || []).map(item => [item.id, item]));
  const rawCues = Array.isArray(sfxPlan.cues) ? sfxPlan.cues : (sfxPlan.shots || []).flatMap(shot => (shot.cues || []).map(cue => ({ ...cue, shotId: shot.shotId })));
  const effects = new Map();
  await mapLimit([...new Set(rawCues.map(cue => cue.effectId))], 4, async id => {
    const effect = byEffect.get(id);
    if (!effect?.filePath) { warnings.push(`音效 ${id} 不存在，已保留视频和字幕`); return; }
    try { const resource = await addResource(effect.filePath); effects.set(id, { ...effect, resource, durationSeconds: await audioDuration(effect, signal) }); }
    catch (error) { if (error.code === "LOCAL_MEDIA_CANCELLED") throw error; warnings.push(`音效 ${id} 文件不可用，已跳过该独立音轨`); }
  });
  const normalizedSubtitles = subtitles.map(line => ({ text: String(line.text || "").trim(), startUs: Math.round(finite(line.startUs)), durationUs: Math.round(finite(line.durationUs)), speaker: String(line.speaker || "") })).filter(line => line.text && line.durationUs > 0);
  for (const line of normalizedSubtitles) if (line.startUs < 0 || line.startUs + line.durationUs > duration + 2) throw new Error("字幕超出视频时间线，请重新生成字幕时间轴");
  // Installers may touch unchanged built-in audio files. Draft identity follows
  // the actual bytes, not the installation timestamp. Hashing also detects a
  // same-size replacement whose timestamp was preserved.
  const fingerprint = digest({ contract: CONTRACT_VERSION, projectId: project.id, title: project.title, clips: clips.map(clip => ({ shotId: clip.shotId, filePath: path.resolve(clip.filePath), startSeconds: clip.startSeconds, durationSeconds: clip.durationSeconds, sourceStartSeconds: clip.sourceStartSeconds, sourceDurationSeconds: clip.sourceDurationSeconds, width: clip.width, height: clip.height })), resources: [...resources.values()].map(({source,name,size,sha256})=>({source,name,size,sha256})).sort((a,b) => a.source.localeCompare(b.source)), subtitles: normalizedSubtitles, subtitleTimingSource, subtitleWarnings, cues: rawCues, effects: [...effects].map(([id,effect]) => ({ id, duration: effect.durationSeconds })).sort((a,b) => a.id.localeCompare(b.id)) });
  const folderName = `puream_drama_${safeName(project.title)}_${fingerprint.slice(0, 12)}`;
  const output = path.join(outputRoot, folderName);
  let current = null;
  if (await readableDir(output)) current = await validateJianyingDraft(output, fingerprint, signal).catch(error => { if (error.code === "LOCAL_MEDIA_CANCELLED") throw error; return null; });
  const reused = !!current;
  let draftPath = output;
  if (!current) {
    if (await readableDir(output)) draftPath += `-${crypto.randomUUID().slice(0, 8)}`;
    await fsp.mkdir(outputRoot, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(outputRoot, ".draft-building-"));
    try {
      await fsp.mkdir(path.join(staging, "resources"));
      let done = 0;
      await mapLimit([...resources.values()], 3, async resource => {
        checkCancelled(signal);
        await fsp.copyFile(resource.source, path.join(staging, "resources", resource.name), fs.constants.COPYFILE_EXCL);
        checkCancelled(signal);
        const copiedSource = await fsp.stat(resource.source);
        if (copiedSource.size !== resource.size || copiedSource.mtimeMs !== resource.mtimeMs) throw new Error("导出期间分镜媒体发生变化，请等待当前操作完成后重试");
        const copiedHash = await fileHash(path.join(staging, "resources", resource.name), signal);
        if (copiedHash !== resource.sha256) throw new Error("导出期间媒体内容发生变化，请等待当前操作完成后重试");
        checkCancelled(signal);
        notify("复制可编辑草稿素材", 10 + Math.round(++done / resources.size * 65));
      });
      const id = uid(), first = clips[0];
      const content = nativeContent(id, String(project.title || "短剧粗剪"), duration, Math.round(finite(first.width, 1080)) || 1080, Math.round(finite(first.height, 1920)) || 1920);
      const videoTrack = track("video", "分镜视频（保留原声）");
      content.tracks.push(videoTrack);
      for (const clip of clips) {
        const resource = resources.get(path.resolve(clip.filePath)), materialId = uid();
        const mediaPath = portable(resource.name), sourceDuration = us(Math.max(finite(clip.sourceDurationSeconds), clip.sourceStartSeconds + clip.durationSeconds));
        content.materials.videos.push({ audio_fade: null, category_id: "", category_name: "local", check_flag: 63487, crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 }, crop_ratio: "free", crop_scale: 1, duration: sourceDuration, height: Math.round(finite(clip.height, content.canvas_config.height)), id: materialId, local_material_id: materialId, material_id: materialId, material_name: String(clip.shotId || path.basename(clip.filePath)), media_path: mediaPath, path: mediaPath, type: "video", width: Math.round(finite(clip.width, content.canvas_config.width)) });
        videoTrack.segments.push(segment(content, materialId, us(clip.startSeconds), us(clip.durationSeconds), us(clip.sourceStartSeconds), "video"));
      }
      const lanes = [];
      let cueCount = 0;
      for (const cue of rawCues) {
        const effect = effects.get(cue.effectId); if (!effect) continue;
        const start = Math.max(0, us(finite(cue.programmeTimeSeconds, cue.startSeconds)));
        const sourceDuration = Math.max(1, us(effect.durationSeconds));
        const wanted = us(finite(cue.durationSeconds) > 0 ? Number(cue.durationSeconds) : effect.durationSeconds);
        let remaining = Math.min(duration - start, cue.loop ? wanted : Math.min(wanted, sourceDuration));
        if (remaining <= 0) continue;
        const role = cue.role === "ambience" ? "环境音" : "剧情特效音";
        let lane = lanes.find(item => item.name.startsWith(role) && item.end <= start);
        if (!lane) { lane = { ...track("audio", `${role} ${lanes.filter(item => item.name.startsWith(role)).length + 1}`), end: 0 }; lanes.push(lane); }
        const materialId = uid();
        content.materials.audios.push({ app_id: 0, category_id: "", category_name: "local", check_flag: 3, copyright_limit_type: "none", duration: sourceDuration, effect_id: "", formula_id: "", id: materialId, local_material_id: materialId, music_id: materialId, name: effect.displayName || effect.id, path: portable(effect.resource.name), source_platform: 0, type: "extract_music", wave_points: [] });
        let offset = start, repeats = 0;
        while (remaining > 0 && repeats++ < 10000) {
          const length = Math.min(remaining, sourceDuration);
          const clip = segment(content, materialId, offset, length, 0, "audio", Math.pow(10, Math.max(-60, Math.min(0, finite(cue.gainDb, -18))) / 20));
          // Native AudioFade fields are verified against pyJianYingDraft's
          // segment.AudioFade.export_json (microseconds, fade_type 0).
          // Short joins prevent clicks between separately editable loop clips.
          let fadeIn = offset === start ? us(Math.max(0, finite(cue.fadeInSeconds, 0.006))) : Math.min(5000, Math.floor(length / 4));
          let fadeOut = remaining <= sourceDuration ? us(Math.max(0, finite(cue.fadeOutSeconds, 0.01))) : Math.min(5000, Math.floor(length / 4));
          if (fadeIn + fadeOut > length) { const ratio = length / (fadeIn + fadeOut); fadeIn = Math.floor(fadeIn * ratio); fadeOut = Math.floor(fadeOut * ratio); }
          if (fadeIn > 0 || fadeOut > 0) { const fadeId = uid(); content.materials.audio_fades.push({ id: fadeId, fade_in_duration: fadeIn, fade_out_duration: fadeOut, fade_type: 0, type: "audio_fade" }); clip.extra_material_refs.push(fadeId); }
          lane.segments.push(clip); remaining -= length; offset += length;
        }
        if (remaining > 0) warnings.push(`音效 ${cue.effectId} 循环过长，已在安全长度停止`);
        lane.end = offset; cueCount++;
      }
      content.tracks.push(...lanes.map(({ end, ...lane }) => lane));
      if (normalizedSubtitles.length) {
        const textTrack = track("text", "自动字幕（可编辑）");
        for (const line of normalizedSubtitles) { const materialId = uid(); content.materials.texts.push(subtitleMaterial(materialId, line.text)); textTrack.segments.push(segment(content, materialId, line.startUs, line.durationUs, null, "text", 1, 14000)); }
        content.tracks.push(textTrack);
      }
      const manifest = { contractVersion: CONTRACT_VERSION, fingerprint, projectId: project.id || "", createdAt: new Date().toISOString(), nativeImportContract: "minimal-atomic-import-placeholder-v1", jianyingOwnedIndexes: "untouched", soundsBakedIntoVideo: false, subtitlesBakedIntoVideo: false, subtitleTimingSource, subtitleWarnings, resources: [...resources.values()], counts: { videos: clips.length, subtitles: normalizedSubtitles.length, sfxCues: cueCount, audioTracks: lanes.length }, warnings };
      await fsp.writeFile(path.join(staging, "draft_content.json"), JSON.stringify(content), "utf8");
      await fsp.writeFile(path.join(staging, "draft_meta_info.json"), JSON.stringify(nativeMeta(id)), "utf8");
      await fsp.writeFile(path.join(staging, "puream_source.json"), JSON.stringify(manifest, null, 2), "utf8");
      await fsp.writeFile(path.join(staging, "subtitles.srt"), require("./jianying-subtitles").toSrt(normalizedSubtitles), "utf8");
      await fsp.writeFile(path.join(staging, "字幕与音轨说明.txt"), ["本草稿的视频原声、剧情特效音、环境音与字幕均可分别编辑。字幕和新增特效音没有烧录进视频。", `字幕时间轴来源：${subtitleTimingSource}`, "ASR/识别时间轴来自已有识别结果；估算时间轴只根据剧本与说话时段排版，并不表示已核验实际口型。请播放视频检查后再定稿。", ...warnings].join("\r\n"), "utf8");
      await validateJianyingDraft(staging, fingerprint, signal);
      checkCancelled(signal);
      await fsp.rename(staging, draftPath);
      current = { content, manifest };
    } finally { if (path.dirname(staging) === path.resolve(outputRoot)) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }
  notify("发布剪映草稿", 90);
  let registered = false, installedDraftPath = "";
  if (draftRoot) {
    try { installedDraftPath = await publishCopy(draftPath, draftRoot, path.basename(draftPath), fingerprint, signal); registered = true; }
    catch (error) { if (error.code === "LOCAL_MEDIA_CANCELLED") throw error; warnings.push(`草稿已保存在项目目录，自动放入剪映失败：${error.message}`); }
  } else warnings.push("未找到剪映草稿目录，草稿已保存在项目目录；可在设置中指定剪映草稿位置后再次导出");
  notify("草稿生成完成", 100);
  return { draftPath, installedDraftPath, draftId: current.content.id, durationSeconds: duration / 1e6, counts: current.manifest.counts, warnings: [...new Set([...(current.manifest.warnings || []), ...warnings])], registered, registrationMode: registered ? "published-to-draft-folder-index-owned-by-jianying" : "project-copy-only", fingerprint, reused };
}

async function exportJianyingDraft(options) {
  const key = `${path.resolve(options.outputRoot || ".")}|${options.project?.id || ""}`;
  const signature = digest({ project: options.project?.id, title: options.project?.title, clips: options.videoClips, subtitles: options.subtitles, subtitleTimingSource: options.subtitleTimingSource, subtitleWarnings: options.subtitleWarnings, cues: options.sfxPlan?.shots || options.sfxPlan?.cues, draftRoot: options.draftRoot });
  const existing = running.get(key);
  if (existing) {
    if (existing.signature === signature) return existing.promise;
    await existing.promise.catch(() => {});
    checkCancelled(options.signal);
    return exportJianyingDraft(options);
  }
  const promise = buildExport(options);
  const entry = { signature, promise };
  running.set(key, entry);
  try { return await promise; } finally { if (running.get(key) === entry) running.delete(key); }
}

module.exports = { exportJianyingDraft, detectJianyingDraftRoot, validateJianyingDraft, PLACEHOLDER, CONTRACT_VERSION };
