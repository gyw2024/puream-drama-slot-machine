"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");
const { WorkbenchWorkflow } = require("../app/workbench-workflow");
const {
  buildCameraTakePlan,
  buildHailuoGenerationBlockPrompt,
  generationBlockTakes
} = require("../app/agent-director");

const LIVE_ROOT = path.join(process.env.APPDATA, "xiangsu-seedance-bridge", "workbench");
const PROJECT_ID = process.env.KNEE_BRACE_PROJECT_ID || "project_msy00pq3_f3fc7fd2";
const OUT_DIR = path.resolve("D:/Backup/Documents/无限画布/outputs/TASK-20260818-KNEE-BRACE-PARSE/video-prompts");

function shotReferences(workflow, project, shot) {
  try {
    return workflow.shotReferences(project, shot, project.generation?.mode || "storyboard_sheet");
  } catch {
    return { images: [], imageRoles: [], audios: [], videos: [] };
  }
}

async function main() {
  const store = new WorkbenchStore(LIVE_ROOT, {
    encode: value => value,
    decode: value => value
  });
  const workflow = new WorkbenchWorkflow({
    store,
    bridge: {},
    locateFfmpeg: () => "",
    stagingRoot: LIVE_ROOT,
    textGenerator: async () => {
      throw Object.assign(new Error("local compile"), { code: "TEXT_PROVIDER_DISABLED" });
    }
  });
  const project = store.getProject(PROJECT_ID);
  const settings = store.getSettings();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = [];
  for (const shot of (project.shots || []).slice().sort((a, b) => a.number - b.number)) {
    let plan = null;
    try {
      plan = await workflow.ensureAgentCameraTakePlan(PROJECT_ID, shot.id, project.generation?.mode || "storyboard_sheet", settings);
    } catch (error) {
      plan = buildCameraTakePlan(project, shot, { mode: project.generation?.mode || "storyboard_sheet" });
    }
    const current = store.getProject(PROJECT_ID);
    const liveShot = (current.shots || []).find(item => item.id === shot.id) || shot;
    const references = shotReferences(workflow, current, liveShot);
    const speakerIds = [...new Set((liveShot.dialogueTurns || []).map(item => item.speakerId).filter(Boolean))];
    references.audios = speakerIds.map((characterId, index) => {
      const character = (current.characters || []).find(item => item.id === characterId);
      return {
        characterId,
        characterName: character?.name || characterId,
        path: `placeholder-voice-${characterId}.wav`,
        duration: 3,
        label: `${character?.name || characterId} 音色参考`
      };
    });
    const blocks = [];
    for (const sourceBlock of plan.generationBlocks || []) {
      const block = { ...sourceBlock, takes: generationBlockTakes(plan, sourceBlock) };
      let prompt = "";
      try {
        prompt = buildHailuoGenerationBlockPrompt(current, liveShot, block, references);
      } catch (error) {
        if (error?.prompt) prompt = error.prompt;
        else throw error;
      }
      blocks.push({
        id: block.id,
        strategy: block.strategy,
        start: block.start,
        end: block.end,
        takeIds: block.takeIds,
        prompt
      });
    }
    const body = [
      `# ${shot.id} ｜ ${shot.duration}秒 ｜ ${shot.sceneName || shot.scene}`,
      "",
      `- 人物：${(shot.characterNames || []).join("、") || "无"}`,
      `- 商品：${shot.productMention ? "出现 硅胶护膝" : "不出现"}`,
      `- 动作：${shot.action || ""}`,
      `- 对白：${shot.dialogue || "无"}`,
      "",
      ...blocks.flatMap(block => [
        `## ${block.id}  ${block.start}-${block.end}s  ${block.strategy}`,
        "",
        "```text",
        block.prompt,
        "```",
        ""
      ])
    ].join("\n");
    const fileName = `${shot.id}-${String(shot.sceneName || "shot").replace(/[\\/:*?"<>|]/g, "")}.md`;
    fs.writeFileSync(path.join(OUT_DIR, fileName), body, "utf8");
    index.push({
      id: shot.id,
      file: fileName,
      scene: shot.sceneName,
      characters: shot.characterNames,
      productMention: Boolean(shot.productMention),
      blocks: blocks.map(item => ({ id: item.id, strategy: item.strategy, start: item.start, end: item.end, chars: item.prompt.length }))
    });
  }
  const allPrompts = index.map(item => {
    const text = fs.readFileSync(path.join(OUT_DIR, item.file), "utf8");
    return text;
  }).join("\n\n---\n\n");
  fs.writeFileSync(path.join(OUT_DIR, "00-全部36镜视频提示词.md"), allPrompts, "utf8");
  fs.writeFileSync(path.join(path.dirname(OUT_DIR), "video-prompt-index.json"), `${JSON.stringify({ projectId: PROJECT_ID, count: index.length, shots: index }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ projectId: PROJECT_ID, shots: index.length, pack: path.join(OUT_DIR, "00-全部36镜视频提示词.md") }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
