"use strict";

const buttons = [...document.querySelectorAll("[data-mode]")];
const status = document.querySelector("#modeStatus");

async function selectMode(mode) {
  buttons.forEach(button => { button.disabled = true; });
  status.hidden = true;
  try {
    const result = await window.dramaSlot.appMode.select(mode);
    if (!result?.ok) throw new Error(result?.message || "工作模式切换失败");
  } catch (error) {
    status.textContent = error?.message || "工作模式切换失败";
    status.hidden = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

buttons.forEach(button => button.addEventListener("click", () => selectMode(button.dataset.mode)));
document.body.dataset.modeSelectorReady = "true";
