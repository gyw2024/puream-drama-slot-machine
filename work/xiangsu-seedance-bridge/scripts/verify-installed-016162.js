"use strict";

const asar = require("@electron/asar");

const archivePath = process.argv[2];
if (!archivePath) throw new Error("app.asar path is required");
const mainSource = asar.extractFile(archivePath, "app/main.js").toString("utf8");
const packageJson = JSON.parse(asar.extractFile(archivePath, "package.json").toString("utf8"));
process.stdout.write(`${JSON.stringify({
  version: packageJson.version,
  durationRuleMin10: /recommendedMinDuration:\s*10/.test(mainSource),
  durationContractMin10: /durationMin/.test(mainSource)
}, null, 2)}\n`);
