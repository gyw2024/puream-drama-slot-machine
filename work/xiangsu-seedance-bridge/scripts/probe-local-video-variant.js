"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { BridgeClient } = require("../app/bridge-client");

async function main() {
  const projectPath = String(process.env.DRAMA_SLOT_PROBE_PROJECT || "").trim();
  const shotId = String(process.env.DRAMA_SLOT_PROBE_SHOT || "S01").trim();
  const includeAudio = String(process.env.DRAMA_SLOT_PROBE_INCLUDE_AUDIO || "0") === "1";
  if (!path.isAbsolute(projectPath) || !fs.existsSync(projectPath)) throw new Error("DRAMA_SLOT_PROBE_PROJECT must be an existing absolute project.json path");
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const sourceJob = (project.jobs || [])
    .filter(job => job.entityId === shotId
      && job.type === "shot_video"
      && job.referenceManifest
      && String(job.prompt || "").trim()
      && (!includeAudio || (job.referenceManifest.audios || []).length > 0))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
  if (!sourceJob) throw new Error(`No reusable ${shotId} shot-video submission contract was found`);

  const outputDir = path.join(path.dirname(projectPath), "assets", "videos", "diagnostic-variants");
  fs.mkdirSync(outputDir, { recursive: true });
  const variant = includeAudio ? "with-audio" : "without-audio";
  const prompt = String(process.env.DRAMA_SLOT_PROBE_PROMPT || sourceJob.prompt).trim();
  const overrideAudioPath = String(process.env.DRAMA_SLOT_PROBE_AUDIO_PATH || "").trim();
  const overrideAudioDuration = Number(process.env.DRAMA_SLOT_PROBE_AUDIO_DURATION || 0);
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ variant, prompt, at: Date.now() }))
    .digest("hex")
    .slice(0, 40);
  const payload = {
    providerKind: "local-xiangsu",
    ability: "SD_2.0_MINI",
    clientRequestId: `diag-${variant}-${fingerprint}`,
    prompt,
    duration: Number(sourceJob.duration) || 10,
    aspectRatio: project.generation?.aspectRatio || "9:16",
    images: (sourceJob.referenceManifest.images || []).map(item => ({
      path: item.filePath || item.path,
      remoteUrl: item.remoteUrl || ""
    })),
    videos: [],
    audios: includeAudio
      ? (overrideAudioPath
          ? [{ path: overrideAudioPath, duration: overrideAudioDuration }]
          : (sourceJob.referenceManifest.audios || []).map(item => ({
              path: item.filePath,
              duration: Number(item.duration) || 0
            })))
      : [],
    outputDir
  };
  const client = new BridgeClient();
  client.configure({ kind: "local-xiangsu" });
  const submitted = await client.submit(payload);
  process.stdout.write(`${JSON.stringify({ event: "submitted", variant, taskId: submitted.taskId, images: payload.images.length, audios: payload.audios.length, promptChars: [...prompt].length })}\n`);
  for (;;) {
    const result = await client.query(submitted.taskId);
    process.stdout.write(`${JSON.stringify({
      event: "status",
      variant,
      taskId: submitted.taskId,
      status: result.status,
      statusCode: result.statusCode,
      code: result.code || "",
      message: result.message || "",
      localPath: result.localPath || ""
    })}\n`);
    if (["finished", "failed", "discarded"].includes(String(result.status || ""))) {
      if (result.status !== "finished") process.exitCode = 2;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ code: error?.code || "PROBE_FAILED", message: error?.message || String(error), stack: error?.stack || "" })}\n`);
  process.exitCode = 1;
});
