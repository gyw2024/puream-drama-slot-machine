"use strict";

const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { BridgeClient } = require("./bridge-client");

const bridge = new BridgeClient();
let mainWindow;

function publicError(error) {
  return {
    ok: false,
    code: error?.code || "UNEXPECTED_ERROR",
    message: error?.message || "发生未知错误"
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#0b0d12",
    title: "Seedance Mini 生成器",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("bridge:health", () => bridge.health());
ipcMain.handle("bridge:diagnostics", async () => {
  try {
    return await bridge.diagnostics();
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("bridge:start", async () => {
  try {
    const launch = bridge.launchXiangsuBridge();
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const health = await bridge.health();
      if (health.ok) return { ...health, launched: true };
    }
    return {
      ok: false,
      code: "BRIDGE_START_TIMEOUT",
      message: "像塑已启动，但后台桥尚未就绪。请确认桥接插件已安装，并重启像塑一次。",
      executable: launch.executable
    };
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("file:choose-image", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择参考图片",
    properties: ["openFile"],
    filters: [
      { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("file:choose-output", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择视频保存目录",
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("video:submit", async (_event, payload) => {
  try {
    return await bridge.submit(payload);
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("video:query", async (_event, taskId) => {
  try {
    return await bridge.query(taskId);
  } catch (error) {
    return publicError(error);
  }
});
ipcMain.handle("file:reveal", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || !targetPath) return false;
  shell.showItemInFolder(targetPath);
  return true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}
