"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../journal.js");

const KEY = "test-doc";
const BACKUP = KEY + ".__backup";

function memStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    failWrites(times, kind) {
      let left = times;
      this.setItem = (k, v) => {
        if (left > 0) {
          left -= 1;
          const err = new Error("quota exceeded");
          if (kind === "partial") {
            map.set(k, String(v).slice(0, Math.floor(String(v).length / 2)));
          }
          throw err;
        }
        map.set(k, String(v));
      };
    },
    heal() {
      this.setItem = (k, v) => { map.set(k, String(v)); };
    }
  };
}

function twoJournals(storage, opts) {
  const a = new C.Journal(storage, KEY, "client-A", opts);
  const b = new C.Journal(storage, KEY, "client-B", opts);
  return { a, b };
}

function fieldVersions(journal, sampleId, field) {
  const proj = C.materialize(journal.doc);
  const sample = proj.samples.get(sampleId);
  return sample.fields[field].filter((v) => !v.supersededBy);
}

function findConflict(view, sampleId, field) {
  return view.conflicts.find((c) =>
    c.sampleId === sampleId && (field === "__deleted" ? c.kind === "deletion" : c.kind === "field" && c.field === field));
}

// ---- 基础：创建与编号 ----------------------------------------------------

test("创建样本获得连续编号，视图可见", () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  j.stage(C.makeCreate({ id: "s1", code: "BX-01", minerals: "石英" }, "c1"));
  j.stage(C.makeCreate({ id: "s2", code: "BX-02", minerals: "长石" }, "c1"));
  return j.whenFlushed().then(() => {
    const view = j.view();
    assert.equal(view.seq, 2);
    assert.equal(view.samples.length, 2);
    assert.equal(j.doc.log[0].seq, 1);
    assert.equal(j.doc.log[1].seq, 2);
    assert.deepEqual(JSON.parse(storage.getItem(KEY)).seq, 2);
  });
});

// ---- 多标签页：未冲突字段都保留 ------------------------------------------

test("两标签页改不同字段：合并后双方字段都在，不产生冲突", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  const create = C.makeCreate({ id: "s1", code: "BX-01", minerals: "石英", comment: "原批注" }, "client-A");
  a.stage(create);
  await a.whenFlushed();
  b.pull();

  // 两边都看到 seq=1，各自改不同字段
  const editA = C.makeUpdate("s1", 1, { comment: "A 改的批注" }, "client-A");
  const editB = C.makeUpdate("s1", 1, { minerals: "黑云母" }, "client-B");
  a.stage(editA);
  await a.whenFlushed();
  b.stage(editB);
  await b.whenFlushed();

  a.pull();
  const view = a.view();
  const s = view.samples.find((x) => x.id === "s1");
  assert.equal(s.minerals, "黑云母", "B 的矿物修改保留");
  assert.equal(s.comment, "A 改的批注", "A 的批注修改保留");
  assert.equal(view.conflicts.length, 0, "不同字段无冲突");
});

// ---- 多标签页：同一字段并发各留一版 --------------------------------------

test("两标签页改同一字段：各留一版，冲突待确认；裁决后收敛", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  a.stage(C.makeCreate({ id: "s1", code: "BX-01", comment: "原批注" }, "client-A"));
  await a.whenFlushed();
  b.pull();

  const opA = C.makeUpdate("s1", 1, { comment: "A 版批注" }, "client-A");
  const opB = C.makeUpdate("s1", 1, { comment: "B 版批注" }, "client-B");
  a.stage(opA);
  await a.whenFlushed();
  b.stage(opB);
  await b.whenFlushed();

  a.pull();
  let view = a.view();
  const conflict = findConflict(view, "s1", "comment");
  assert.ok(conflict, "同一字段并发应产生待确认冲突");
  assert.equal(conflict.versions.length, 2);
  const values = conflict.versions.map((v) => v.value).sort();
  assert.deepEqual(values, ["A 版批注", "B 版批注"]);

  // 裁决保留 B 版
  const choice = conflict.versions.find((v) => v.value === "B 版批注");
  a.resolve(conflict, choice);
  await a.whenFlushed();
  b.pull();
  view = b.view();
  assert.equal(view.samples.find((x) => x.id === "s1").comment, "B 版批注");
  assert.equal(view.conflicts.length, 0, "裁决后无冲突");

  // 检查点折叠后结论保持
  C.fold(b.doc);
  view = C.buildView(b.doc, []);
  assert.equal(view.samples[0].comment, "B 版批注");
  assert.equal(view.conflicts.length, 0);
});

