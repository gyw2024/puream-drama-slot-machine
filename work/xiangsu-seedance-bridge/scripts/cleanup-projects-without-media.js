"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");

const root = path.resolve(process.argv[2] || "");
if (!root || !fs.existsSync(path.join(root, "projects.json"))) throw new Error("valid workbench root is required");

function isRealMedia(filePath) {
  let fd;
  try {
    const size = fs.statSync(filePath).size;
    if (size < 12) return false;
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
      || (head[0] === 0xff && head[1] === 0xd8)
      || head.subarray(0, 4).toString("ascii") === "RIFF"
      || head.subarray(4, 8).toString("ascii") === "ftyp"
      || head.subarray(0, 4).toString("hex") === "1a45dfa3";
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function projectHasMedia(projectDir) {
  if (!fs.existsSync(projectDir)) return false;
  const pending = [projectDir];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && isRealMedia(candidate)) return true;
    }
  }
  return false;
}

const store = new WorkbenchStore(root);
const index = store.readIndex();
const targets = index.projects.filter(project => !projectHasMedia(path.join(root, "projects", project.id)));
const deleted = [];
for (const project of targets) {
  if ((project.activeVideoJobs || []).length) continue;
  deleted.push(store.deleteProject(project.id));
}
const report = { executedAt: new Date().toISOString(), root, criterion: "no decodable image or video file anywhere in project directory", deleted, retainedCount: store.readIndex().projects.length };
const reportPath = path.join(root, `empty-project-cleanup-${Date.now()}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, deletedCount: deleted.length, retainedCount: report.retainedCount, recoverable: deleted.every(item => item.recoverable) }, null, 2));
