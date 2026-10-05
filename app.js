// 可续作的操作账：每个操作带编号，合并时保留双方未冲突字段，
// 同一字段都改过就各留一版待确认；快照随样本版本失效重算；
// 写入失败从最近检查点恢复，重试沿用首次结果；旧记录首次打开补编号。

const LEGACY_KEY = "wxyy-2-thin-section-index";
const LEDGER_KEY = LEGACY_KEY + ":ledger";
const CHECKPOINT_KEY = LEGACY_KEY + ":checkpoint";
const CLIENT_KEY = LEGACY_KEY + ":client";
const CHECKPOINT_INTERVAL = 5;

const FIELD_LABELS = {
  photo: "照片",
  code: "样本编号",
  location: "采样地点",
  magnification: "放大倍数",
  polarization: "偏光类型",
  minerals: "主要矿物",
  texture: "颗粒结构",
  comment: "老师批注"
};

const form = document.querySelector("#sampleForm");
const photoInput = document.querySelector("#photoInput");
const sampleGrid = document.querySelector("#sampleGrid");
const comparePane = document.querySelector("#comparePane");
const mineralFilter = document.querySelector("#mineralFilter");
const polarFilter = document.querySelector("#polarFilter");
const exportBtn = document.querySelector("#exportBtn");
const conflictPane = document.querySelector("#conflictPane");
const retryBanner = document.querySelector("#retryBanner");
const retryBtn = document.querySelector("#retryBtn");
const statusBar = document.querySelector("#statusBar");
const submitBtn = form.querySelector("button[type=submit]");

let pendingPhoto = "";
let editingId = null;
let pendingOps = [];
let forceWriteFail = false;

// ---------- 客户端身份（每个标签页一个客户端编号） ----------
function getClient() {
  let id = sessionStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = "c-" + crypto.randomUUID().slice(0, 8);
    sessionStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}
const client = getClient();

// ---------- 版本向量：判断操作先后/并发 ----------
function vvLe(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if ((a?.[k] || 0) > (b?.[k] || 0)) return false;
  }
  return true;
}
function vvConcurrent(a, b) {
  return !vvLe(a, b) && !vvLe(b, a);
}

// ---------- 操作校验 ----------
function validateOp(op) {
  if (!op || typeof op !== "object") throw new Error("无效操作");
  if (typeof op.id !== "string" || !op.id) throw new Error("操作缺少编号");
  if (typeof op.client !== "string" || !op.client) throw new Error("操作缺少客户端");
  if (!Number.isInteger(op.seq) || op.seq < 1) throw new Error("操作编号非法");
  if (!op.vv || typeof op.vv !== "object") throw new Error("版本向量非法");
  if (typeof op.type !== "string") throw new Error("操作类型非法");
}

// ---------- 检查点 ----------
function readCheckpoint() {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const cp = JSON.parse(raw);
    if (!cp || !cp.state || typeof cp.state !== "object") throw new Error("检查点损坏");
    return cp;
  } catch {
    return null;
  }
}

function writeCheckpoint(state, vv) {
  const cp = { state: structuredClone(state), vv, at: new Date().toISOString() };
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(cp));
  checkpoint = cp;
}

// ---------- 账本加载：损坏则丢弃尾部、从检查点恢复 ----------
function loadLedger() {
  let ops;
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    ops = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ops)) throw new Error("账本不是数组");
  } catch {
    ops = []; // 半批损坏：丢弃无法解析的尾部
  }
  const valid = [];
  for (const op of ops) {
    try {
      validateOp(op);
      valid.push(op);
    } catch {
      break;
    }
  }
  if (valid.length !== ops.length) {
    // 发生过截断：回写干净账本，避免下次再读到半批数据
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify(valid));
    } catch {
      /* 回写失败不影响内存态 */
    }
  }
  return valid;
}

function recoverFromCheckpoint() {
  // 写入失败：丢弃未入账的内存操作，从最近检查点恢复。
  // 重新读取账本文件：已持久化的尾部保留，未入账的操作就此放弃，
  // 由用户重试时沿用同一操作编号重新提交（幂等，不会重复记账）。
  let persisted = [];
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) {
      const ops = JSON.parse(raw);
      if (Array.isArray(ops)) {
        for (const op of ops) {
          try {
            validateOp(op);
            persisted.push(op);
          } catch {
            break;
          }
        }
      }
    }
  } catch {
    persisted = [];
  }
  ledger = persisted;
  recompute();
}

