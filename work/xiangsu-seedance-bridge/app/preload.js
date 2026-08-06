"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("seedance", {
  health: () => ipcRenderer.invoke("bridge:health"),
  diagnostics: () => ipcRenderer.invoke("bridge:diagnostics"),
  startBridge: () => ipcRenderer.invoke("bridge:start"),
  chooseImage: () => ipcRenderer.invoke("file:choose-image"),
  chooseOutput: () => ipcRenderer.invoke("file:choose-output"),
  submit: payload => ipcRenderer.invoke("video:submit", payload),
  query: taskId => ipcRenderer.invoke("video:query", taskId),
  reveal: targetPath => ipcRenderer.invoke("file:reveal", targetPath)
});
