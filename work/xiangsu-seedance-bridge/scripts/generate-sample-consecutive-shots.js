"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { BridgeClient } = require("../app/bridge-client");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const { DramaLicenseClient } = require("../app/license-gate");
const { hydratePureamDefaults } = require("../app/puream-auth-config");

const USER_DATA = path.join(process.env.APPDATA, "xiangsu-seedance-bridge");
const WORKBENCH = path.join(USER_DATA, "workbench");
const PROJECT_ID = "project_msy00pq3_f3fc7fd2";
const OUT_DIR = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-KNEE-BRACE-PARSE/sample-videos");
const FFMPEG = path.resolve(__dirname, "../media-tools/ffmpeg.exe");
const LIB = path.join(WORKBENCH, "reusable-asset-library", "files");

const ASSETS = {
  mom: path.join(LIB, "asset_mstmoky8_0d6b7efa.png"),
  wife: path.join(LIB, "asset_mstmoml5_271643a5.png"),
  scene: path.join(LIB, "asset_msmwl38x_09cf2d4a.png"),
  momVoice: path.join(LIB, "asset_mst65c82_2fe3db87.wav"),
  wifeVoice: path.join(LIB, "asset_mst65c5b_f7abb022.wav")
};

const LOCK = "FINAL OUTPUT LOCK: live story at frame 1; refs stay offscreen. Dialogue+room tone+SFX only. NO BGM, subtitles/text/UI/logos, narration, intros, portraits or asset boards.";

function promptFor(lines) {
  return [
    "subject_definitions:",
    "<Subject 1> is the elderly mother in <Picture 1>.",
    "<Subject 2> is the younger woman in <Picture 2>.",
    "<Picture 3> is the old alley doorway landing.",
    "<Audio 1>: <Subject 1> voice.",
    "<Audio 2>: <Subject 2> voice.",
    "",
    "summary:",
    "One continuous generated clip; 3 timed shots; reference+audio.",
    "",
    "retention_analysis:",
    "Preserve identity, wardrobe, set, props, light, axis, room tone.",
    "",
    "detailed_description:",
    "CONTINUITY LOCK: Keep identity, wardrobe, set, props, light, eyelin; Use direct editorial hard cuts at the exact segment bou",
    ...lines,
    "End on closed lips; no boards or text.",
    "",
    "overall_soundscape: Continuous room tone and synchronized visible-action SFX onl",
    "",
    "non_diegetic_music: N/A",
    "",
    LOCK
  ].join("\n");
}

const SHOTS = [
  {
    id: "S01",
    prompt: promptFor([
      "[Shot 1|0.0-3.5s] OPEN; medium close-up; MOUTH=<Subject 1>; OTHERS=CLOSED; <Audio 1>:<Subject 1>-> <Subject 2>; <Subject 1> climbs the last steps holding a metal lunch box, breathless, and says: <d>[Chinese] 饭还热着。</d>.",
      "[Shot 2|3.5-7.0s] HARD_CUT@3.5s; medium close-up; MOUTH=<Subject 2>; OTHERS=CLOSED; <Audio 2>:<Subject 2>-> <Subject 1>; <Subject 2> blocks the doorway with one arm and says: <d>[Chinese] 你别上来了。</d>.",
      "[Shot 3|7.0-10.0s] HARD_CUT@7.0s; medium shot; FOCUS=the lunch box jammed in the door gap; LIPS=CLOSED; No speech."
    ])
  },
  {
    id: "S02",
    prompt: promptFor([
      "[Shot 1|0.0-3.5s] OPEN; close-up; MOUTH=<Subject 2>; OTHERS=CLOSED; <Audio 2>:<Subject 2>-> <Subject 1>; <Subject 2> stares at a dirty cloth wrap on <Subject 1>'s right knee and says: <d>[Chinese] 这布条脏死了。</d>.",
      "[Shot 2|3.5-7.0s] HARD_CUT@3.5s; close-up; MOUTH=<Subject 1>; OTHERS=CLOSED; <Audio 1>:<Subject 1>-> <Subject 2>; <Subject 1> covers her right knee with both hands and says: <d>[Chinese] 别扯。</d>.",
      "[Shot 3|7.0-10.0s] HARD_CUT@7.0s; insert of <Subject 2>'s fingers gripping the cloth wrap; LIPS=CLOSED; No speech."
    ])
  },
  {
    id: "S03",
    prompt: promptFor([
      "[Shot 1|0.0-3.5s] OPEN; close-up; MOUTH=<Subject 2>; OTHERS=CLOSED; <Audio 2>:<Subject 2>-> <Subject 1>; <Subject 2> yanks the dirty wrap off the knee and says: <d>[Chinese] 看着就穷。</d>.",
      "[Shot 2|3.5-7.0s] HARD_CUT@3.5s; medium close-up; MOUTH=<Subject 1>; OTHERS=CLOSED; <Audio 1>:<Subject 1>-> <Subject 2>; <Subject 1> grips the stair rail in pain and says: <d>[Chinese] 晓晓。</d>.",
      "[Shot 3|7.0-10.0s] HARD_CUT@7.0s; the torn wrap lands on the step, the swollen right knee exposed; LIPS=CLOSED; No speech."
    ])
  }
];

