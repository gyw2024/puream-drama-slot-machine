"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { invokeApp } = require("../app/mcp/control-client");

const PROJECT_ID = "project_mszo5yyp_a07d6256";
const REPORT = path.resolve("outputs/topic-evaluation-v352/live-evaluation-project_mszo5yyp_a07d6256-1787120189296.json");

async function main() {
  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const topics = report.rounds.at(-1);
  if (!Array.isArray(topics) || topics.length !== 10) throw new Error("Expected the final upstream batch of 10 topics");
  const project = (await invokeApp("get_project", { project_id: PROJECT_ID })).project;
  const result = await invokeApp("update_project", {
    project_id: PROJECT_ID,
    patch: {
      ideation: {
        ...(project.ideation || {}),
        status: "topic_selected",
        topics,
        selectedTopicId: "TOPIC_01",
        generatedAt: report.generatedAt,
        generationSource: "upstream",
        message: "题材已选定，商品已绑定"
      },
      script: { ...(project.script || {}), ideaSignature: "" }
    }
  });
  process.stdout.write(`${JSON.stringify({
    selectedTopicId: result.project.ideation.selectedTopicId,
    topicCount: result.project.ideation.topics.length,
    selectedTitle: result.project.ideation.topics.find(item => item.id === result.project.ideation.selectedTopicId)?.title
  }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