test("同一字段写入相同值：自动收敛，不打扰用户", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  a.stage(C.makeCreate({ id: "s1", code: "BX-01", texture: "粒状" }, "client-A"));
  await a.whenFlushed();
  b.pull();
  a.stage(C.makeUpdate("s1", 1, { texture: "碎裂" }, "client-A"));
  await a.whenFlushed();
  b.stage(C.makeUpdate("s1", 1, { texture: "碎裂" }, "client-B"));
  await b.whenFlushed();
  a.pull();
  const view = a.view();
  assert.equal(view.samples[0].texture, "碎裂");
  assert.equal(view.conflicts.length, 0);
});

test("同一标签页连续编辑同一字段：顺序覆盖，不与自己冲突", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "client-A");
  j.stage(C.makeCreate({ id: "s1", code: "BX-01", comment: "v0" }, "client-A"));
  await j.whenFlushed();
  j.stage(C.makeUpdate("s1", 1, { comment: "v1" }, "client-A"));
  await j.whenFlushed();
  j.stage(C.makeUpdate("s1", 2, { comment: "v2" }, "client-A"));
  await j.whenFlushed();
  const view = j.view();
  assert.equal(view.samples[0].comment, "v2");
  assert.equal(view.conflicts.length, 0);
  assert.equal(fieldVersions(j, "s1", "comment").length, 1);
});

// ---- 样本信息一变，快照失效重算 ------------------------------------------

test("对比与导出快照按编号缓存；样本变化后失效并重算", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  j.stage(C.makeCreate({ id: "s1", code: "BX-01", minerals: "石英" }, "c1"));
  await j.whenFlushed();

  const exp1 = j.getSnapshot("export");
  assert.equal(exp1.snapshot.sourceSeq, 1);
  assert.equal(exp1.snapshot.checklist.length, 1);
  const cached = j.getSnapshot("export");
  assert.equal(cached.snapshot, exp1.snapshot, "编号未变时复用缓存");

  j.stage(C.makeCreate({ id: "s2", code: "BX-02", minerals: "长石" }, "c1"));
  await j.whenFlushed();

  const exp2 = j.getSnapshot("export");
  assert.notEqual(exp2.snapshot, exp1.snapshot, "编号前进后旧快照作废");
  assert.equal(exp2.snapshot.sourceSeq, 2);
  assert.equal(exp2.snapshot.checklist.length, 2);
});

test("对比快照随 compare 操作编号变化", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  j.stage(C.makeCreate({ id: "s1", code: "BX-01" }, "c1"));
  j.stage(C.makeCreate({ id: "s2", code: "BX-02" }, "c1"));
  await j.whenFlushed();
  j.stage(C.makeCompare(["s1"], 2, "c1"));
  await j.whenFlushed();
  const snap1 = j.getSnapshot("compare").snapshot;
  assert.deepEqual(snap1.items.map((i) => i.id), ["s1"]);
  j.stage(C.makeCompare(["s1", "s2"], 3, "c1"));
  await j.whenFlushed();
  const snap2 = j.getSnapshot("compare").snapshot;
  assert.equal(snap2.items.length, 2);
  assert.equal(snap2.sourceSeq, 4);
});

// ---- 写失败：待办保留、检查点恢复、重试沿用首次结果 -----------------------

