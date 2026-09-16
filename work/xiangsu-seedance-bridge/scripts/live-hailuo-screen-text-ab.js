"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { BridgeClient } = require("../app/bridge-client");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { DramaLicenseClient } = require("../app/license-gate");
const { hydratePureamDefaults } = require("../app/puream-auth-config");
const { buildApprovedHailuoPrompt } = require("../app/hailuo-h3-natural-prompt");

const USER_DATA = path.join(process.env.APPDATA, "xiangsu-seedance-bridge");
const WORKBENCH = path.join(USER_DATA, "workbench");
const OUTPUT = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260821-DRAMA-PROMPT-DEFAULT-085/hailuo-ab");
const LIBRARY = path.join(WORKBENCH, "reusable-asset-library", "files");
const FFMPEG = path.resolve(__dirname, "../media-tools/ffmpeg.exe");
const ASSETS = {
  character: path.join(LIBRARY, "asset_mstmoky8_0d6b7efa.png"),
  scene: path.join(LIBRARY, "asset_msmwl38x_09cf2d4a.png"),
  voice: path.join(LIBRARY, "asset_mst65c82_2fe3db87.wav")
};

function report(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

app.setName("xiangsu-seedance-bridge");
app.setPath("userData", USER_DATA);

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUTPUT, { recursive: true });
    for (const filePath of Object.values(ASSETS)) {
      if (!fs.existsSync(filePath)) throw new Error(`missing historical test asset: ${filePath}`);
    }
    const decode = value => {
      const raw = String(value || "");
      if (!raw.startsWith("enc:")) return raw;
      if (!safeStorage.isEncryptionAvailable()) return "";
      return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64"));
    };
    const encode = value => value ? `enc:${safeStorage.encryptString(String(value)).toString("base64")}` : "";
    const license = new DramaLicenseClient();
    const store = new WorkbenchStore(WORKBENCH, { encode, decode });
    hydratePureamDefaults(store, license.storedActivationCode());
    const settings = store.getSettings();
    settings.videoProvider = { ...settings.videoProvider, kind: "puream-hailuo-h3", baseUrl: "https://puream.cn", model: "hailuo-h3" };
    store.saveSettings(settings);
    const bridge = new BridgeClient();
    bridge.configure(settings.videoProvider);
    const workflow = new WorkbenchWorkflow({
      store,
      bridge,
      locateFfmpeg: () => FFMPEG,
      stagingRoot: path.join(OUTPUT, "staging"),
      licenseClient: license
    });
    await license.ensureSession();
    const created = store.createProject(`海螺屏幕文字A-B最低成本实测-${Date.now()}`, {
      inputMode: "manual",
      executionMode: "step",
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      mode: "storyboard_sheet",
      modeConfirmed: true,
      targetDurationSeconds: 10,
      shotDuration: 5
    });
    store.patchProject(created.id, {
      generation: { ...created.generation, engine: "hailuo-h3", videoProviderKind: "puream-hailuo-h3", mode: "storyboard_sheet", modeConfirmed: true, shotDuration: 5, aspectRatio: "9:16" },
      characters: [{ id: "C01", name: "母亲", voiceDescription: "中老年女声，克制温和" }],
      scenes: [{ id: "SC01", name: "旧楼门口" }],
      shots: [
        { id: "S01", number: 1, duration: 5, promptMode: "manual", characterIds: ["C01"], visibleCharacterIds: ["C01"], dialogueTurns: [] },
        { id: "S02", number: 2, duration: 5, promptMode: "manual", characterIds: ["C01"], visibleCharacterIds: ["C01"], dialogueTurns: [] }
      ]
    });
    const project = store.getProject(created.id);
    const references = {
      hailuoApiMode: "multimodal_to_video",
      aspectRatio: "9:16",
      images: [ASSETS.character, ASSETS.scene],
      imageRoles: [
        { type: "character", entityId: "C01", path: ASSETS.character },
        { type: "scene", entityId: "SC01", path: ASSETS.scene }
      ],
      videos: [],
      videoRoles: [],
      audios: [{ characterId: "C01", characterName: "母亲", path: ASSETS.voice, duration: 3 }]
    };
    const dialogueTurns = [{
      speakerId: "C01",
      text: "饭还热着，你先吃一口。",
      sourceTone: "轻声安慰，前半句温柔，后半句放慢",
      metadata: { body: "双手把饭盒递向门内，目光克制", listenerBeat: "无人回应" }
    }];
    const basePrompt = buildApprovedHailuoPrompt({
      project,
      shot: { id: "S01", duration: 5, characterIds: ["C01"], visibleCharacterIds: ["C01"], providerDirectionsEn: ["The mother climbs the last step and offers a metal lunch box toward the doorway; slow push-in to her restrained face."] },
      references,
      dialogueTurns
    });
    const emphasizedPrompt = basePrompt.replace(
      "delivery:",
      "screen_policy: NO subtitles, captions, title cards, labels, interface text, logos, watermarks, or written overlays. delivery:"
    );
    const variants = [
      { key: "A-emphasized", shotId: "S01", prompt: emphasizedPrompt },
      { key: "B-omitted", shotId: "S02", prompt: basePrompt.replace("production: S01", "production: S02") }
    ];
    const results = [];
    for (const variant of variants) {
      report("submit", { key: variant.key, promptChars: variant.prompt.length });
      const leaseTaskId = `video:${created.id}:${variant.shotId}:screen-text-ab`;
      const candidate = await workflow.withLicenseLease("video", leaseTaskId, {
        projectId: created.id,
        stage: "shot_video",
        entityType: "shot",
        entityId: variant.shotId,
        experiment: "screen-text-ab"
      }, () => workflow._submitVideoUnlocked(created.id, "shot", variant.shotId, "shot_video", variant.prompt, references, 5, "", "480"));
      const target = path.join(OUTPUT, `${variant.key}.mp4`);
      if (!candidate?.filePath || !fs.existsSync(candidate.filePath)) throw new Error(`${variant.key} returned no local video`);
      fs.copyFileSync(candidate.filePath, target);
      const item = { key: variant.key, shotId: variant.shotId, candidateId: candidate.id, path: target, bytes: fs.statSync(target).size, chargeYuan: candidate.chargeYuan ?? null, prompt: variant.prompt };
      results.push(item);
      report("finished", { ...item, prompt: undefined });
    }
    const resultPath = path.join(OUTPUT, "generation-report.json");
    fs.writeFileSync(resultPath, `${JSON.stringify({ at: new Date().toISOString(), projectId: created.id, retries: 0, results }, null, 2)}\n`, "utf8");
    report("complete", { resultPath, projectId: created.id });
    app.exit(0);
  } catch (error) {
    report("fatal", { code: error.code || "", message: error.message, stack: error.stack });
    app.exit(1);
  }
});
