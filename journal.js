/*
 * 可续作操作账（operation journal）核心。
 *
 * 存储结构（localStorage 的一个键）：
 * {
 *   version: 2,
 *   seq: number,              // 已确认操作的最大编号
 *   log: Op[],                // 顺序追加的操作账（编号从 1 起）
 *   checkpoint: {             // 最近检查点：把旧账折叠后的物化结果
 *     seq, samples: [{ id, code, createdAt, fields: { field: [version...] } }],
 *     compare: [id, id],
 *     sampleSeq: number, compareSeq: number
 *   } | null
 * }
 *
 * 每个操作：
 *   { id, seq, clientId, ts, type: 'create'|'update'|'delete'|'resolve'|'compare', ... }
 * update/resolve 带 baseSeq（发起方上次看到的编号），合并时据此判断
 * 同一字段是顺序改写（后到为准）还是并发改写（各留一版，待确认）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JournalCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STORAGE_VERSION = 2;
  const COMPARE_LIMIT = 2;
  const FIELDS = [
    "photo", "code", "location", "magnification",
    "polarization", "minerals", "texture", "comment"
  ];
  const DELETE_FIELD = "__deleted";

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // ---- 操作构造 -------------------------------------------------------

  function makeCreate(sample, clientId) {
    return {
      id: uuid(), seq: null, clientId, ts: new Date().toISOString(),
      type: "create",
      sample: {
        id: sample.id, code: sample.code || "", createdAt: sample.createdAt || new Date().toISOString(),
        photo: sample.photo || "", location: sample.location || "",
        magnification: sample.magnification || "", polarization: sample.polarization || "",
        minerals: sample.minerals || "", texture: sample.texture || "",
        comment: sample.comment || ""
      }
    };
  }

  function makeUpdate(sampleId, baseSeq, changes, clientId) {
    return {
      id: uuid(), seq: null, clientId, ts: new Date().toISOString(),
      type: "update", sampleId, baseSeq: baseSeq || 0, changes: changes || {}
    };
  }

  function makeResolve(sampleId, field, opId, value, baseSeq, clientId) {
    return {
      id: uuid(), seq: null, clientId, ts: new Date().toISOString(),
      type: "resolve", sampleId, field, opId, value, baseSeq: baseSeq || 0
    };
  }

  function makeDelete(sampleId, baseSeq, clientId) {
    return {
      id: uuid(), seq: null, clientId, ts: new Date().toISOString(),
      type: "delete", sampleId, baseSeq: baseSeq || 0
    };
  }

  function makeCompare(ids, baseSeq, clientId) {
    return {
      id: uuid(), seq: null, clientId, ts: new Date().toISOString(),
      type: "compare", ids: ids.slice(0, COMPARE_LIMIT), baseSeq: baseSeq || 0
    };
  }

  // ---- 物化：把操作折叠成各字段的版本链 -------------------------------

  function emptyProjection() {
    return {
      samples: new Map(),
      compare: [],
      sampleSeq: 0,
      compareSeq: 0
    };
  }

  function sortVersions(a, b) {
    if (a.seq === b.seq) return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.opId < b.opId ? -1 : 1);
    return a.seq - b.seq;
  }

  // 两个写入是否并发：后到操作（op）没见过早先版本（earlierSeq）即并发；
  // 同一客户端发起的操作按其因果链视为顺序，不会与自己冲突。
  function isConcurrentWith(op, earlierSeq, earlierClientId) {
    if (op.clientId && op.clientId === earlierClientId) return false;
    return typeof op.baseSeq === "number" && op.baseSeq < earlierSeq;
  }

  function getOrCreateSample(proj, op) {
    let sample = proj.samples.get(op.sampleId);
    if (!sample) {
      // 旧账折叠后只剩 update 时，create 应总在最前；这里只做兜底。
      sample = { id: op.sampleId, code: "", createdAt: op.ts, fields: {} };
      proj.samples.set(op.sampleId, sample);
    }
    return sample;
  }

  // 处理 resolve：它裁决 field 上 opId 那个待确认版本。
  function applyResolve(proj, op) {
    const sample = proj.samples.get(op.sampleId);
    if (!sample) return;
    const versions = sample.fields[op.field];
    if (!versions) return;
    for (let i = 0; i < versions.length; i += 1) {
      if (versions[i].opId === op.opId) {
        versions[i] = { value: op.value, seq: op.seq, ts: op.ts, opId: op.id, resolved: true };
      } else {
        versions[i] = { ...versions[i], supersededBy: op.id };
      }
    }
  }

  // 给某个字段并入一个写入版本；顺序改写互相覆盖，并发改写并存。
  function applyFieldVersion(sample, field, op, value) {
    const version = { value, seq: op.seq, ts: op.ts, opId: op.id, clientId: op.clientId };
    const versions = (sample.fields[field] || []).filter((v) => !v.supersededBy);

    if (versions.length === 0) {
      sample.fields[field] = [version];
      return;
    }

    // 双方写了同一个值：不产生冲突，较新的写入作为代表。
    if (versions.some((existing) => deepEqual(existing.value, value))) {
      const ordered = [...versions, version].sort(sortVersions);
      sample.fields[field] = [ordered[ordered.length - 1]];
      return;
    }

    const ordered = [...versions, version].sort(sortVersions);
    const newest = ordered[ordered.length - 1];
    if (newest.opId !== op.id) {
      // 本操作并非最新写入：交给“最新操作重放”的那一遍判定即可。
      sample.fields[field] = versions;
      return;
    }

    // 以最新写入者的视角：它没见过的、仍然存活的异值版本 = 并发冲突。
    // create 写入的初始值不属于任何人的“编辑”，首个编辑直接覆盖，不构成冲突。
    const concurrent = versions.filter(
      (existing) => !existing.initial && isConcurrentWith(op, existing.seq, existing.clientId)
    );

    if (concurrent.length > 0) {
      const kept = [...concurrent];
      if (!kept.some((v) => deepEqual(v.value, value))) kept.push(version);
      sample.fields[field] = kept.sort(sortVersions);
    } else {
      sample.fields[field] = [version];
    }
  }

  // 删除与字段编辑并发时，在 __deleted 上补一版“未删除”，与删除版本并存待确认。
  // editRef 提供编辑方身份（baseSeq/clientId 决定并发判定），placeholder 决定这版记录的排序。
  // 删除已存在且与编辑并发时，在 __deleted 上登记一版“未删除”并存待确认。
  function noteEditAgainstDelete(sample, editRef, placeholder) {
    const delVersions = (sample.fields[DELETE_FIELD] || []).filter((v) => !v.supersededBy);
    if (!delVersions.some((v) => v.value === true)) return false;
    if (delVersions.some((v) => v.value === false && v.opId === editRef.id)) return false;
    if (!delVersions.some(
      (v) => v.value === true && isConcurrentWith(editRef, v.seq, v.clientId)
    )) return false;
    const keep = {
      value: false,
      seq: placeholder.seq,
      ts: placeholder.ts,
      opId: editRef.id,
      clientId: editRef.clientId,
      viaEdit: true
    };
    delVersions.push(keep);
    sample.fields[DELETE_FIELD] = delVersions.sort(sortVersions);
    return true;
  }

  function applyOp(proj, op) {
    switch (op.type) {
      case "create": {
        if (!proj.samples.has(op.sample.id)) {
          const sample = { id: op.sample.id, code: op.sample.code, createdAt: op.sample.createdAt, fields: {} };
          for (const field of FIELDS) {
            sample.fields[field] = [{
              value: op.sample[field] === undefined ? "" : op.sample[field],
              seq: op.seq, ts: op.ts, opId: op.id, clientId: op.clientId, initial: true
            }];
          }
          sample.fields[DELETE_FIELD] = [{
            value: false, seq: op.seq, ts: op.ts, opId: op.id, clientId: op.clientId, initial: true
          }];
          proj.samples.set(sample.id, sample);
        }
        proj.sampleSeq = Math.max(proj.sampleSeq, op.seq || 0);
        break;
      }
      case "update": {
        const sample = getOrCreateSample(proj, op);
        for (const [field, value] of Object.entries(op.changes || {})) {
          if (!FIELDS.includes(field)) continue;
          applyFieldVersion(sample, field, op, value);
          const liveDelete = (sample.fields[DELETE_FIELD] || []).find((v) => v.value === true && !v.supersededBy);
          if (liveDelete && isConcurrentWith(op, liveDelete.seq, liveDelete.clientId)) {
            // 编辑后到：字段已留版本，再在 __deleted 上挂一版“未删除”。
            noteEditAgainstDelete(sample, op, { seq: op.seq, ts: op.ts });
          }
        }
        proj.sampleSeq = Math.max(proj.sampleSeq, op.seq || 0);
        break;
      }
      case "delete": {
        const sample = proj.samples.get(op.sampleId);
        if (!sample) break;
        // 扫描与本删除并发的字段编辑（编辑先到的情形），每个编辑在 __deleted
        // 上代建一版“未删除”，opId 沿用编辑操作，这样无论到达顺序结果一致。
        const concurrentEdits = [];
        for (const field of FIELDS) {
          for (const v of (sample.fields[field] || []).filter((x) => !x.supersededBy && !x.initial)) {
            if (isConcurrentWith(op, v.seq, v.clientId)) concurrentEdits.push(v);
          }
        }

        const delVersion = { value: true, seq: op.seq, ts: op.ts, opId: op.id, clientId: op.clientId };
        let heads = (sample.fields[DELETE_FIELD] || []).filter((v) => !v.supersededBy);
        if (concurrentEdits.length) {
          // 与编辑并发：删除与“未删除”并存待确认；多个编辑共享一次去留抉择。
          const keepEdits = concurrentEdits.map((v) => ({
            value: false, seq: op.seq, ts: v.ts, opId: v.opId, clientId: v.clientId, viaEdit: true
          }));
          heads = [
            ...heads.filter((v) => v.value === false),
            ...keepEdits.filter((k) => !heads.some((h) => h.value === false && h.opId === k.opId)),
            delVersion
          ];
        } else {
          heads = [delVersion];
        }
        sample.fields[DELETE_FIELD] = heads.sort(sortVersions);
        proj.sampleSeq = Math.max(proj.sampleSeq, op.seq || 0);
        break;
      }
      case "resolve":
        applyResolve(proj, op);
        proj.sampleSeq = Math.max(proj.sampleSeq, op.seq || 0);
        break;
      case "compare":
        proj.compare = op.ids.slice(0, COMPARE_LIMIT);
        proj.compareSeq = op.seq || proj.compareSeq;
        break;
      default:
        break;
    }
  }

  // 从检查点继续，或从空账重放全部操作。
  function materialize(doc) {
    const proj = emptyProjection();
    let startIndex = 0;
    if (doc.checkpoint && doc.checkpoint.seq > 0) {
      for (const s of doc.checkpoint.samples) {
        proj.samples.set(s.id, { id: s.id, code: s.code, createdAt: s.createdAt, fields: clone(s.fields) });
      }
      proj.compare = doc.checkpoint.compare.slice();
      proj.sampleSeq = doc.checkpoint.sampleSeq || doc.checkpoint.seq;
      proj.compareSeq = doc.checkpoint.compareSeq || 0;
      startIndex = doc.log.findIndex((op) => op.seq > doc.checkpoint.seq);
      if (startIndex === -1) startIndex = doc.log.length;
    }
    const ops = doc.log.slice(startIndex).sort((a, b) => a.seq - b.seq);
    for (const op of ops) applyOp(proj, op);
    return proj;
  }

  // 物化结果 → 视图：每字段挑活版本，多版本即冲突待确认。
  function headOf(sample, field) {
    const versions = (sample.fields[field] || []).filter((v) => !v.supersededBy);
    return versions.length ? versions : null;
  }

  function buildView(doc, extraOps) {
    const proj = materialize(doc);
    // 待办操作先以临时编号投影到视图：编号排在已确认账之后，保证乐观可见；
    // 真正提交拿到编号后会重新物化，冲突判定以持久化编号为准。
    let provisional = doc.seq;
    const orderedExtra = (extraOps || []).slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const raw of orderedExtra) {
      provisional += 1;
      applyOp(proj, { ...raw, seq: provisional });
    }
    const extraCount = orderedExtra.length;

    const samples = [];
    const conflicts = [];

    for (const sample of proj.samples.values()) {
      const deletedHeads = headOf(sample, DELETE_FIELD) || [];
      const hasDeleteConflict = new Set(deletedHeads.map((v) => v.value)).size > 1;

      const fieldConflicts = [];
      const values = {};
      for (const field of FIELDS) {
        const heads = headOf(sample, field);
        if (!heads) {
          values[field] = "";
        } else if (heads.length === 1) {
          values[field] = heads[0].value;
        } else {
          values[field] = heads[0].value; // 占位值，UI 按 conflict 渲染
          fieldConflicts.push({
            field,
            versions: heads.map((h) => ({
              opId: h.opId, clientId: h.clientId, ts: h.ts,
              value: h.value, resolved: !!h.resolved, seq: h.seq
            }))
          });
        }
      }

      const isDeleted = !hasDeleteConflict && deletedHeads.some((v) => v.value === true);
      const deleteConflict = hasDeleteConflict
        ? deletedHeads.map((h) => ({
            opId: h.opId, clientId: h.clientId, ts: h.ts, value: h.value,
            viaEdit: !!h.viaEdit, seq: h.seq
          }))
        : null;

      samples.push({
        id: sample.id,
        code: values.code,
        createdAt: sample.createdAt,
        photo: values.photo,
        location: values.location,
        magnification: values.magnification,
        polarization: values.polarization,
        minerals: values.minerals,
        texture: values.texture,
        comment: values.comment,
        deleted: isDeleted
      });

      if (deleteConflict) {
        conflicts.push({
          sampleId: sample.id, code: values.code || sample.code || sample.id,
          kind: "deletion",
          versions: deleteConflict
        });
      }
      for (const fc of fieldConflicts) {
        conflicts.push({
          sampleId: sample.id, code: values.code || sample.code || sample.id,
          kind: "field", field: fc.field, versions: fc.versions
        });
      }
    }

    samples.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    const visible = samples.filter((s) => !s.deleted);
    const byId = new Map(visible.map((s) => [s.id, s]));
    const compareSamples = proj.compare.map((id) => byId.get(id)).filter(Boolean).slice(0, COMPARE_LIMIT);

    return {
      seq: doc.seq + extraCount,
      durableSeq: doc.seq,
      samples: visible,
      compare: compareSamples,
      compareIds: compareSamples.map((s) => s.id),
      conflicts,
      sampleSeq: proj.sampleSeq,
      compareSeq: proj.compareSeq
    };
  }

  // ---- 派生快照 -------------------------------------------------------

  function buildCompareSnapshot(view) {
    return {
      sourceSeq: view.seq,
      items: view.compare.map((s) => ({
        id: s.id, code: s.code, photo: s.photo,
        polarization: s.polarization, minerals: s.minerals, texture: s.texture
      }))
    };
  }

  function buildExportSnapshot(view) {
    return {
      sourceSeq: view.seq,
      checklist: view.samples.map((sample) => ({
        样本编号: sample.code,
        采样地点: sample.location,
        放大倍数: sample.magnification,
        偏光类型: sample.polarization,
        主要矿物: sample.minerals,
        颗粒结构: sample.texture,
        老师批注: sample.comment
      }))
    };
  }

  // ---- 文档合并 / 提交 ------------------------------------------------

  function isCreateConflictError(err) {
    return err && err.code === "SAMPLE_ALREADY_CREATED";
  }

  // 把新到操作并入文档：编号续接、同操作去重、生成快照版本戳。
  function appendOps(doc, ops) {
    const byId = new Map(doc.log.map((op) => [op.id, op]));
    const createdSamples = new Set(
      doc.log.filter((op) => op.type === "create").map((op) => op.sample.id)
    );
    // 检查点里的样本也已“创建”，折叠后的入账同样不能再插一笔 create。
    if (doc.checkpoint) {
      for (const s of doc.checkpoint.samples) createdSamples.add(s.id);
    }

    let seq = doc.seq;
    const added = [];
    for (const raw of ops) {
      if (byId.has(raw.id)) continue;
      if (raw.type === "create" && createdSamples.has(raw.sample.id)) {
        const err = new Error("该样本已被另一个标签页创建");
        err.code = "SAMPLE_ALREADY_CREATED";
        throw err;
      }
      seq += 1;
      const op = clone(raw);
      op.seq = seq;
      doc.log.push(op);
      byId.set(op.id, op);
      if (op.type === "create") createdSamples.add(op.sample.id);
      added.push(op);
    }
    doc.seq = seq;
    return added;
  }

  // 检查点折叠：物化后丢弃已并入检查点的旧账。
  function fold(doc) {
    const proj = materialize(doc);
    const samples = [];
    for (const sample of proj.samples.values()) {
      samples.push({
        id: sample.id, code: sample.code, createdAt: sample.createdAt,
        fields: clone(sample.fields)
      });
    }
    doc.checkpoint = {
      seq: doc.seq,
      samples,
      compare: proj.compare.slice(),
      sampleSeq: proj.sampleSeq,
      compareSeq: proj.compareSeq
    };
    doc.log = [];
    return doc;
  }

  function maybeFold(doc, threshold) {
    if (doc.log.length >= threshold) fold(doc);
    return doc;
  }

  // ---- 旧档迁移 -------------------------------------------------------

  function isLegacy(raw) {
    return raw && Array.isArray(raw.samples) && !("version" in raw);
  }

  // 首次打开旧记录：逐条补编号，照片、批注、样本原样可用。
  function migrateLegacy(raw, clientId) {
    const doc = emptyDoc();
    const ops = [];
    for (const legacySample of raw.samples) {
      if (!legacySample || !legacySample.id) continue;
      ops.push(makeCreate({
        id: legacySample.id,
        code: legacySample.code || "",
        createdAt: legacySample.createdAt || new Date().toISOString(),
        photo: legacySample.photo || "",
        location: legacySample.location || "",
        magnification: legacySample.magnification || "",
        polarization: legacySample.polarization || "",
        minerals: legacySample.minerals || "",
        texture: legacySample.texture || "",
        comment: legacySample.comment || ""
      }, clientId));
    }
    if (Array.isArray(raw.compare) && raw.compare.length) {
      ops.push(makeCompare(raw.compare, 0, clientId));
    }
    appendOps(doc, ops);
    return doc;
  }

  // ---- 文档装载 / 损坏恢复 --------------------------------------------

  function emptyDoc() {
    return { version: STORAGE_VERSION, seq: 0, log: [], checkpoint: null };
  }

  function isValidDoc(doc) {
    if (!doc || typeof doc !== "object" || doc.version !== STORAGE_VERSION) return false;
    if (typeof doc.seq !== "number" || !Array.isArray(doc.log)) return false;
    if (doc.log.some((op) => typeof op.seq !== "number" || typeof op.id !== "string")) return false;
    return true;
  }

  function normalizeDoc(doc) {
    return {
      version: STORAGE_VERSION,
      seq: typeof doc.seq === "number" ? doc.seq : 0,
      log: Array.isArray(doc.log) ? doc.log : [],
      checkpoint: doc.checkpoint || null
    };
  }

  // 解析任一份候选原文；半批写坏时回退到最近检查点/备份，操作账从最后完整编号续作。
  function parseCandidates(candidates) {
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (!candidate) continue;
      let parsed;
      try {
        parsed = JSON.parse(candidate);
      } catch (_) {
        continue;
      }
      if (isLegacy(parsed)) return { doc: null, legacy: parsed, recoveredFrom: null };
      if (isValidDoc(parsed)) {
        // 排在前面的候选（主存）读不出来时，靠后候选（备份）即恢复来源。
        return { doc: normalizeDoc(parsed), recoveredFrom: i > 0 ? "backup" : null };
      }
      // JSON 完整但内容残缺：尽量抢救检查点。
      if (parsed && parsed.version === STORAGE_VERSION && parsed.checkpoint) {
        const salvage = emptyDoc();
        salvage.checkpoint = parsed.checkpoint;
        salvage.seq = parsed.checkpoint.seq || 0;
        salvage.log = Array.isArray(parsed.log) ? parsed.log.filter((op) => op && typeof op.seq === "number") : [];
        if (isValidDoc(salvage)) {
          return { doc: salvage, recoveredFrom: "corrupt" };
        }
      }
    }
    return { doc: null, recoveredFrom: null };
  }

  // ---- 装载器：本地存储、检查点、失败恢复 ------------------------------

  class Journal {
    // storage 需实现 getItem/setItem（localStorage 或测试桩）。
    // options.lock(fn) 用于跨标签页串行提交（浏览器接 Web Locks），
    // 默认同步执行，保证所有标签页对操作编号有同一个全局顺序。
    constructor(storage, key, clientId, options) {
      this.storage = storage;
      this.key = key || "wxyy-2-thin-section-index";
      this.backupKey = this.key + ".__backup";
      this.clientId = clientId || uuid();
      options = options || {};
      this.foldThreshold = options.foldThreshold || 50;
      this.lock = options.lock || ((fn) => fn());
      this.pending = [];          // 尚未落账的操作：写入失败后原样保留，重试沿用首次结果
      this.lastWriteFailed = false;
      this.flushError = null;
      this.recoveredFrom = null;
      this.migrated = false;
      this.listeners = [];
      this._snapshots = { compare: null, export: null };
      this._flushChain = null;
      this._load();
    }

    _load() {
      const primaryText = this.storage.getItem(this.key);
      const backupText = this.storage.getItem(this.backupKey);
      const raws = [
        { label: "primary", text: primaryText },
        { label: "backup", text: backupText }
      ];
      const parsed = parseCandidates(raws.map((r) => r.text));
      if (parsed.legacy) {
        // 旧记录首次打开：补编号后另存为新账，照片/批注/样本原样保留。
        this.doc = migrateLegacy(parsed.legacy, this.clientId);
        this.migrated = true;
        try {
          this._persist(this.doc);
        } catch (_) {
          this.lastWriteFailed = true;
        }
      } else if (parsed.doc) {
        this.doc = parsed.doc;
        // 主存原文不是有效文档（半截写坏/读不出）而备份可用：标记从备份恢复。
        let primaryOk = false;
        if (primaryText) {
          try {
            const p = JSON.parse(primaryText);
            primaryOk = isValidDoc(p);
          } catch (_) {
            primaryOk = false;
          }
        }
        if (!primaryOk && backupText) this.recoveredFrom = "backup";
        else if (parsed.recoveredFrom === "corrupt") this.recoveredFrom = "corrupt";
      } else {
        // 主存和备份都不可读：从空账开始（任一份能读出检查点都会在上面接住）。
        this.doc = emptyDoc();
        if (raws.some((r) => r.text)) this.recoveredFrom = "scratch";
      }
      this._refreshSnapshotsStamps();
    }

    // 原子意图写入：先落备份再写主存，并读回校验；失败抛错且不动已确认账，
    // 调用方待办原样保留，重试沿用同一批操作。
    _persist(doc) {
      const text = JSON.stringify(doc);
      try {
        this.storage.setItem(this.backupKey, text);
        this.storage.setItem(this.key, text);
      } catch (err) {
        this.lastWriteFailed = true;
        throw err;
      }
      const readBack = this.storage.getItem(this.key);
      if (readBack !== text) {
        this.lastWriteFailed = true;
        const err = new Error("写入校验失败：读回内容与提交不一致");
        err.code = "WRITE_VERIFY";
        throw err;
      }
      this.lastWriteFailed = false;
      return text;
    }

    onSync(fn) {
      this.listeners.push(fn);
      return () => {
        this.listeners = this.listeners.filter((item) => item !== fn);
      };
    }

    _emit(info) {
      for (const fn of this.listeners) {
        try { fn(info); } catch (_) { /* 监听失败不影响账目 */ }
      }
    }

    view() {
      return buildView(this.doc, this.pending);
    }

    // 提交一批操作：重新读主存，先并入别的标签页已写入的操作（编号续接），
    // 再给本批操作编号落账。同一操作 id 不重复入账，重试天然幂等。
    commit(ops) {
      const fresh = parseCandidates([this.storage.getItem(this.key), this.storage.getItem(this.backupKey)]);
      const base = fresh.doc || this.doc;

      let batch = ops;
      const dropped = [];
      const createdIds = new Set(
        base.log.filter((op) => op.type === "create").map((op) => op.sample.id)
      );
      if (base.checkpoint) for (const s of base.checkpoint.samples) createdIds.add(s.id);
      batch = batch.filter((op) => {
        if (op.type === "create" && createdIds.has(op.sample.id)) {
          dropped.push(op);
          return false;
        }
        return true;
      });
      // 本地已确认但 fresh 里没有（极端回退）时，也把当前账作为待并入来源。
      const merged = base;
      const known = new Set(merged.log.map((op) => op.id));
      const carry = this.doc.log.filter((op) => !known.has(op.id) &&
        !(op.type === "create" && createdIds.has(op.sample.id)));
      let added;
      try {
        if (carry.length) appendOps(merged, carry);
        added = appendOps(merged, batch);
      } catch (err) {
        this.lastWriteFailed = true;
        throw err;
      }
      maybeFold(merged, this.foldThreshold);
      this._persist(merged);
      this.doc = merged;
      this.pending = this.pending.filter((p) => !batch.includes(p) && !dropped.includes(p));
      this._refreshSnapshotsStamps();
      this._emit({ type: "commit", added, dropped });
      return { added, dropped };
    }

    // 浏览器入口：先入待办队列（视图立即可见），再在跨标签页锁内顺序落账。
    // 写失败时待办原样保留，编号不分配；重试 flush 沿用首次的同一批操作。
    stage(op) {
      this.pending.push(op);
      const result = this.flush();
      return result.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error, pending: true })
      );
    }

    flush() {
      if (!this._flushChain) {
        this._flushChain = Promise.resolve()
          .then(() => this.lock(() => this._commitPending()))
          .then(
            (result) => {
              this._flushChain = null;
              this.flushError = null;
              return result;
            },
            (error) => {
              // 链失败后允许下一次 flush 重试；待办未被移除。
              this._flushChain = null;
              this.flushError = error;
              this.lastWriteFailed = true;
              this._emit({ type: "flush-failed", error });
              throw error;
            }
          );
      }
      return this._flushChain;
    }

    // 测试/同步场景用：等所有排队提交结束。
    whenFlushed() {
      return this._flushChain || Promise.resolve();
    }

    // 失败后续作：沿用首次提交的同一批操作（同 id、同载荷、同 baseSeq）。
    retry() {
      if (!this.pending.length) return Promise.resolve({ ok: true, added: [], dropped: [] });
      return this.flush().then(
        (result) => ({ ok: true, ...result }),
        (error) => ({ ok: false, error, pending: true })
      );
    }

    _commitPending() {
      if (!this.pending.length) return Promise.resolve({ added: [], dropped: [] });
      const batch = this.pending.slice();
      const result = this.commit(batch);
      return Promise.resolve(result);
    }

    // 拉取另一标签页的写入（storage 事件触发）：并入已编号操作，
    // 本地待办保留并在新视图上重新投影；快照编号落后即失效。
    pull() {
      const fresh = parseCandidates([this.storage.getItem(this.key), this.storage.getItem(this.backupKey)]);
      if (!fresh.doc) return { changed: false };
      const incoming = fresh.doc;

      const cpIn = incoming.checkpoint ? incoming.checkpoint.seq : 0;
      const cpMine = this.doc.checkpoint ? this.doc.checkpoint.seq : 0;
      if (cpIn > cpMine) {
        const changed = incoming.seq !== this.doc.seq;
        this.doc = incoming;
        if (changed) this._refreshSnapshotsStamps();
        this._emit({ type: "pull", checkpoint: true });
        return { changed: true, checkpoint: true };
      }

      const knownIds = new Set(this.doc.log.map((op) => op.id));
      const newOps = incoming.log.filter((op) => !knownIds.has(op.id));

      // 无锁环境下若发生过并发提交：本地独有操作能并入对方文档就并入，
      // 否则以本地为准（对方下次 pull 会并过去）；有锁时 newOps 即全部差异。
      const localOnlyOps = this.doc.log.filter((op) => !incoming.log.some((q) => q.id === op.id));
      const incomingHasRoom = !localOnlyOps.some((op) =>
        op.type === "create" && incoming.checkpoint &&
        incoming.checkpoint.samples.some((s) => s.id === op.sample.id));

      if (localOnlyOps.length && incomingHasRoom &&
          (incoming.checkpoint || !this.doc.checkpoint) &&
          (cpIn === cpMine)) {
        appendOps(incoming, localOnlyOps);
      }

      let changed = false;
      if (newOps.length) {
        appendOps(this.doc, newOps);
        changed = true;
      }
      // 编号/结构对齐：同检查点基线上以更完整的一方为准。
      if (incoming.seq > this.doc.seq && localOnlyOps.length === 0) {
        this.doc = incoming;
        changed = true;
      } else if (incoming.checkpoint && JSON.stringify(incoming.checkpoint) !== JSON.stringify(this.doc.checkpoint)) {
        this.doc.checkpoint = incoming.checkpoint;
        this.doc.seq = Math.max(this.doc.seq, incoming.seq);
        changed = true;
      } else if (incoming.seq > this.doc.seq) {
        this.doc.seq = incoming.seq;
        changed = true;
      }
      if (changed) {
        this._refreshSnapshotsStamps();
        this._emit({ type: "pull", newOps });
      }
      return { changed, newOps };
    }

    // 冲突裁决：保留选中版本（或填写新值），裁决本身也是带编号的操作。
    resolve(conflict, versionChoice, editedValue) {
      const op = makeResolve(
        conflict.sampleId,
        conflict.field || DELETE_FIELD,
        versionChoice.opId,
        editedValue !== undefined ? editedValue : versionChoice.value,
        this.doc.seq + this.pending.length,
        this.clientId
      );
      return this.stage(op);
    }

    _currentSeq() {
      return this.doc.seq + this.pending.length;
    }

    _refreshSnapshotsStamps() {
      for (const key of Object.keys(this._snapshots)) {
        const snap = this._snapshots[key];
        if (snap) snap.stale = snap.sourceSeq !== this._currentSeq();
      }
    }

    // 派生快照：样本信息一变（编号前进），旧快照标记失效并在取用处重算。
    getSnapshot(kind) {
      const builder = kind === "compare" ? buildCompareSnapshot : buildExportSnapshot;
      const seq = this._currentSeq();
      const cached = this._snapshots[kind];
      if (cached && cached.sourceSeq === seq) return { snapshot: cached, stale: false };
      const snapshot = builder(this.view());
      snapshot.computedAt = new Date().toISOString();
      this._snapshots[kind] = snapshot;
      return { snapshot, stale: false, recomputed: true };
    }

    invalidateSnapshots() {
      this._snapshots = { compare: null, export: null };
    }
  }

  return {
    STORAGE_VERSION,
    COMPARE_LIMIT,
    FIELDS,
    DELETE_FIELD,
    uuid,
    clone,
    deepEqual,
    makeCreate,
    makeUpdate,
    makeResolve,
    makeDelete,
    makeCompare,
    materialize,
    buildView,
    buildCompareSnapshot,
    buildExportSnapshot,
    appendOps,
    fold,
    maybeFold,
    isLegacy,
    migrateLegacy,
    emptyDoc,
    isValidDoc,
    normalizeDoc,
    parseCandidates,
    isCreateConflictError,
    Journal
  };
});