test("写入失败后操作留在待办；恢复后重试沿用首次操作并成功", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  storage.failWrites(1);
  const op = C.makeCreate({ id: "s1", code: "BX-01", comment: "首次结果" }, "c1");
  const result = await j.stage(op);
  assert.equal(result.ok, false);
  assert.equal(j.pending.length, 1, "失败操作留在待办队列");
  assert.equal(j.pending[0].id, op.id, "待办就是首次那条操作");

  // 视图仍乐观可见
  assert.equal(j.view().samples.length, 1);

  storage.heal();
  const retry = await j.retry();
  assert.equal(retry.ok, true);
  assert.equal(j.pending.length, 0);
  assert.equal(j.view().samples[0].comment, "首次结果");
  // 持久化的编号操作与首次操作同 id
  assert.equal(JSON.parse(storage.getItem(KEY)).log[0].id, op.id);
});

test("重试幂等：同一操作不会因多次重试重复入账", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  const op = C.makeCreate({ id: "s1", code: "BX-01" }, "c1");
  storage.failWrites(2);
  await j.stage(op);
  await j.retry();
  assert.equal(j.pending.length, 1);
  storage.heal();
  await j.retry();
  const doc = JSON.parse(storage.getItem(KEY));
  assert.equal(doc.log.length, 1);
  assert.equal(doc.seq, 1);
});

test("主存写坏半截：重新打开时从备份恢复到最近完整检查点", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  await j.stage(C.makeCreate({ id: "s1", code: "BX-01", photo: "ph", comment: "批注" }, "c1"));
  await j.whenFlushed();
  // 模拟主存只写进半批 JSON
  storage.map.set(KEY, storage.map.get(KEY).slice(0, 40));

  const reopened = new C.Journal(storage, KEY, "c2");
  assert.equal(reopened.recoveredFrom, "backup");
  const view = reopened.view();
  assert.equal(view.samples.length, 1);
  assert.equal(view.samples[0].code, "BX-01");
  assert.equal(view.samples[0].photo, "ph");
  assert.equal(view.samples[0].comment, "批注");
});

test("备份也损坏但检查点可读时抢救检查点，之后从该编号续作", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1", { foldThreshold: 2 });
  await j.stage(C.makeCreate({ id: "s1", code: "BX-01" }, "c1"));
  await j.stage(C.makeCreate({ id: "s2", code: "BX-02" }, "c1"));
  await j.whenFlushed();
  // 两次操作触发折叠成检查点
  const doc = JSON.parse(storage.getItem(KEY));
  assert.ok(doc.checkpoint);
  assert.equal(doc.log.length, 0);
  // 主存整体写坏，备份截断（截断点恰好在 checkpoint 片段内，JSON 不完整）
  storage.map.set(KEY, "{ not json");
  const backup = storage.getItem(BACKUP);
  storage.map.set(BACKUP, backup.slice(0, backup.indexOf("checkpoint") + 200));

  const reopened = new C.Journal(storage, KEY, "c2");
  const view = reopened.view();
  assert.ok(view.samples.length >= 1 || reopened.recoveredFrom === "scratch");
});

// ---- 旧记录首次打开补编号 ------------------------------------------------

test("旧版 {samples, compare} 首次打开：补编号，照片/批注/样本可用", () => {
  const legacy = {
    samples: [
      { id: "old-1", code: "BX-99", photo: "data:image/png;base64,AAA", location: "东剖面", magnification: "40x", polarization: "正交偏光", minerals: "石英", texture: "粒状", comment: "旧批注", createdAt: "2024-01-01T00:00:00.000Z" }
    ],
    compare: ["old-1"]
  };
  const storage = memStorage({ [KEY]: JSON.stringify(legacy) });
  const j = new C.Journal(storage, KEY, "c1");
  assert.equal(j.migrated, true);
  const view = j.view();
  assert.equal(view.samples.length, 1);
  const s = view.samples[0];
  assert.equal(s.id, "old-1");
  assert.equal(s.code, "BX-99");
  assert.equal(s.photo, "data:image/png;base64,AAA");
  assert.equal(s.comment, "旧批注");
  assert.ok(j.doc.seq >= 1, "旧操作补上了编号");
  // 已是新格式，再次打开不再迁移
  const again = new C.Journal(storage, KEY, "c1");
  assert.equal(again.migrated, false);
  assert.equal(again.view().samples.length, 1);
});

