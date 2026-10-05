// 演练：迁移补编号、操作记账、多标签页合并冲突、快照失效、检查点恢复、幂等重试
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const LEDGER_KEY = "wxyy-2-thin-section-index:ledger";
const CHECKPOINT_KEY = "wxyy-2-thin-section-index:checkpoint";
const LEGACY_KEY = "wxyy-2-thin-section-index";

function createElement(selector) {
  const el = {
    selector,
    innerHTML: "",
    hidden: false,
    value: "",
    textContent: "",
    files: [],
    dataset: {},
    listeners: {},
    fields: {},
    scrollIntoView() {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    async emit(type, event = {}) {
      for (const fn of this.listeners[type] || []) await fn({ target: this, ...event });
    },
    querySelector() {
      return this._submit || (this._submit = createElement("submit"));
    },
    reset() {
      this.fields = {};
      this.value = "";
    }
  };
  for (const name of ["code", "location", "magnification", "polarization", "minerals", "texture", "comment"]) {
    Object.defineProperty(el, name, {
      get() {
        return { value: this.fields[name] ?? "" };
      },
      set(v) {
        this.fields[name] = typeof v === "object" && v !== null && "value" in v ? v.value : v;
      },
      configurable: true
    });
  }
  return el;
}

function runApp(seed, sharedStore) {
  const store = sharedStore || new Map(seed ? Object.entries(seed) : []);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k)
  };
  const sessionStore = new Map();
  const sessionStorage = {
    getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
    setItem: (k, v) => void sessionStore.set(k, String(v))
  };

  const elements = {};
  const query = (sel) => (elements[sel] ||= createElement(sel));
  const windowListeners = {};
  const sandbox = {
    console,
    crypto: require("crypto").webcrypto,
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    localStorage,
    sessionStorage,
    document: {
      querySelector: query,
      createElement: () => ({ click() {}, href: "", download: "" })
    },
    window: {
      addEventListener(type, fn) {
        (windowListeners[type] ||= []).push(fn);
      }
    },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: {
      createObjectURL: () => "blob:fake",
      revokeObjectURL: () => {}
    },
    FileReader: class {},
    FormData: class {
      constructor(form) { this.form = form; }
      get(name) { return this.form.fields[name] ?? ""; }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync("/workspace/app.js", "utf8"), sandbox);
  return {
    store,
    elements,
    async submitForm(fields) {
      const form = elements["#sampleForm"];
      form.fields = { ...fields };
      await form.emit("submit", { preventDefault() {} });
    },
    async click(selector, target) {
      await elements[selector].emit("click", { target: target || elements[selector] });
    },
    async storage(newValue) {
      for (const fn of windowListeners.storage || []) fn({ key: LEDGER_KEY, newValue });
    },
    ledger() {
      try {
        return JSON.parse(store.get(LEDGER_KEY));
      } catch {
        return [];
      }
    },
    checkpoint() {
      return JSON.parse(store.get(CHECKPOINT_KEY));
    },
    exportData() {
      const exportBtn = elements["#exportBtn"];
      let blob = null;
      const orig = sandbox.Blob;
      sandbox.Blob = class { constructor(parts) { blob = parts[0]; } };
      exportBtn.listeners.click[0]();
      sandbox.Blob = orig;
      return JSON.parse(blob);
    }
  };
}