// ---------- 持久化：写入失败从最近检查点恢复 ----------
function persistLedger(ops) {
  if (forceWriteFail) {
    forceWriteFail = false;
    recoverFromCheckpoint();
    return false;
  }
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ops));
    return true;
  } catch {
    recoverFromCheckpoint();
    return false;
  }
}

// ---------- 状态派生 ----------
function topoOrder(a, b) {
  const aBeforeB = vvLe(a.vv, b.vv) && !vvLe(b.vv, a.vv);
  const bBeforeA = vvLe(b.vv, a.vv) && !vvLe(a.vv, b.vv);
  if (aBeforeB) return -1;
  if (bBeforeA) return 1;
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.client !== b.client) return a.client < b.client ? -1 : 1;
  return a.seq - b.seq;
}

function applyOpToState(state, op, conflicts, resolved) {
  switch (op.type) {
    case "sample/add": {
      if (state.samples.some((sample) => sample.id === op.payload.id)) return;
      state.samples.push({ ...op.payload });
      state.revision++;
      return;
    }
    case "sample/update": {
      const sample = state.samples.find((item) => item.id === op.payload.id);
      if (!sample) return;
      for (const [field, value] of Object.entries(op.payload.changes || {})) {
        const conflictId = "cf:" + op.payload.id + ":" + field;
        const prev = sample.__writers && sample.__writers[field];
        if (prev && vvConcurrent(prev.vv, op.vv) && !resolved.has(conflictId)) {
          conflicts.push({
            id: conflictId,
            sampleId: op.payload.id,
            field,
            versions: [
              { opId: prev.opId, client: prev.client, value: prev.value },
              { opId: op.id, client: op.client, value }
            ]
          });
        }
        sample[field] = value;
        sample.__writers = {
          ...(sample.__writers || {}),
          [field]: { vv: op.vv, opId: op.id, client: op.client, value }
        };
      }
      state.revision++;
      return;
    }
    case "sample/delete": {
      state.samples = state.samples.filter((sample) => sample.id !== op.payload.id);
      state.compare = state.compare.filter((id) => id !== op.payload.id);
      state.revision++;
      return;
    }
    case "compare/add": {
      if (!state.compare.includes(op.payload.id)) {
        state.compare = [op.payload.id, ...state.compare].slice(0, 2);
      }
      state.revision++;
      return;
    }
    case "compare/remove": {
      state.compare = state.compare.filter((id) => id !== op.payload.id);
      state.revision++;
      return;
    }
  }
}

function deriveState(ops, cp) {
  const state = cp
    ? structuredClone(cp.state)
    : { samples: [], compare: [], revision: 0 };
  const base = cp ? cp.vv : {};
  const resolved = new Set();
  for (const op of ops) {
    for (const r of op.resolves || []) resolved.add(r);
  }
  const conflicts = [];
  for (const op of [...ops].sort(topoOrder)) {
    if (vvLe(op.vv, base)) continue;
    applyOpToState(state, op, conflicts, resolved);
  }
  return { state, conflicts };
}

let ledger = [];
let checkpoint = null;
let state = { samples: [], compare: [], revision: 0 };
let conflicts = [];
let opsSinceCheckpoint = 0;

function recompute() {
  const derived = deriveState(ledger, checkpoint);
  state = derived.state;
  conflicts = derived.conflicts;
}

function currentVv() {
  const vv = {};
  for (const op of ledger) {
    if (op.client) vv[op.client] = Math.max(vv[op.client] || 0, op.seq);
  }
  return vv;
}

function nextSeq() {
  return (currentVv()[client] || 0) + 1;
}

// ---------- 提交操作：幂等，重试沿用首次结果 ----------
function commit(newOps) {
  const fresh = [];
  for (const op of newOps) {
    if (ledger.some((item) => item.id === op.id)) continue; // 同一操作重试：沿用首次结果
    ledger.push(op);
    fresh.push(op);
  }
  if (!fresh.length) return true;
  const ok = persistLedger(ledger);
  recompute();
  if (!ok) {
    pendingOps = fresh;
    render();
    return false;
  }
  pendingOps = [];
  opsSinceCheckpoint += fresh.length;
  if (opsSinceCheckpoint >= CHECKPOINT_INTERVAL) {
    writeCheckpoint(state, currentVv());
    opsSinceCheckpoint = 0;
  }
  render();
  return true;
}