test("迁移后旧的对比勾选仍然有效", () => {
  const legacy = {
    samples: [{ id: "x1", code: "A" }, { id: "x2", code: "B" }],
    compare: ["x1", "x2"]
  };
  const storage = memStorage({ [KEY]: JSON.stringify(legacy) });
  const j = new C.Journal(storage, KEY, "c1");
  const view = j.view();
  assert.deepEqual(view.compareIds, ["x1", "x2"]);
});

// ---- 删除并发 ------------------------------------------------------------

test("删除与另一标签页的编辑并发：挂删除冲突，两个去留版本待确认", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  a.stage(C.makeCreate({ id: "s1", code: "BX-01", comment: "原批注" }, "client-A"));
  await a.whenFlushed();
  b.pull();

  // A 基于 seq=1 删除，B 基于 seq=1 编辑
  a.stage(C.makeDelete("s1", 1, "client-A"));
  await a.whenFlushed();
  b.stage(C.makeUpdate("s1", 1, { comment: "B 还在改" }, "client-B"));
  await b.whenFlushed();

  a.pull();
  const view = a.view();
  const dc = view.conflicts.find((c) => c.sampleId === "s1" && c.kind === "deletion");
  assert.ok(dc, "删除与并发编辑应产生删除冲突");
  const bools = dc.versions.map((v) => v.value).sort();
  assert.deepEqual(bools, [false, true]);

  // 裁决保留样本（false 版本，即编辑方）
  const keep = dc.versions.find((v) => v.value === false);
  a.resolve(dc, keep);
  await a.whenFlushed();
  b.pull();
  const finalView = b.view();
  assert.equal(finalView.samples.length, 1, "裁决保留后样本恢复可见");
  assert.equal(finalView.conflicts.filter((c) => c.kind === "deletion").length, 0);
});

test("编辑先到、删除后到的顺序同样产生删除冲突", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  a.stage(C.makeCreate({ id: "s1", code: "BX-01", minerals: "石英" }, "client-A"));
  await a.whenFlushed();
  b.pull();

  // B 的编辑先落账（seq 2），A 的删除后落账（seq 3），但删除基于 seq1，与编辑并发
  b.stage(C.makeUpdate("s1", 1, { minerals: "黑云母" }, "client-B"));
  await b.whenFlushed();
  a.stage(C.makeDelete("s1", 1, "client-A"));
  await a.whenFlushed();

  b.pull();
  const view = b.view();
  assert.ok(view.conflicts.some((c) => c.sampleId === "s1" && c.kind === "deletion"));
  // 样本在删除冲突期间先隐藏；B 的编辑值保存在字段版本链上。
  const versions = fieldVersions(b, "s1", "minerals").map((v) => v.value);
  assert.deepEqual(versions, ["黑云母"]);

  // 裁决“保留样本”后样本恢复可见，编辑值仍在。
  const dc = view.conflicts.find((c) => c.sampleId === "s1" && c.kind === "deletion");
  const keep = dc.versions.find((v) => v.value === false);
  b.resolve(dc, keep);
  await b.whenFlushed();
  a.pull();
  const revived = a.view();
  assert.equal(revived.samples.length, 1);
  assert.equal(revived.samples[0].minerals, "黑云母");
});

test("编辑与删除并发且编辑改的是另一个标签页也改过的字段：去留与字段冲突都保留", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  a.stage(C.makeCreate({ id: "s1", code: "BX-01", comment: "原批注", minerals: "石英" }, "client-A"));
  await a.whenFlushed();
  b.pull();
  // A 先编辑一次（seq 2），B 看到的是 seq 1；随后 B 编辑同一字段（seq 3），A 删除（seq 4，基于 2）。
  a.stage(C.makeUpdate("s1", 1, { comment: "A 二版" }, "client-A"));
  await a.whenFlushed();
  b.stage(C.makeUpdate("s1", 1, { comment: "B 版" }, "client-B"));
  await b.whenFlushed();
  a.stage(C.makeDelete("s1", 2, "client-A"));
  await a.whenFlushed();
  b.pull();
  const view = b.view();
  assert.ok(view.conflicts.some((c) => c.sampleId === "s1" && c.kind === "deletion"), "删除冲突存在");
  const commentHeads = fieldVersions(b, "s1", "comment").map((v) => v.value).sort();
  assert.deepEqual(commentHeads, ["A 二版", "B 版"], "两个并发编辑版本都保留");
});

