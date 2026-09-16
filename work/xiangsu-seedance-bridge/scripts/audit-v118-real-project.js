"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const axeSource = require("axe-core").source;
const { _electron: electron } = require("playwright-core");

const TARGET_PROJECT_ID = process.env.DRAMA_SLOT_REAL_PROJECT_ID || "project_mti9zisf_dfd6e095";
const USER_DATA_DIR = process.env.DRAMA_SLOT_REAL_USER_DATA
  || path.join(process.env.APPDATA || "", "xiangsu-seedance-bridge");
const WORKBENCH_ROOT = process.env.DRAMA_SLOT_REAL_WORKBENCH
  || path.join(USER_DATA_DIR, "workbench");
const EXECUTABLE_PATH = process.env.DRAMA_SLOT_INSTALLED_EXE
  || path.join(process.env.LOCALAPPDATA || "", "Programs", "xiangsu-seedance-bridge", "纯梦短剧老虎机.exe");
const EVIDENCE_ROOT = process.env.DRAMA_SLOT_REAL_AUDIT_EVIDENCE
  || path.resolve(__dirname, "..", "..", "..", ".codex_tests", "TASK-20260901-DRAMA-ASSET-VOICE-LIBRARY-013", "real-project-ui");

function safeName(value) {
  return String(value || "run").replace(/[:.]/g, "-");
}

async function setWindowBounds(electronApp, width, height) {
  await electronApp.evaluate(({ BrowserWindow }, bounds) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setBounds({ x: -32000, y: -32000, width: bounds.width, height: bounds.height });
    win.showInactive();
  }, { width, height });
}

