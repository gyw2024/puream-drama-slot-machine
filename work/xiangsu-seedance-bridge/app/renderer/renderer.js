"use strict";

const elements = {
  bridgeBadge: document.querySelector("#bridgeBadge"),
  startBridge: document.querySelector("#startBridge"),
  diagnostics: document.querySelector("#diagnostics"),
  diagnosticOutput: document.querySelector("#diagnosticOutput"),
  prompt: document.querySelector("#prompt"),
  promptCount: document.querySelector("#promptCount"),
  aspectRatio: document.querySelector("#aspectRatio"),
  duration: document.querySelector("#duration"),
  imagePath: document.querySelector("#imagePath"),
  outputDir: document.querySelector("#outputDir"),
  chooseImage: document.querySelector("#chooseImage"),
  chooseOutput: document.querySelector("#chooseOutput"),
  submit: document.querySelector("#submit"),
  emptyState: document.querySelector("#emptyState"),
  taskState: document.querySelector("#taskState"),
  taskId: document.querySelector("#taskId"),
  progressBar: document.querySelector("#progressBar"),
  taskStatus: document.querySelector("#taskStatus"),
  taskMessage: document.querySelector("#taskMessage"),
  resultVideo: document.querySelector("#resultVideo"),
  revealResult: document.querySelector("#revealResult")
};

let bridgeOnline = false;
let resultPath = null;

function setBadge(kind, text) {
  elements.bridgeBadge.className = `badge badge-${kind}`;
  elements.bridgeBadge.querySelector("b").textContent = text;
}

function refreshSubmitState() {
  elements.submit.disabled = !bridgeOnline || !elements.prompt.value.trim();
}

async function refreshHealth() {
  const health = await window.seedance.health();
  bridgeOnline = Boolean(health.ok && health.ready);
  if (bridgeOnline) {
    setBadge("online", health.sessionReady ? "像塑会话已连接" : "桥接在线，待登录");
  } else if (health.ok) {
    setBadge("warning", health.message || "桥接尚未就绪");
  } else {
    setBadge("offline", "像塑后台桥未连接");
  }
  refreshSubmitState();
}

elements.prompt.addEventListener("input", () => {
  elements.promptCount.textContent = String(elements.prompt.value.length);
  refreshSubmitState();
});

elements.chooseImage.addEventListener("click", async () => {
  const selected = await window.seedance.chooseImage();
  if (selected) elements.imagePath.value = selected;
});

elements.chooseOutput.addEventListener("click", async () => {
  const selected = await window.seedance.chooseOutput();
  if (selected) elements.outputDir.value = selected;
});

elements.startBridge.addEventListener("click", async () => {
  elements.startBridge.disabled = true;
  setBadge("warning", "正在启动像塑后台桥");
  const result = await window.seedance.startBridge();
  elements.startBridge.disabled = false;
  if (!result.ok) {
    setBadge("offline", result.message || "启动失败");
  }
  await refreshHealth();
});

elements.diagnostics.addEventListener("click", async () => {
  const result = await window.seedance.diagnostics();
  elements.emptyState.classList.add("hidden");
  elements.taskState.classList.add("hidden");
  elements.diagnosticOutput.classList.remove("hidden");
  elements.diagnosticOutput.textContent = JSON.stringify(result, null, 2);
});

elements.submit.addEventListener("click", async () => {
  elements.submit.disabled = true;
  elements.diagnosticOutput.classList.add("hidden");
  elements.emptyState.classList.add("hidden");
  elements.taskState.classList.remove("hidden");
  elements.taskId.textContent = "等待分配";
  elements.progressBar.style.width = "8%";
  elements.taskStatus.textContent = "正在提交";
  elements.taskMessage.textContent = "正在通过像塑登录态创建 SD 2.0 Mini 任务……";

  const response = await window.seedance.submit({
    prompt: elements.prompt.value.trim(),
    aspectRatio: elements.aspectRatio.value,
    duration: Number(elements.duration.value),
    imagePath: elements.imagePath.value || null,
    outputDir: elements.outputDir.value || null,
    ability: "SD_2.0_MINI"
  });

  if (!response.ok) {
    elements.taskStatus.textContent = "提交失败";
    elements.taskMessage.textContent = response.message || "未知错误";
    refreshSubmitState();
    return;
  }

  elements.taskId.textContent = response.taskId;
  elements.taskStatus.textContent = "生成中";
  elements.taskMessage.textContent = "任务已进入像塑队列，正在等待结果……";
  elements.progressBar.style.width = "20%";
  await pollTask(response.taskId);
});

async function pollTask(taskId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const response = await window.seedance.query(taskId);
    if (!response.ok) {
      elements.taskStatus.textContent = "查询失败";
      elements.taskMessage.textContent = response.message || "无法查询任务状态";
      refreshSubmitState();
      return;
    }
    const progress = Math.max(20, Math.min(95, Number(response.progress) || 20));
    elements.progressBar.style.width = `${progress}%`;
    elements.taskMessage.textContent = response.message || "生成中……";
    if (response.status === "succeeded") {
      resultPath = response.localPath;
      elements.progressBar.style.width = "100%";
      elements.taskStatus.textContent = "生成完成";
      elements.taskMessage.textContent = response.localPath || "视频已保存";
      if (response.fileUrl) {
        elements.resultVideo.src = response.fileUrl;
        elements.resultVideo.classList.remove("hidden");
      }
      elements.revealResult.classList.toggle("hidden", !resultPath);
      refreshSubmitState();
      return;
    }
    if (response.status === "failed") {
      elements.taskStatus.textContent = "生成失败";
      elements.taskMessage.textContent = response.message || "像塑任务失败";
      refreshSubmitState();
      return;
    }
  }
  elements.taskStatus.textContent = "仍在生成";
  elements.taskMessage.textContent = "等待时间较长，可稍后重新打开应用继续查询。";
  refreshSubmitState();
}

elements.revealResult.addEventListener("click", () => {
  if (resultPath) window.seedance.reveal(resultPath);
});

refreshHealth();
setInterval(refreshHealth, 5_000);