function log(stage, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), stage, ...detail })}\n`);
}

app.setName("xiangsu-seedance-bridge");
app.setPath("userData", USER_DATA);

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const filePath of Object.values(ASSETS)) {
      if (!fs.existsSync(filePath)) throw new Error(`缺少历史资产：${filePath}`);
    }
    const decode = value => {
      if (!String(value || "").startsWith("enc:")) return value || "";
      if (!safeStorage.isEncryptionAvailable()) return "";
      try { return safeStorage.decryptString(Buffer.from(String(value).slice(4), "base64")); }
      catch { return ""; }
    };
    const license = new DramaLicenseClient();
    const store = new WorkbenchStore(WORKBENCH, {
      encode: value => value ? `enc:${safeStorage.encryptString(value).toString("base64")}` : "",
      decode
    });
    hydratePureamDefaults(store, license.storedActivationCode());
    const settings = store.getSettings();
    const bridge = new BridgeClient();
    bridge.configure(settings.videoProvider);
    const workflow = new WorkbenchWorkflow({
      store,
      bridge,
      locateFfmpeg: () => (fs.existsSync(FFMPEG) ? FFMPEG : ""),
      stagingRoot: path.join(process.env.LOCALAPPDATA || osTmp(), "PureamDramaSlot", "sample-staging"),
      licenseClient: license
    });
    try { await license.ensureSession(); } catch (error) {
      log("license-warn", { message: error.message });
    }
    const project = store.getProject(PROJECT_ID);
    project.shots = (project.shots || []).map(item => {
      const authored = SHOTS.find(shot => shot.id === item.id);
      return authored
        ? { ...item, promptMode: "manual", manualVideoPrompt: authored.prompt }
        : item;
    });
    store.saveProject(project);
    const results = [];
    for (const shot of SHOTS) {
      log("submit", { shotId: shot.id, promptChars: shot.prompt.length });
      const liveShot = (store.getProject(PROJECT_ID).shots || []).find(item => item.id === shot.id) || { id: shot.id, number: Number(shot.id.slice(1)), characterIds: ["C01", "C02"] };
      const references = {
        hailuoApiMode: "multimodal_to_video",
        aspectRatio: "9:16",
        images: [ASSETS.mom, ASSETS.wife, ASSETS.scene],
        imageRoles: [
          { type: "character_intro", sourceStage: "character_intro", entityId: "C01", label: "周妈身份图，禁止作为静态展示", path: ASSETS.mom },
          { type: "character_intro", sourceStage: "character_intro", entityId: "C02", label: "陈晓身份图，禁止作为静态展示", path: ASSETS.wife },
          { type: "scene_asset", sourceStage: "scene_asset", entityId: "SC01", label: "旧楼门口环境，禁止作为静态展示", path: ASSETS.scene }
        ],
        audios: [
          { characterId: "C01", characterName: "周妈", path: ASSETS.momVoice, duration: 3, label: "周妈音色" },
          { characterId: "C02", characterName: "陈晓", path: ASSETS.wifeVoice, duration: 3, label: "陈晓音色" }
        ],
        videos: [],
        agentGenerationBlockShot: liveShot
      };
      const candidate = await workflow.submitVideo(PROJECT_ID, "shot", shot.id, "shot_video", shot.prompt, references, 10);
      const dest = path.join(OUT_DIR, `${shot.id}.mp4`);
      if (candidate?.filePath && fs.existsSync(candidate.filePath)) {
        fs.copyFileSync(candidate.filePath, dest);
      }
      results.push({
        shotId: shot.id,
        candidateId: candidate?.id || "",
        filePath: dest,
        source: candidate?.filePath || "",
        exists: fs.existsSync(dest),
        chargeYuan: candidate?.chargeYuan ?? null
      });
      log("done-shot", results.at(-1));
    }
    fs.writeFileSync(path.join(OUT_DIR, "result.json"), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`, "utf8");
    log("all-done", { outDir: OUT_DIR, results });
    app.exit(results.every(item => item.exists) ? 0 : 2);
  } catch (error) {
    log("fatal", { code: error.code, message: error.message, stack: error.stack });
    app.exit(1);
  }
});

function osTmp() {
  return require("node:os").tmpdir();
}