async function selectRealProject(page) {
  await page.waitForFunction(projectId => {
    const select = document.querySelector("#projectSelect");
    return Boolean(select && [...select.options].some(option => option.value === projectId));
  }, TARGET_PROJECT_ID, { timeout: 30_000 });
  await page.evaluate(projectId => {
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    const select = document.querySelector("#projectSelect");
    if (select.value !== projectId) {
      select.value = projectId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, TARGET_PROJECT_ID);
  await page.waitForFunction(projectId => document.querySelector("#projectSelect")?.value === projectId, TARGET_PROJECT_ID);
  await page.waitForTimeout(500);
}

async function collectProjectContract(page) {
  return page.evaluate(async projectId => {
    const api = window.dramaSlot.workbench;
    const projectResult = await api.getProject(projectId);
    const voicesResult = await api.listVoiceLibrary();
    if (!projectResult?.ok) throw new Error(projectResult?.message || "project load failed");
    if (!voicesResult?.ok) throw new Error(voicesResult?.message || "voice library load failed");
    const project = projectResult.project;
    const characters = project.characters || [];
    const props = project.assetLibraries?.props || project.props || [];
    const voices = voicesResult.voices || [];
    return {
      projectId: project.id,
      contractVersion: project.assetMetadataContractVersion,
      assetCharacters: characters.filter(item => item.assetRequired === true).map(item => ({
        id: item.id,
        name: item.name,
        gender: item.gender,
        ageBand: item.ageBand,
        castingTier: item.castingTier,
        appearanceDescription: item.appearanceDescription,
        reason: item.assetDecision?.reason || ""
      })),
      skippedCharacters: characters.filter(item => item.assetRequired !== true).map(item => ({
        id: item.id,
        name: item.name,
        castingTier: item.castingTier,
        reason: item.assetDecision?.reason || "",
        appearanceDescription: item.appearanceDescription || ""
      })),
      coreProps: props.filter(item => item.assetRequired === true).map(item => item.name),
      skippedProps: props.filter(item => item.assetRequired !== true).map(item => item.name),
      productName: project.product?.name || project.productName || "",
      activeExcludedCandidateIds: (project.candidates || []).filter(candidate => {
        if (candidate.selected !== true || candidate.stale === true || candidate.entityType !== "character") return false;
        const character = characters.find(item => item.id === candidate.entityId);
        return candidate.stage === "character_voice"
          ? character?.voiceAssetRequired === false
          : character?.visualAssetRequired === false;
      }).map(item => item.id),
      deactivatedLegacyBindings: (project.candidates || []).filter(item => item.assetPolicyExcluded === true).map(item => ({
        id: item.id,
        entityId: item.entityId,
        stage: item.stage,
        selected: item.selected,
        stale: item.stale,
        reusableAssetId: item.reusableAssetId || ""
      })),
      skippedCharacterVoiceBindings: characters.filter(item => item.assetRequired !== true).map(item => ({
        id: item.id,
        voiceLibraryId: item.voiceLibraryId || ""
      })),
      voiceSummary: {
        total: voices.length,
        builtIn: voices.filter(item => item.builtIn === true).length,
        verified: voices.filter(item => item.profileVerified === true).length,
        male: voices.filter(item => item.gender === "male").length,
        female: voices.filter(item => item.gender === "female").length,
        youth: voices.filter(item => ["youth", "青年", "少年"].includes(item.ageBand)).length,
        middle: voices.filter(item => ["middle", "中年"].includes(item.ageBand)).length,
        senior: voices.filter(item => ["senior", "老年"].includes(item.ageBand)).length
      },
      repairedVoices: voices.filter(item => ["王老师", "苏晚晴"].some(label => String(item.label || item.characterName || "").includes(label))).map(item => ({
        label: item.label || item.characterName,
        gender: item.gender,
        ageBand: item.ageBand,
        profileVerified: item.profileVerified,
        medianF0Hz: item.acousticProfile?.medianF0Hz || item.profileAudit?.medianF0Hz || 0
      }))
    };
  }, TARGET_PROJECT_ID);
}

async function collectAssetsUi(page, electronApp, runDir) {
  await page.evaluate(() => {
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    document.querySelector('.stage-button[data-stage="assets"]')?.click();
  });
  await page.waitForFunction(() => document.querySelector('[data-panel="assets"]')?.classList.contains("active") === true);
  await page.waitForFunction(() => document.querySelectorAll("#characterGrid .asset-card").length > 0);
  await page.evaluate(axeSource);
  const sizes = [[1024, 720], [1280, 800], [1440, 900], [1920, 1080]];
  const breakpoints = [];
  for (const [width, height] of sizes) {
    await setWindowBounds(electronApp, width, height);
    await page.waitForTimeout(120);
    const result = await page.evaluate(async () => {
      const panel = document.querySelector('[data-panel="assets"]');
      const axe = await window.axe.run(panel, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
      return {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        characterCards: document.querySelectorAll("#characterGrid .asset-card").length,
        skippedCharacters: document.querySelector("#characterGrid .asset-skip-summary summary")?.textContent?.trim() || "",
        propCards: document.querySelectorAll("#propGrid .asset-card").length,
        skippedProps: document.querySelector("#propGrid .asset-skip-summary summary")?.textContent?.trim() || "",
        seriousAxe: axe.violations.filter(item => ["critical", "serious"].includes(item.impact)).map(item => item.id),
        cardWidths: [...document.querySelectorAll("#characterGrid .asset-card")].map(item => Math.round(item.getBoundingClientRect().width)).slice(0, 8)
      };
    });
    breakpoints.push(result);
    if (width === 1440) await page.screenshot({ path: path.join(runDir, "real-assets-1440x900.png") });
  }
  return breakpoints;
}

async function collectLibraryUi(page, electronApp, runDir) {
  await setWindowBounds(electronApp, 1440, 900);
  await page.evaluate(() => document.querySelector('.library-nav-button[data-library="characters"]')?.click());
  await page.waitForFunction(() => document.querySelector("#reusableAssetDialog")?.open === true);
  const characters = await page.evaluate(async () => {
    const dialog = document.querySelector("#reusableAssetDialog");
    const axe = await window.axe.run(dialog, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return {
      filterFields: [...dialog.querySelectorAll("[data-reusable-asset-filter]")].map(item => item.dataset.reusableAssetFilter),
      text: dialog.innerText,
      seriousAxe: axe.violations.filter(item => ["critical", "serious"].includes(item.impact)).map(item => item.id)
    };
  });
  await page.screenshot({ path: path.join(runDir, "real-character-library-1440x900.png") });
  await page.evaluate(() => {
    document.querySelector("#reusableAssetDialog")?.close();
    document.querySelector('.library-nav-button[data-library="voices"]')?.click();
  });
  await page.waitForTimeout(350);
  const initialVoiceCardCount = await page.locator("#voiceLibraryGrid .asset-card").count();
  while (await page.locator('[data-action="show-more-voices"]').count()) {
    await page.locator('[data-action="show-more-voices"]').click();
    await page.waitForTimeout(50);
  }
  const voices = await page.evaluate(() => ({
    countText: document.querySelector("#voiceLibraryCount")?.textContent?.trim() || "",
    cardCount: document.querySelectorAll("#voiceLibraryGrid .asset-card").length,
    builtInLabels: [...document.querySelectorAll("#voiceLibraryGrid .asset-card")].filter(item => item.innerText.includes("内置音色")).length,
    systemProtected: [...document.querySelectorAll("#voiceLibraryGrid .asset-card")].filter(item => item.innerText.includes("系统保护")).length,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }));
  voices.initialCardCount = initialVoiceCardCount;
  await page.screenshot({ path: path.join(runDir, "real-voice-library-1440x900.png") });
  return { characters, voices };
}

function validateContract(contract, assetsUi, libraryUi) {
  assert.equal(contract.projectId, TARGET_PROJECT_ID);
  assert.equal(contract.contractVersion, 5);
  assert.deepEqual(contract.assetCharacters.map(item => item.id), ["C01", "C02", "C03", "C04", "C05", "C06", "C08", "C10"]);
  assert.equal(contract.skippedCharacters.length, 11);
  assert.equal(contract.skippedCharacters.find(item => item.id === "C09")?.appearanceDescription, "");
  assert.deepEqual(contract.coreProps, ["婚戒", "发黄的旧舞会卡", "审计文件", "离婚协议"]);
  assert.match(contract.productName, /九宝茶/);
  assert.deepEqual(contract.activeExcludedCandidateIds, []);
  assert.ok(contract.deactivatedLegacyBindings.some(item => item.entityId === "C07" && item.selected === false && item.stale === true && !item.reusableAssetId));
  assert.ok(contract.deactivatedLegacyBindings.some(item => item.entityId === "C09" && item.stage === "character_voice" && item.selected === false && item.stale === true));
  assert.equal(contract.skippedCharacterVoiceBindings.some(item => item.voiceLibraryId), false);
  assert.equal(contract.assetCharacters.some(item => /[“”]|主席通道已经打开|跪求/.test(item.appearanceDescription)), false, "appearance descriptions must not contain dialogue");
  assert.equal(contract.assetCharacters.some(item => !item.gender || !item.ageBand || !item.castingTier || !item.appearanceDescription), false, "asset characters require complete metadata");
  assert.equal(contract.voiceSummary.builtIn, 40);
  assert.ok(contract.voiceSummary.total >= 40);
  assert.ok(contract.voiceSummary.male >= 16);
  assert.ok(contract.voiceSummary.female >= 24);
  assert.ok(contract.voiceSummary.youth >= 13);
  assert.ok(contract.voiceSummary.middle >= 18);
  assert.ok(contract.voiceSummary.senior >= 9);
  assert.ok(contract.repairedVoices.some(item => String(item.label).includes("王老师") && item.gender === "male" && item.profileVerified === true));
  assert.ok(contract.repairedVoices.some(item => String(item.label).includes("苏晚晴") && item.gender === "female" && item.profileVerified === true));
  assert.equal(assetsUi.some(item => item.horizontalOverflow), false);
  assert.equal(assetsUi.some(item => item.characterCards !== 8 || item.propCards !== 4), false);
  assert.equal(assetsUi.some(item => item.seriousAxe.length), false);
  assert.deepEqual(new Set(libraryUi.characters.filterFields), new Set(["kind", "gender", "ageBand", "castingTier", "query"]));
  assert.equal(libraryUi.characters.seriousAxe.length, 0);
  assert.ok(libraryUi.voices.initialCardCount <= 40);
  assert.equal(libraryUi.voices.cardCount, contract.voiceSummary.total);
  assert.equal(libraryUi.voices.builtInLabels, 40);
  assert.equal(libraryUi.voices.systemProtected, 40);
  assert.equal(libraryUi.voices.horizontalOverflow, false);
}

async function main() {
  if (!fs.existsSync(EXECUTABLE_PATH)) throw new Error(`installed executable missing: ${EXECUTABLE_PATH}`);
  const runDir = path.join(EVIDENCE_ROOT, safeName(new Date().toISOString()));
  fs.mkdirSync(runDir, { recursive: true });
  const electronApp = await electron.launch({
    executablePath: EXECUTABLE_PATH,
    args: [`--user-data-dir=${USER_DATA_DIR}`],
    env: { ...process.env, DRAMA_SLOT_DATA_ROOT: WORKBENCH_ROOT }
  });
  try {
    const page = await electronApp.firstWindow({ timeout: 20_000 });
    await setWindowBounds(electronApp, 1440, 900);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.dataset.workbenchReady === "true", null, { timeout: 30_000 });
    await selectRealProject(page);
    const contract = await collectProjectContract(page);
    const assetsUi = await collectAssetsUi(page, electronApp, runDir);
    const libraryUi = await collectLibraryUi(page, electronApp, runDir);
    validateContract(contract, assetsUi, libraryUi);
    const result = { ok: true, executablePath: EXECUTABLE_PATH, runDir, contract, assetsUi, libraryUi };
    fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await electronApp.close().catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