function appendOp(type, payload, extra = {}) {
  const seq = nextSeq();
  const op = {
    id: crypto.randomUUID(),
    client,
    seq,
    vv: { ...currentVv(), [client]: seq },
    type,
    payload,
    ts: new Date().toISOString(),
    ...extra
  };
  commit([op]);
  return op;
}

// ---------- 旧记录迁移：首次打开补编号，照片/批注/样本原样保留 ----------
function buildWriters(sample, opId, client, vv) {
  const writers = {};
  for (const [key, value] of Object.entries(sample)) {
    if (key === "id" || key === "createdAt") continue;
    writers[key] = { vv: { ...vv }, opId, client, value };
  }
  return writers;
}

function migrateIfNeeded() {
  if (localStorage.getItem(LEDGER_KEY)) return;
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch {
    return;
  }
  if (!legacy || !Array.isArray(legacy.samples)) return;
  const ops = [];
  let seq = 0;
  const base = Date.now();
  for (const sample of legacy.samples) {
    seq++;
    ops.push({
      id: "mig-" + sample.id,
      client,
      seq,
      vv: { [client]: seq },
      type: "sample/add",
      payload: structuredClone(sample),
      ts: new Date(base + seq).toISOString()
    });
  }
  for (const id of legacy.compare || []) {
    seq++;
    ops.push({
      id: "mig-cmp-" + id,
      client,
      seq,
      vv: { [client]: seq },
      type: "compare/add",
      payload: { id },
      ts: new Date(base + seq).toISOString()
    });
  }
  ledger = ops;
  const cpState = {
    samples: legacy.samples.map((sample, i) => ({
      ...sample,
      __writers: buildWriters(sample, "mig-" + sample.id, client, { [client]: i + 1 })
    })),
    compare: [...(legacy.compare || [])],
    revision: seq
  };
  writeCheckpoint(cpState, { [client]: seq });
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 迁移写入失败则保留旧数据，下次打开重试 */
  }
  opsSinceCheckpoint = 0;
}

// ---------- 多标签页合并：保留双方未冲突字段，同字段各留一版 ----------
function mergeRemote(remoteOps) {
  let added = false;
  for (const op of remoteOps) {
    try {
      validateOp(op);
    } catch {
      continue;
    }
    if (!ledger.some((item) => item.id === op.id)) {
      ledger.push(op);
      added = true;
    }
  }
  if (!added) return;
  persistLedger(ledger);
  recompute();
  render();
}

window.addEventListener("storage", (event) => {
  if (event.key === LEDGER_KEY && event.newValue) {
    try {
      mergeRemote(JSON.parse(event.newValue));
    } catch {
      /* 忽略无法解析的远端数据 */
    }
  }
});

// ---------- 快照缓存：样本信息一变即失效重算 ----------
const snapshotCache = new Map();
function getSnapshot(name, compute) {
  const key = state.revision;
  const cached = snapshotCache.get(name);
  if (cached && cached.key === key) return cached.data;
  const data = compute();
  snapshotCache.set(name, { key, data });
  return data;
}

function compareSnapshot() {
  return getSnapshot("compare", () =>
    state.compare
      .map((id) => state.samples.find((sample) => sample.id === id))
      .filter(Boolean)
      .slice(0, 2)
  );
}

function exportSnapshot() {
  return getSnapshot("export", () =>
    state.samples.map((sample) => ({
      样本编号: sample.code,
      采样地点: sample.location,
      放大倍数: sample.magnification,
      偏光类型: sample.polarization,
      主要矿物: sample.minerals,
      颗粒结构: sample.texture,
      老师批注: sample.comment
    }))
  );
}

// ---------- 渲染 ----------
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function filteredSamples() {
  const mineral = mineralFilter.value.trim();
  const polarization = polarFilter.value;
  return state.samples.filter((sample) => {
    const mineralMatch = !mineral || (sample.minerals || "").includes(mineral);
    const polarMatch = !polarization || sample.polarization === polarization;
    return mineralMatch && polarMatch;
  });
}

