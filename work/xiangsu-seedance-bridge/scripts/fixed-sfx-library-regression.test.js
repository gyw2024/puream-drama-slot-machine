"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { locateFfmpeg } = require("../app/locate-ffmpeg");
const {
  BUILTIN_SFX_CATALOG,
  buildFixedSfxPlan,
  catalogWithFiles,
  validateBuiltinSfxCatalog,
  validateFixedSfxPlan
} = require("../app/fixed-sfx-library");
const {
  detectHeadArtifactTrimSeconds,
  h3ExactStitchFilter,
  mixFixedSfxIntoVideo
} = require("../app/workbench-workflow");

const ffmpeg = locateFfmpeg({ ffmpegPath: process.env.FFMPEG_PATH });

test("fixed library contains exactly 150 packaged and decodable CC0 effects", { timeout: 180_000 }, () => {
  const catalog = catalogWithFiles();
  const audit = validateBuiltinSfxCatalog(catalog, { requireFiles: true });
  assert.equal(BUILTIN_SFX_CATALOG.length, 150);
  assert.equal(audit.ok, true, audit.failures.join("\n"));
  assert.equal(new Set(catalog.map(item => item.id)).size, 150);
  assert.equal(new Set(catalog.map(item => item.filePath)).size, 150);
  assert.ok(ffmpeg, "ffmpeg is required for packaged SFX decode audit");
  for (const item of catalog) {
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", item.filePath, "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], {
      windowsHide: true,
      timeout: 15_000,
      stdio: "pipe"
    });
  }
});

test("agent selects explainable environment, action, comedy, emphasis and product cues", () => {
  const catalog = catalogWithFiles();
  const project = {
    id: "sfx-plan-regression",
    scenes: [
      { id: "room", name: "室内董事会会议厅", description: "室内安静会场" },
      { id: "street", name: "暴雨街道", description: "雨夜道路" }
    ],
    shots: [
      { id: "S01", number: 1, sceneId: "room", duration: 12, title: "身份揭晓", action: "董事长走进会场，全场震惊，真相揭晓" },
      { id: "S02", number: 2, sceneId: "room", duration: 10, title: "荒唐反应", action: "反派翻车，众人尴尬又搞笑" },
      { id: "S03", number: 3, sceneId: "street", duration: 11, title: "雨中冲突", action: "她走近后狠狠扇了对方一耳光" },
      { id: "S04", number: 4, sceneId: "room", duration: 13, title: "产品介绍", action: "主角手持产品打开包装，讲清价格并引导点击左下角头像进入橱窗购买" }
    ]
  };
  const plan = buildFixedSfxPlan(project, { catalog });
  const audit = validateFixedSfxPlan(plan, catalog, { requireFiles: true });
  assert.equal(plan.generatedAudio, false);
  assert.equal(plan.catalogSize, 150);
  assert.equal(plan.shots.length, 4);
  assert.equal(audit.ok, true, audit.failures.join("\n"));
  assert.ok(plan.cueCount >= 7, `expected broad semantic matches, got ${plan.cueCount}`);
  assert.ok(plan.shots.some(shot => shot.cues.some(cue => cue.role === "ambience")));
  assert.ok(plan.shots.flatMap(shot => shot.cues).every(cue => cue.localTimeSeconds >= 0.25 && cue.reason));
  assert.ok(plan.shots.every(shot => shot.cues.length <= 3));
  const categories = new Set(plan.shots.flatMap(shot => shot.cues).map(cue => catalog.find(item => item.id === cue.effectId)?.category));
  for (const expected of ["environment", "action", "comedy", "emphasis", "technology"]) assert.ok(categories.has(expected), `missing ${expected}`);
});

test("rough-cut UI exposes the 150-effect Agent workflow instead of the retired stitch-only action", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app", "renderer", "workbench.js"), "utf8");
  assert.match(html, /智能粗剪与剪映草稿/);
  assert.match(html, /150种固定音效/);
  assert.match(html, /仅写入剪映独立音轨，不叠加进粗剪视频/);
  assert.match(renderer, /无叠加音效粗剪/);
  assert.match(renderer, /已规划 \$\{roughCutCueCount\} 个固定音效，仅写入剪映独立音轨/);
  assert.match(renderer, /片头裁剪/);
  assert.doesNotMatch(html, />只拼接成片</);
});

test("rough cut trims a safe head artifact and mixes a packaged fixed effect", { timeout: 180_000 }, async t => {
  assert.ok(ffmpeg, "ffmpeg is required for rough-cut integration audit");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "puream-fixed-sfx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.mp4");
  const intentionalSilence = path.join(dir, "intentional-silence.mp4");
  const mixed = path.join(dir, "mixed.mp4");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=360x640:r=24:d=3",
    "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,0.045)\\,0.8*sin(2*PI*1400*t)\\,if(lt(t\\,0.24)\\,0\\,0.15*sin(2*PI*440*t))):s=48000:d=3",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source
  ], { windowsHide: true, timeout: 120_000, stdio: "pipe" });
  const trim = await detectHeadArtifactTrimSeconds(ffmpeg, source, 3);
  assert.ok(trim >= 0.20 && trim <= 0.35, `unexpected trim ${trim}`);
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=360x640:r=24:d=3",
    "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,0.3)\\,0\\,0.15*sin(2*PI*440*t)):s=48000:d=3",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", intentionalSilence
  ], { windowsHide: true, timeout: 120_000, stdio: "pipe" });
  assert.equal(await detectHeadArtifactTrimSeconds(ffmpeg, intentionalSilence, 3), 0, "intentional silent acting must remain intact");
  const filter = h3ExactStitchFilter([{ duration: 2.7, trimStartSeconds: trim, hasAudio: true }], 2.7, 24);
  assert.match(filter, /trim=start=/);
  assert.match(filter, /atrim=start=/);
  const catalog = catalogWithFiles();
  const effect = catalog.find(item => item.category === "emphasis");
  const plan = {
    shots: [{ cues: [{ effectId: effect.id, role: "accent", programmeTimeSeconds: 0.6, durationSeconds: 0, loop: false, gainDb: -18, fadeInSeconds: 0.01, fadeOutSeconds: 0.06 }] }]
  };
  const result = await mixFixedSfxIntoVideo(ffmpeg, source, mixed, plan, catalog, dir);
  assert.equal(result.applied, true);
  assert.equal(result.cueCount, 1);
  assert.ok(fs.statSync(mixed).size > 0);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", mixed, "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"], {
    windowsHide: true,
    timeout: 120_000,
    stdio: "pipe"
  });
});
