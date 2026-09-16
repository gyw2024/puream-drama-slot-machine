"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkbenchStore } = require("../app/workbench-store");

test("projects stranded by the retired product-topic guard reopen as directly continuable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drama-product-context-recovery-"));
  try {
    const store = new WorkbenchStore(root);
    const created = store.createProject("历史失败项目", {
      inputMode: "ai",
      scriptFormat: "production",
      scriptFormatConfirmed: true,
      commerceMode: "natural",
      mode: "storyboard_sheet",
      modeConfirmed: true
    });
    created.product = {
      name: "护眼台灯",
      sellingPoints: "柔光；定时关闭",
      description: "柔光；定时关闭",
      imagePath: __filename,
      publicUrl: ""
    };
    created.ideation = {
      ...(created.ideation || {}),
      status: "failed",
      errorCode: "TOPIC_PRODUCT_CONTEXT_STALE",
      message: "商品资料在选题生成后发生了变化，请重新生成一轮适配当前商品的选题",
      selectedTopicId: "topic-1",
      topics: [{ id: "topic-1", title: "灯亮以后", productPlacement: "旧商品节点" }],
      topicProductContext: { commerceMode: "natural", name: "旧商品", sellingPoints: "旧卖点", imagePath: "D:/old.png" }
    };
    created.automation = {
      ...(created.automation || {}),
      status: "failed",
      operation: "idea_script",
      stage: "script",
      message: created.ideation.message,
      errorCode: "TOPIC_PRODUCT_CONTEXT_STALE",
      recoverableFailure: false
    };
    store.saveProject(created);

    const reopened = store.getProject(created.id);
    assert.equal(reopened.ideation.status, "topic_selected");
    assert.equal(reopened.ideation.errorCode, "");
    assert.match(reopened.ideation.message, /自动同步.*无需重新抽题/);
    assert.equal(reopened.automation.status, "idle");
    assert.equal(reopened.automation.errorCode, "");
    assert.equal(reopened.ideation.topics[0].id, "topic-1");
    assert.equal(reopened.product.name, "护眼台灯");

    store.saveProject(reopened);
    const persisted = new WorkbenchStore(root).getProject(created.id);
    assert.equal(persisted.ideation.status, "topic_selected");
    assert.equal(persisted.automation.status, "idle");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