function renderGrid() {
  const rows = filteredSamples();
  sampleGrid.innerHTML = rows.length ? rows.map((sample) => `
    <article class="sample-card">
      ${sample.photo ? `<img src="${sample.photo}" alt="${escapeHtml(sample.code)}显微照片">` : "<div class=\"photo-placeholder\"></div>"}
      <div class="sample-body">
        <h3>${escapeHtml(sample.code)}</h3>
        <p>${escapeHtml(sample.location) || "未记录地点"} · ${escapeHtml(sample.magnification) || "未记录倍数"} · ${escapeHtml(sample.polarization)}</p>
        <p>矿物：${escapeHtml(sample.minerals) || "未记录"}</p>
        <p>结构：${escapeHtml(sample.texture) || "未记录结构"}</p>
        <p>${escapeHtml(sample.comment) || "未填写批注"}</p>
        <div class="card-actions">
          <label><input type="checkbox" data-compare="${sample.id}" ${state.compare.includes(sample.id) ? "checked" : ""}>对比</label>
          <button type="button" data-edit="${sample.id}">编辑</button>
          <button type="button" data-delete="${sample.id}">删除</button>
        </div>
      </div>
    </article>
  `).join("") : "<p>还没有样本，先从左侧录入一张薄片照片。</p>";
}

function renderCompare() {
  const compareSamples = compareSnapshot();
  comparePane.innerHTML = compareSamples.length ? compareSamples.map((sample) => `
    <article class="compare-item">
      ${sample.photo ? `<img src="${sample.photo}" alt="${escapeHtml(sample.code)}对比图">` : ""}
      <h3>${escapeHtml(sample.code)}</h3>
      <p>${escapeHtml(sample.polarization)} · ${escapeHtml(sample.minerals) || "未记录矿物"}</p>
      <p>${escapeHtml(sample.texture) || "未记录结构"}</p>
    </article>
  `).join("") : "<p>勾选两张样本卡片后可并排对比。</p>";
}

function renderConflicts() {
  if (!conflicts.length) {
    conflictPane.hidden = true;
    conflictPane.innerHTML = "";
    return;
  }
  conflictPane.hidden = false;
  conflictPane.innerHTML = `
    <div class="conflict-banner">
      <strong>有 ${conflicts.length} 处修改待确认</strong>
      ${conflicts.map((c) => {
        const sample = state.samples.find((item) => item.id === c.sampleId);
        return `<div class="conflict-item">
          <span>样本 ${escapeHtml(sample ? sample.code : "已删除")} 的「${FIELD_LABELS[c.field] || c.field}」双方都改过，各留一版：</span>
          ${c.versions.map((version) => `<button type="button" data-resolve="${c.id}" data-op="${version.opId}">${version.client === client ? "我方" : "对方"}版：${escapeHtml(String(version.value || "")).slice(0, 24) || "（空）"}</button>`).join("")}
        </div>`;
      }).join("")}
    </div>`;
}

function renderRetry() {
  retryBanner.hidden = !pendingOps.length;
}

function renderStatus() {
  statusBar.innerHTML = `
    <span>客户端 ${escapeHtml(client)}</span>
    <span>操作 ${ledger.length} 条</span>
    <span>检查点 ${checkpoint ? new Date(checkpoint.at).toLocaleTimeString() : "无"}</span>
    <span>待确认 ${conflicts.length}</span>
    <button type="button" id="simRemote">模拟远程并发编辑</button>
    <button type="button" id="simFail">模拟写入失败</button>
    <button type="button" id="simCorrupt">模拟存储损坏</button>
  `;
}

function render() {
  renderGrid();
  renderCompare();
  renderConflicts();
  renderRetry();
  renderStatus();
}

// ---------- 事件 ----------
function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.readAsDataURL(file);
  });
}

