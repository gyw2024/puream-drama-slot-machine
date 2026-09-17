"use strict";
// Diagnostic: why does every draw click fall back to the prompt-review gate?
const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchWorkflow, promptReviewSourceFingerprint, promptReviewSettingsFingerprint } = require("D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app/workbench-workflow.js");

const DATA = process.argv[2] || "C:/Users/Administrator/AppData/Roaming/xiangsu-seedance-bridge/workbench";
const PROJECT_ID = process.argv[3];
const project = JSON.parse(fs.readFileSync(path.join(DATA, "projects", PROJECT_ID, "project.json"), "utf8"));
const rawSettings = JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf8"));
const settings = rawSettings.settings && typeof rawSettings.settings === "object" ? rawSettings.settings : rawSettings;

const review = project.promptReview || {};
const srcNow = promptReviewSourceFingerprint(project);
const setNow = promptReviewSettingsFingerprint(settings);
console.log("project          :", project.title, PROJECT_ID);
console.log("review.status    :", review.status);
console.log("review.version   :", review.version);
console.log("bundle VERSION   :", require("D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app/workbench-workflow.js").PROMPT_REVIEW_BUNDLE_VERSION);
console.log("revision  project:", project.productionRevision, "| review:", review.productionRevision);
console.log("srcFingerprint   :", review.sourceFingerprint);
console.log("srcNow           :", srcNow, review.sourceFingerprint === srcNow ? "MATCH" : "*** MISMATCH ***");
console.log("setFingerprint   :", review.settingsFingerprint);
console.log("setNow           :", setNow, review.settingsFingerprint === setNow ? "MATCH" : "*** MISMATCH ***");
console.log("items.length     :", (review.items || []).length, "| counts.total:", review.counts?.total);
console.log("resume           :", JSON.stringify(review.resume || {}));
const empty = (review.items || []).filter(i => !String(i?.id || "").trim() || !String(i?.prompt || "").trim() || !String(i?.displayPrompt || "").trim());
console.log("empty-field items:", empty.length);
const badTranslation = (review.items || []).filter(i => i.executionLanguage === "en" && !["translated", "local", "deferred", "structured"].includes(String(i.translationStatus || "")));
console.log("bad translation  :", badTranslation.length, badTranslation.slice(0, 3).map(i => `${i.id}:${i.translationStatus}`));
const pendingCompilation = require("D:/Backup/Documents/无限画布/纯梦短剧老虎机/work/xiangsu-seedance-bridge/app/workbench-workflow.js").hasPendingPromptCompilation(project);
console.log("pendingCompilation:", pendingCompilation);
console.log("stageAgentAudit  :", JSON.stringify(review.stageAgentAudit || {}));
console.log("semanticCompile  :", JSON.stringify(project.h3AssetDirectSemanticCompile || {}));
console.log("assetDesignAuthor:", JSON.stringify(project.assetDesignAuthoring || {}));
console.log("manualDirTrans   :", JSON.stringify(project.manualDirectionTranslation || {}));