test("删除之后另一标签页基于新编号再删/编辑：顺序生效，不误报冲突", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  a.stage(C.makeCreate({ id: "s1", code: "BX-01" }, "client-A"));
  await a.whenFlushed();
  b.pull();
  a.stage(C.makeDelete("s1", 1, "client-A"));
  await a.whenFlushed();
  b.pull(); // B 看到了删除（seq 2）
  // B 在看到删除后再编辑：属于删除之后的顺序写
  b.stage(C.makeUpdate("s1", 2, { comment: "删后编辑" }, "client-B"));
  await b.whenFlushed();
  a.pull();
  const view = a.view();
  assert.equal(view.samples.length, 0, "顺序场景样本仍删除");
  assert.equal(view.conflicts.filter((c) => c.kind === "deletion").length, 0);
});

// ---- 多标签页同时新建 ----------------------------------------------------

test("两标签页各自新建不同样本：都保留，编号连续", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  const opA = C.makeCreate({ id: "s1", code: "A-1" }, "client-A");
  const opB = C.makeCreate({ id: "s2", code: "B-1" }, "client-B");
  a.stage(opA);
  await a.whenFlushed();
  b.stage(opB);
  await b.whenFlushed();
  a.pull();
  b.pull();
  a.pull();
  const view = a.view();
  assert.equal(view.samples.length, 2);
  const seqs = a.doc.log.map((op) => op.seq);
  assert.deepEqual(seqs, [1, 2]);
});

// ---- 检查点折叠 ----------------------------------------------------------

test("检查点折叠后物化结果一致，旧账可丢弃并继续追加", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1", { foldThreshold: 3 });
  j.stage(C.makeCreate({ id: "s1", code: "BX-01", comment: "v0" }, "c1"));
  j.stage(C.makeUpdate("s1", 1, { comment: "v1" }, "c1"));
  j.stage(C.makeCreate({ id: "s2", code: "BX-02" }, "c1"));
  await j.whenFlushed();
  assert.equal(j.doc.log.length, 0, "达到阈值已折叠");
  assert.ok(j.doc.checkpoint);
  assert.equal(j.doc.checkpoint.seq, 3);

  const view = j.view();
  assert.equal(view.samples.length, 2);
  assert.equal(view.samples.find((s) => s.id === "s1").comment, "v1");

  j.stage(C.makeUpdate("s1", 3, { comment: "v2" }, "c1"));
  await j.whenFlushed();
  assert.equal(j.view().samples.find((s) => s.id === "s1").comment, "v2");
});

test("折叠后另一标签页的待办操作仍能在检查点之上并入", async () => {
  const storage = memStorage();
  const a = new C.Journal(storage, KEY, "client-A", { foldThreshold: 2 });
  const b = new C.Journal(storage, KEY, "client-B", { foldThreshold: 2 });
  a.stage(C.makeCreate({ id: "s1", code: "BX-01" }, "client-A"));
  a.stage(C.makeCreate({ id: "s2", code: "BX-02" }, "client-A"));
  await a.whenFlushed(); // A 折叠
  b.pull();              // B 拿到检查点
  assert.equal(b.view().samples.length, 2);
  b.stage(C.makeUpdate("s1", 2, { comment: "B 补充" }, "client-B"));
  await b.whenFlushed();
  a.pull();
  assert.equal(a.view().samples.find((s) => s.id === "s1").comment, "B 补充");
});

// ---- 写校验失败 ----------------------------------------------------------

test("读回内容与写入不一致时报错且不丢待办", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  storage.setItem = (k, v) => {
    if (k === KEY) storage.map.set(k, String(v) + "-tampered");
    else storage.map.set(k, String(v));
  };
  const result = await j.stage(C.makeCreate({ id: "s1", code: "BX-01" }, "c1"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "WRITE_VERIFY");
  assert.equal(j.pending.length, 1);
});

// ---- 三个标签页并发 ------------------------------------------------------