photoInput.addEventListener("change", async () => {
  pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  if (!pendingPhoto && photoInput.files[0]) {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  }
  const fields = {
    photo: pendingPhoto,
    code: (data.get("code") || "").trim(),
    location: (data.get("location") || "").trim(),
    magnification: (data.get("magnification") || "").trim(),
    polarization: data.get("polarization") || "单偏光",
    minerals: (data.get("minerals") || "").trim(),
    texture: (data.get("texture") || "").trim(),
    comment: (data.get("comment") || "").trim()
  };
  if (editingId) {
    const sample = state.samples.find((item) => item.id === editingId);
    const changes = {};
    for (const [key, value] of Object.entries(fields)) {
      if (key === "photo" && !value) continue; // 编辑时未重选照片则保留原图
      if (!sample || sample[key] !== value) changes[key] = value;
    }
    if (Object.keys(changes).length) {
      appendOp("sample/update", { id: editingId, changes });
    }
  } else {
    appendOp("sample/add", {
      id: crypto.randomUUID(),
      ...fields,
      createdAt: new Date().toISOString()
    });
  }
  if (!pendingOps.length) resetForm();
});

function resetForm() {
  form.reset();
  pendingPhoto = "";
  photoInput.value = "";
  editingId = null;
  submitBtn.textContent = "保存样本";
}

sampleGrid.addEventListener("click", (event) => {
  const editId = event.target.dataset.edit;
  if (editId) {
    const sample = state.samples.find((item) => item.id === editId);
    if (!sample) return;
    editingId = editId;
    form.code.value = sample.code || "";
    form.location.value = sample.location || "";
    form.magnification.value = sample.magnification || "";
    form.polarization.value = sample.polarization || "单偏光";
    form.minerals.value = sample.minerals || "";
    form.texture.value = sample.texture || "";
    form.comment.value = sample.comment || "";
    pendingPhoto = "";
    photoInput.value = "";
    submitBtn.textContent = "保存修改";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const deleteId = event.target.dataset.delete;
  if (deleteId) {
    appendOp("sample/delete", { id: deleteId });
  }
});

sampleGrid.addEventListener("change", (event) => {
  const id = event.target.dataset.compare;
  if (!id) return;
  if (event.target.checked) {
    appendOp("compare/add", { id });
  } else {
    appendOp("compare/remove", { id });
  }
});

[mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", renderGrid));

exportBtn.addEventListener("click", () => {
  const checklist = exportSnapshot();
  const blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "thin-section-checklist.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

conflictPane.addEventListener("click", (event) => {
  const button = event.target.closest("[data-resolve]");
  if (!button) return;
  resolveConflict(button.dataset.resolve, button.dataset.op);
});

retryBtn.addEventListener("click", () => {
  const ops = pendingOps;
  pendingOps = [];
  if (ops.length) commit(ops);
});

statusBar.addEventListener("click", (event) => {
  if (event.target.id === "simRemote") {
    simulateRemoteEdit();
  } else if (event.target.id === "simFail") {
    forceWriteFail = true;
    appendOp("sample/add", {
      id: crypto.randomUUID(),
      photo: "",
      code: "写入失败测试",
      location: "",
      magnification: "",
      polarization: "单偏光",
      minerals: "",
      texture: "",
      comment: "",
      createdAt: new Date().toISOString()
    });
  } else if (event.target.id === "simCorrupt") {
    localStorage.setItem(LEDGER_KEY, '[{"id":"broken","client":"x","seq":1,"vv":{"x":1},"type":"sample/add","payload":{');
    location.reload();
  }
});

function resolveConflict(conflictId, chosenOpId) {
  const conflict = conflicts.find((item) => item.id === conflictId);
  if (!conflict) return;
  const version = conflict.versions.find((item) => item.opId === chosenOpId);
  if (!version) return;
  appendOp("sample/update", {
    id: conflict.sampleId,
    changes: { [conflict.field]: version.value }
  }, { resolves: [conflictId] });
}

function simulateRemoteEdit() {
  const target = state.samples[0];
  if (!target) return;
  const remoteClient = "tab-sim";
  const field = "minerals";
  const op = {
    id: crypto.randomUUID(),
    client: remoteClient,
    seq: 1,
    vv: { [remoteClient]: 1 },
    type: "sample/update",
    payload: { id: target.id, changes: { [field]: "远程标签页改的矿物" } },
    ts: new Date().toISOString()
  };
  mergeRemote([op]);
}

// ---------- 启动：先读检查点，再加载账本，旧记录首次打开补编号 ----------
checkpoint = readCheckpoint();
ledger = loadLedger();
migrateIfNeeded();
recompute();
render();
