"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WorkbenchStore } = require("../app/workbench-store");
const {
  WorkbenchWorkflow,
  parseStructuredProductionScript
} = require("../app/workbench-workflow");
const { detectUploadedScriptFormat } = require("../app/dialogue-parser");
const { estimateUploadedScriptDuration } = require("../app/script-duration");

const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const SCRIPT_PATH = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-KNEE-BRACE-PARSE/六楼的膝盖-360秒制作稿.txt");
const PRODUCT_SRC = path.join(LIVE_ROOT, "projects", "project_msk9g1tb_9e7e6183", "assets", "product", "product-1786186704448.png");
const REPORT_PATH = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-KNEE-BRACE-PARSE/parse-report.json");
const APP_EXE = path.resolve("D:/Backup/Documents/无限画布/纯梦短剧老虎机/release/0.16.15-996b4fd/纯梦短剧老虎机.exe");

const EXPECTED = {
  characters: ["周妈", "陈晓", "周建", "刘姨"],
  scenes: ["六楼楼梯口", "周家客厅", "社区诊所走廊"],
  props: ["保温饭盒", "医院检查单", "旧布条", "搬家协议"],
  wardrobes: ["酒红大衣", "干净深蓝外套"],
  product: "硅胶护膝",
  seconds: 360,
  shots: 36
};

function snapshot(project) {
  return {
    id: project.id,
    title: project.title,
    stage: project.currentStage,
    status: project.status,
    method: project.script?.analysisMethod || "",
    seconds: (project.shots || []).reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0),
    shots: (project.shots || []).map(item => ({
      id: item.id,
      duration: item.duration,
      scene: item.sceneName || item.scene,
      characters: item.characterNames || item.characters || [],
      productMention: Boolean(item.productMention),
      props: item.props || []
    })),
    characters: (project.characters || []).map(item => ({ id: item.id, name: item.name })),
    scenes: (project.scenes || []).map(item => ({ id: item.id, name: item.name })),
    props: (project.assetLibraries?.props || []).map(item => item.name),
    wardrobes: (project.assetLibraries?.wardrobes || []).map(item => item.label || item.name),
    characterOutfits: (project.characters || []).flatMap(character => (character.outfits || []).map(item => `${character.name}:${item.label || item.name}`)),
    productShots: (project.shots || []).filter(item => item.productMention).map(item => item.id),
    product: project.product || {}
  };
}

function judge(parsed) {
  const missing = (want, have) => want.filter(name => !have.some(item => String(item).includes(name)));
  const extraCharacters = parsed.characters.map(item => item.name).filter(name => !EXPECTED.characters.includes(name));
  return {
    secondsOk: parsed.seconds === EXPECTED.seconds,
    shotCountOk: parsed.shots.length === EXPECTED.shots,
    missingCharacters: missing(EXPECTED.characters, parsed.characters.map(item => item.name)),
    extraCharacters,
    missingScenes: missing(EXPECTED.scenes, parsed.scenes.map(item => item.name)),
    missingProps: missing(EXPECTED.props, parsed.props),
    missingWardrobes: missing(EXPECTED.wardrobes, [...parsed.wardrobes, ...parsed.characterOutfits]),
    productBound: parsed.product?.name === EXPECTED.product && Boolean(parsed.product?.imagePath) && fs.existsSync(parsed.product.imagePath),
    productShots: parsed.productShots,
    productFirstShot: parsed.productShots[0] || "",
    productAfterReversal: parsed.productShots.length > 0
      && Number(String(parsed.productShots[0]).replace(/\D/g, "")) >= 25
      && !parsed.productShots.includes("S04"),
    s01Characters: parsed.shots[0]?.characters || [],
    s01CharactersOk: ["周妈", "陈晓"].every(name => (parsed.shots[0]?.characters || []).includes(name))
      && !(parsed.shots[0]?.characters || []).includes("周建"),
    stairShots: parsed.shots.filter(item => item.scene === "六楼楼梯口").map(item => item.id),
    livingShots: parsed.shots.filter(item => item.scene === "周家客厅").map(item => item.id),
    clinicShots: parsed.shots.filter(item => item.scene === "社区诊所走廊").map(item => item.id),
    s01: parsed.shots[0] || null
  };
}

async function main() {
  if (!fs.existsSync(SCRIPT_PATH)) throw new Error(`缺少剧本：${SCRIPT_PATH}`);
  if (!fs.existsSync(PRODUCT_SRC)) throw new Error(`缺少历史商品图：${PRODUCT_SRC}`);
  const raw = fs.readFileSync(SCRIPT_PATH, "utf8");
  const format = detectUploadedScriptFormat(raw);
  const duration = estimateUploadedScriptDuration(raw);
  const structured = parseStructuredProductionScript(raw);

  const store = new WorkbenchStore(LIVE_ROOT, {
    encode: value => value,
    decode: value => value
  });

  const created = store.createProject("六楼的膝盖｜硅胶护膝解析测试", {
    inputMode: "manual",
    targetDurationSeconds: 360,
    shotDuration: 10,
    videoProviderKind: "puream-hailuo-h3"
  });
  const productDir = store.assetDir(created.id, "product");
  fs.mkdirSync(productDir, { recursive: true });
  const productPath = path.join(productDir, "product-historical-knee-brace.png");
  fs.copyFileSync(PRODUCT_SRC, productPath);

  store.patchProject(created.id, {
    productionPlan: {
      ...(store.getProject(created.id).productionPlan || {}),
      inputMode: "manual",
      scriptHandling: "respect",
      commerceMode: "natural",
      executionMode: "step"
    },
    product: {
      name: "硅胶护膝",
      description: "保护膝盖半月板损伤",
      sellingPoints: "保护膝盖半月板损伤",
      imagePath: productPath,
      publicUrl: ""
    },
    script: {
      raw,
      source: "historical-product-upload-test",
      importedAt: new Date().toISOString()
    },
    generation: {
      ...(store.getProject(created.id).generation || {}),
      targetDurationSeconds: 360,
      shotDuration: 10,
      mode: "storyboard_sheet",
      modeConfirmed: true,
      engine: "hailuo-h3",
      videoProviderKind: "puream-hailuo-h3",
      aspectRatio: "9:16"
    }
  });

  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: LIVE_ROOT,
    textGenerator: async () => {
      throw Object.assign(new Error("local-first parse"), { code: "TEXT_PROVIDER_DISABLED" });
    }
  });

  const started = Date.now();
  await workflow.analyzeScript(created.id);
  const project = store.getProject(created.id);
  const parsed = snapshot(project);
  const checks = judge(parsed);
  const report = {
    at: new Date().toISOString(),
    projectId: created.id,
    format,
    durationEstimate: duration,
    structuredPreview: {
      characters: (structured.characters || []).map(item => item.name || item.id),
      scenes: (structured.scenes || []).map(item => item.name || item.id),
      shots: (structured.shots || []).length
    },
    elapsedMs: Date.now() - started,
    parsed,
    checks,
    ok: checks.secondsOk
      && checks.shotCountOk
      && checks.missingCharacters.length === 0
      && checks.missingScenes.length === 0
      && checks.missingProps.length === 0
      && checks.missingWardrobes.length === 0
      && checks.productBound
      && checks.productAfterReversal
      && checks.s01CharactersOk
      && checks.livingShots.includes("S05")
      && checks.clinicShots.includes("S09")
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({ projectId: created.id, workbench: LIVE_ROOT })}\n`);
  if (!report.ok) process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