(async () => {
  // 1. 旧记录首次打开：补编号，照片/批注/样本原样保留
  const legacy = {
    samples: [
      { id: "s1", code: "BX-17-03", photo: "data:photo1", location: "剖面东侧", magnification: "40x", polarization: "单偏光", minerals: "石英、斜长石", texture: "半自形", comment: "批注甲" },
      { id: "s2", code: "BX-17-04", photo: "data:photo2", location: "剖面西侧", magnification: "100x", polarization: "正交偏光", minerals: "黑云母", texture: "碎裂", comment: "批注乙" }
    ],
    compare: ["s1"]
  };
  let app = runApp({ [LEGACY_KEY]: JSON.stringify(legacy) });
  assert.ok(!app.store.has(LEGACY_KEY), "旧格式应迁移走");
  let ledger = app.ledger();
  assert.strictEqual(ledger.length, 3, "两条样本 + 一条对比 = 3 条带编号操作");
  assert.ok(ledger.every((op) => Number.isInteger(op.seq) && op.seq >= 1), "每条操作都有编号");
  assert.strictEqual(ledger[0].payload.code, "BX-17-03", "样本信息保留");
  assert.strictEqual(ledger[0].payload.photo, "data:photo1", "照片保留");
  assert.strictEqual(ledger[0].payload.comment, "批注甲", "批注保留");
  assert.ok(app.elements["#sampleGrid"].innerHTML.includes("BX-17-03"), "样本继续渲染");
  assert.ok(app.elements["#comparePane"].innerHTML.includes("BX-17-03"), "对比继续可用");
  console.log("1. 迁移补编号 ✓");

  // 2. 新操作追加编号，序号单调
  await app.submitForm({ code: "BX-17-05", minerals: "石榴石", polarization: "单偏光" });
  ledger = app.ledger();
  assert.strictEqual(ledger.length, 4);
  assert.strictEqual(ledger[3].seq, 4, "迁移后序号接着编");
  assert.strictEqual(ledger[3].type, "sample/add");
  console.log("2. 操作记账 ✓");

  // 3. 快照随样本信息失效重算
  const before = app.exportData();
  assert.strictEqual(before.length, 3);
  // 编辑样本 s1
  const grid = app.elements["#sampleGrid"];
  await grid.emit("click", { target: { dataset: { edit: "s1" } } });
  const form = app.elements["#sampleForm"];
  form.fields = { code: "BX-17-03", minerals: "石英、斜长石、钾长石", polarization: "单偏光" };
  await form.emit("submit", { preventDefault() {} });
  const after = app.exportData();
  assert.strictEqual(after.find((s) => s.样本编号 === "BX-17-03").主要矿物, "石英、斜长石、钾长石", "样本信息一变，导出快照重算");
  console.log("3. 快照失效重算 ✓");

  // 4. 写满 5 条触发检查点
  for (let i = 0; i < 5; i++) {
    await app.submitForm({ code: "BX-CP-" + i, minerals: "方解石", polarization: "单偏光" });
  }
  assert.ok(app.checkpoint(), "应有检查点");
  assert.strictEqual(app.checkpoint().state.samples.length, 6);
  console.log("4. 检查点生成 ✓");

  // 5. 账本写坏：从最近检查点恢复
  app.store.set(LEDGER_KEY, '[{"id":"broken","client":"x","seq":1,"vv":{"x":1},"type":"sample/add","payload":{');
  const app2 = runApp(null, app.store); // 重新打开页面（同一存储）
  assert.strictEqual(app2.ledger().length, 0, "损坏尾部丢弃");
  assert.strictEqual(app2.checkpoint().state.samples.length, 6, "从检查点恢复全部样本");
  assert.ok(app2.elements["#sampleGrid"].innerHTML.includes("BX-17-03"), "照片批注仍在");
  console.log("5. 损坏恢复 ✓");

  // 6. 写入失败：从检查点恢复，重试沿用首次结果（不重复记账）
  const beforeCount = app2.ledger().length;
  await app2.click("#statusBar", { id: "simFail", dataset: {} });
  assert.strictEqual(app2.ledger().length, beforeCount, "失败操作未入账");
  assert.ok(!app2.elements["#retryBanner"].hidden, "显示重试横幅");
  await app2.click("#retryBtn");
  assert.strictEqual(app2.ledger().length, beforeCount + 1, "重试只记一次账（幂等）");
  assert.ok(app2.elements["#retryBanner"].hidden, "重试后横幅消失");
  console.log("6. 写入失败重试幂等 ✓");

  // 7. 多标签页合并：同字段双方都改过 → 两版待确认
  const app3 = runApp({ [LEGACY_KEY]: JSON.stringify(legacy) });
  await app3.click("#statusBar", { id: "simRemote", dataset: {} });
  assert.strictEqual(app3.ledger().length, 4, "远程操作并入");
  assert.ok(!app3.elements["#conflictPane"].hidden, "冲突横幅出现");
  assert.ok(app3.elements["#conflictPane"].innerHTML.includes("远程标签页改的矿物"), "对方版本可见");
  assert.ok(app3.elements["#conflictPane"].innerHTML.includes("石英、斜长石"), "我方版本可见");
  console.log("7. 合并冲突各留一版 ✓");

  // 8. 确认采用一版 → 冲突消解
  const conflictBtn = app3.elements["#conflictPane"];
  const resolveBtn = {
    dataset: { resolve: conflictBtn.innerHTML.match(/data-resolve="([^"]+)"/)[1], op: conflictBtn.innerHTML.match(/data-op="([^"]+)"/)[1] },
    closest: () => resolveBtn
  };
  await conflictBtn.emit("click", { target: resolveBtn });
  assert.ok(app3.elements["#conflictPane"].hidden, "确认后冲突消失");
  assert.ok(app3.elements["#sampleGrid"].innerHTML.includes("石英、斜长石"), "采用的版本生效");
  console.log("8. 冲突确认消解 ✓");

  // 9. 真实 storage 事件路径：另一个标签页的操作经事件并入
  const app4 = runApp({ [LEGACY_KEY]: JSON.stringify(legacy) });
  const remoteOp = {
    id: crypto.randomUUID(),
    client: "other-tab",
    seq: 1,
    vv: { "other-tab": 1 },
    type: "sample/update",
    payload: { id: "s1", changes: { minerals: "对方标签页改的矿物" } },
    ts: new Date().toISOString()
  };
  await app4.storage(JSON.stringify([...app4.ledger(), remoteOp]));
  assert.strictEqual(app4.ledger().length, 4, "storage 事件操作并入账本");
  assert.ok(!app4.elements["#conflictPane"].hidden, "storage 事件触发冲突待确认");
  assert.ok(app4.elements["#conflictPane"].innerHTML.includes("对方标签页改的矿物"), "对方版本可见");
  console.log("9. storage 事件合并 ✓");

  console.log("\n全部通过 ✔");
})().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