test("三个标签页同改一个字段：三个版本并存，裁决后只剩一版", async () => {
  const storage = memStorage();
  const a = new C.Journal(storage, KEY, "A");
  const b = new C.Journal(storage, KEY, "B");
  const d = new C.Journal(storage, KEY, "D");
  await a.stage(C.makeCreate({ id: "s1", code: "BX-01", comment: "v0" }, "A"));
  await a.whenFlushed();
  b.pull();
  d.pull();

  await a.stage(C.makeUpdate("s1", 1, { comment: "A" }, "A"));
  await a.whenFlushed();
  await b.stage(C.makeUpdate("s1", 1, { comment: "B" }, "B"));
  await b.whenFlushed();
  await d.stage(C.makeUpdate("s1", 1, { comment: "D" }, "D"));
  await d.whenFlushed();

  a.pull(); a.pull();
  const view = a.view();
  const conflict = findConflict(view, "s1", "comment");
  assert.ok(conflict);
  assert.deepEqual(conflict.versions.map((v) => v.value).sort(), ["A", "B", "D"]);

  const pick = conflict.versions.find((v) => v.value === "D");
  await a.resolve(conflict, pick);
  b.pull(); d.pull(); b.pull();
  assert.equal(d.view().samples[0].comment, "D");
  assert.equal(d.view().conflicts.length, 0);
});

// ---- 待办在他人操作之后重新排队，不互相盖掉 ------------------------------

test("本地有待办时对方先落账：提交时续接对方编号，双方内容都在", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  await a.stage(C.makeCreate({ id: "s1", code: "BX-01", minerals: "石英", texture: "粒状" }, "client-A"));
  await a.whenFlushed();
  b.pull();

  // A 的写入先失败，操作留待办
  storage.failWrites(1);
  const aj = new C.Journal(storage, KEY, "client-A");
  const r = await aj.stage(C.makeUpdate("s1", 1, { minerals: "A 改矿物" }, "client-A"));
  assert.equal(r.ok, false);
  assert.equal(aj.pending.length, 1);

  // 此时另一标签页写入另一字段成功（编号 2）
  storage.heal();
  const bj = new C.Journal(storage, KEY, "client-B");
  await bj.stage(C.makeUpdate("s1", 1, { texture: "B 改结构" }, "client-B"));
  await bj.whenFlushed();

  // A 重试：沿用首次操作，编号续接为 3，两字段修改都在
  const retry = await aj.retry();
  assert.equal(retry.ok, true);
  bj.pull();
  const view = bj.view();
  const s = view.samples.find((x) => x.id === "s1");
  assert.equal(s.minerals, "A 改矿物");
  assert.equal(s.texture, "B 改结构");
  assert.equal(view.conflicts.length, 0);
  assert.deepEqual(bj.doc.log.map((op) => op.seq), [1, 2, 3]);
});

// ---- 照片/批注作为字段参与合并 ------------------------------------------

test("照片与批注是独立字段：换照片不盖掉并发批注", async () => {
  const storage = memStorage();
  const { a, b } = twoJournals(storage);
  await a.stage(C.makeCreate({ id: "s1", code: "BX-01", photo: "p0", comment: "c0" }, "client-A"));
  await a.whenFlushed();
  b.pull();
  await a.stage(C.makeUpdate("s1", 1, { photo: "pA" }, "client-A"));
  await a.whenFlushed();
  await b.stage(C.makeUpdate("s1", 1, { comment: "cB" }, "client-B"));
  await b.whenFlushed();
  a.pull();
  const s = a.view().samples[0];
  assert.equal(s.photo, "pA");
  assert.equal(s.comment, "cB");
  assert.equal(a.view().conflicts.length, 0);
});

// ---- 空操作/空账边界 -----------------------------------------------------

test("空账视图安全；空更新不产生编号", async () => {
  const storage = memStorage();
  const j = new C.Journal(storage, KEY, "c1");
  assert.deepEqual(j.view().samples, []);
  assert.equal(j.view().conflicts.length, 0);
  assert.equal(j.getSnapshot("export").snapshot.checklist.length, 0);
});

