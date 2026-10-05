/* 浏览器层：操作账驱动 UI。
 * - 每次录入/编辑/删除/对比/裁决都是一条带编号的操作，先入待办、再在锁内落账；
 * - storage 事件合并另一标签页的操作，同字段并发各留一版，在冲突面板待确认；
 * - 写失败保留待办，点击“重试”沿用首次的同一批操作；
 * - 对比/导出按操作编号生成快照，样本一变编号前进，旧快照失效重算。
 */
(function () {
  "use strict";

  const Core = window.JournalCore;
  const storageKey = "wxyy-2-thin-section-index";
  const clientKey = "wxyy-2.client-id";

  // 每个标签页独立 clientId（sessionStorage 不跨标签页共享），
  // 同一页内的连续编辑因此是“顺序”，两个标签页的编辑才能被识别为并发。
  let clientId = sessionStorage.getItem(clientKey);
  if (!clientId) {
    clientId = Core.uuid();
    sessionStorage.setItem(clientKey, clientId);
  }

  const webLock = (name, fn) =>
    navigator.locks && navigator.locks.request
      ? navigator.locks.request(name, fn)
      : fn();

  const journal = new Core.Journal(localStorage, storageKey, clientId, {
    foldThreshold: 50,
    lock: (fn) => webLock(storageKey + ".commit", fn)
  });

  const form = document.querySelector("#sampleForm");
  const photoInput = document.querySelector("#photoInput");
  const sampleGrid = document.querySelector("#sampleGrid");
  const comparePane = document.querySelector("#comparePane");
  const compareMeta = document.querySelector("#compareMeta");
  const mineralFilter = document.querySelector("#mineralFilter");
  const polarFilter = document.querySelector("#polarFilter");
  const conflictDock = document.querySelector("#conflictDock");
  const statusBar = document.querySelector("#statusBar");
  const seqBadge = document.querySelector("#seqBadge");
  const formTitle = document.querySelector("#formTitle");
  const submitBtn = document.querySelector("#submitBtn");
  const cancelEditBtn = document.querySelector("#cancelEditBtn");

  let pendingPhoto = "";
  let editingId = null;
  let lastCompareSnap = null;
  let pullTimer = null;

  const FIELD_LABELS = {
    photo: "显微照片",
    code: "样本编号",
    location: "采样地点",
    magnification: "放大倍数",
    polarization: "偏光类型",
    minerals: "主要矿物",
    texture: "颗粒结构",
    comment: "老师批注",
    __deleted: "删除状态"
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve("");
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.addEventListener("error", () => resolve(""));
      reader.readAsDataURL(file);
    });
  }

  function baseSeq() {
    return journal.doc.seq + journal.pending.length;
  }

  function pendingKindsFor(sampleId) {
    return journal.pending.filter((op) =>
      op.type === "create" && op.sample.id === sampleId ||
      (op.type !== "create" && op.sampleId === sampleId)
    );
  }

  function filteredSamples(view) {
    const mineral = mineralFilter.value.trim();
    const polarization = polarFilter.value;
    return view.samples.filter((sample) => {
      const mineralMatch = !mineral || (sample.minerals || "").includes(mineral);
      const polarMatch = !polarization || sample.polarization === polarization;
      return mineralMatch && polarMatch;
    });
  }

  function photoHtml(sample, alt) {
    if (sample.photo) return `<img src="${sample.photo}" alt="${esc(alt)}">`;
    return '<div class="photo-placeholder"></div>';
  }

  function renderCards(view) {
    const rows = filteredSamples(view);
    const conflictSampleIds = new Set(view.conflicts.map((c) => c.sampleId));

    sampleGrid.innerHTML = rows.length ? rows.map((sample) => {
      const pending = pendingKindsFor(sample.id);
      const badges = [];
      if (pending.length) badges.push('<span class="tag tag-pending">待落账</span>');
      if (conflictSampleIds.has(sample.id)) badges.push('<span class="tag tag-conflict">有待确认版本</span>');

      return `
      <article class="sample-card">
        ${photoHtml(sample, sample.code + "显微照片")}
        <div class="sample-body">
          <h3>${esc(sample.code)} ${badges.join(" ")}</h3>
          <p>${esc(sample.location || "未记录地点")} · ${esc(sample.magnification || "未记录倍数")} · ${esc(sample.polarization || "未记录偏光")}</p>
          <p>矿物：${esc(sample.minerals || "未记录")}</p>
          <p>结构：${esc(sample.texture || "未记录")}</p>
          <p>${esc(sample.comment || "未填写批注")}</p>
          <div class="card-actions">
            <label><input type="checkbox" data-compare="${sample.id}" ${view.compareIds.includes(sample.id) ? "checked" : ""}>对比</label>
            <span class="action-group">
              <button type="button" class="link" data-edit="${sample.id}">编辑</button>
              <button type="button" class="link danger" data-delete="${sample.id}">删除</button>
            </span>
          </div>
        </div>
      </article>`;
    }).join("") : "<p>还没有样本，先从左侧录入一张薄片照片。</p>";
  }

  function renderCompare(view) {
    const compareSamples = view.compare;
    comparePane.innerHTML = compareSamples.length ? compareSamples.map((sample) => `
      <article class="compare-item">
        ${sample.photo ? `<img src="${sample.photo}" alt="${esc(sample.code)}对比图">` : ""}
        <h3>${esc(sample.code)}</h3>
        <p>${esc(sample.polarization)} · ${esc(sample.minerals || "未记录矿物")}</p>
        <p>${esc(sample.texture || "未记录结构")}</p>
      </article>
    `).join("") : "<p>勾选两张样本卡片后可并排对比。</p>";

    if (lastCompareSnap) {
      const fresh = lastCompareSnap.sourceSeq === view.seq;
      compareMeta.textContent = fresh
        ? `对比快照 #${lastCompareSnap.sourceSeq}（最新）`
        : `对比快照 #${lastCompareSnap.sourceSeq} 已因样本变化失效，当前为 #${view.seq}，再次勾选即重算`;
      compareMeta.classList.toggle("stale", !fresh);
    } else {
      compareMeta.textContent = compareSamples.length
        ? `对比快照将按操作账 #${view.seq} 生成`
        : "";
    }
  }

  function versionHtml(version, field) {
    if (field === "photo" && version.value) {
      return `<span class="conf-photo"><img src="${version.value}" alt="冲突版本照片">来自标签页 ${esc(String(version.clientId).slice(0, 6))} · ${esc(new Date(version.ts).toLocaleString())}</span>`;
    }
    const text = field === "__deleted"
      ? (version.value ? "删除样本" : "保留样本（来自编辑）")
      : (version.value || "（空）");
    return `<span class="conf-value">${esc(text)}</span>`;
  }

  function renderConflicts(view) {
    if (!view.conflicts.length) {
      conflictDock.hidden = true;
      conflictDock.innerHTML = "";
      return;
    }
    conflictDock.hidden = false;
    conflictDock.innerHTML = `
      <h2>待确认版本（${view.conflicts.length}）</h2>
      <p class="conf-hint">两个标签页改了同一字段，两边内容都保留着，选定一版后会写入一条裁决操作。</p>
      ${view.conflicts.map((conflict, ci) => `
        <div class="conflict" data-conflict="${ci}">
          <strong>${esc(conflict.code)} · ${esc(FIELD_LABELS[conflict.kind === "deletion" ? "__deleted" : conflict.field])}</strong>
          ${conflict.versions.map((v, vi) => `
            <div class="conflict-version">
              ${versionHtml(v, conflict.kind === "deletion" ? "__deleted" : conflict.field)}
              <button type="button" class="link" data-resolve="${ci}:${vi}">保留这版</button>
            </div>`).join("")}
          <div class="conflict-custom">
            <input placeholder="或直接填写最终内容（删除冲突无需填写）" data-custom="${ci}">
            <button type="button" class="link" data-resolve-custom="${ci}">以此为准</button>
          </div>
        </div>`).join("")}
    `;
  }

  function renderStatus(view) {
    seqBadge.textContent = `操作账 #${view.seq}${journal.pending.length ? `（待落账 ${journal.pending.length}）` : ""}`;

    const notices = [];
    if (journal.migrated) notices.push({ cls: "notice-info", text: "旧记录首次打开：照片、批注和样本已补编号并入账，继续可用。" });
    if (journal.recoveredFrom === "backup") notices.push({ cls: "notice-warn", text: "主存写入不完整，已从最近检查点备份恢复，操作从最后编号续作。" });
    if (journal.recoveredFrom === "corrupt") notices.push({ cls: "notice-warn", text: "存储内容残缺，已抢救最近检查点，未确认的操作请重试。" });
    if (journal.recoveredFrom === "scratch") notices.push({ cls: "notice-warn", text: "本地状态无法读取，已从空账开始。" });
    if (journal.pending.length) {
      notices.push({
        cls: "notice-warn",
        html: `${journal.pending.length} 条操作尚未写入（${journal.lastWriteFailed ? "上次写入失败" : "等待写入"}）。<button type="button" class="link" id="retryBtn">重试</button>`
      });
    }

    if (!notices.length) {
      statusBar.hidden = true;
      statusBar.innerHTML = "";
      return;
    }
    statusBar.hidden = false;
    statusBar.innerHTML = notices.map((n) =>
      `<div class="notice ${n.cls}">${n.html || esc(n.text)}</div>`
    ).join("");
    const retryBtn = statusBar.querySelector("#retryBtn");
    if (retryBtn) retryBtn.addEventListener("click", () => { journal.retry().then(render); });
  }

  function render() {
    const view = journal.view();
    renderStatus(view);
    renderCards(view);
    renderCompare(view);
    renderConflicts(view);
  }

  function resetForm() {
    editingId = null;
    pendingPhoto = "";
    photoInput.value = "";
    form.reset();
    form.elements.sampleId.value = "";
    formTitle.textContent = "样本录入";
    submitBtn.textContent = "保存样本";
    cancelEditBtn.hidden = true;
  }

  function startEdit(sampleId) {
    const sample = journal.view().samples.find((s) => s.id === sampleId);
    if (!sample) return;
    editingId = sampleId;
    pendingPhoto = sample.photo || "";
    const fields = ["sampleId", "code", "location", "magnification", "polarization", "minerals", "texture", "comment"];
    fields.forEach((name) => { form.elements[name].value = name === "sampleId" ? sampleId : (sample[name] || ""); });
    formTitle.textContent = `编辑样本 ${sample.code}`;
    submitBtn.textContent = "保存修改";
    cancelEditBtn.hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  photoInput.addEventListener("change", async () => {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    if (photoInput.files[0] && !pendingPhoto) {
      pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
    }

    if (editingId) {
      const before = journal.view().samples.find((s) => s.id === editingId);
      const next = {
        code: data.get("code").trim(),
        location: data.get("location").trim(),
        magnification: data.get("magnification").trim(),
        polarization: data.get("polarization"),
        minerals: data.get("minerals").trim(),
        texture: data.get("texture").trim(),
        comment: data.get("comment").trim()
      };
      if (photoInput.files[0]) next.photo = pendingPhoto;
      const changes = {};
      for (const [field, value] of Object.entries(next)) {
        if ((before ? before[field] : "") !== value) changes[field] = value;
      }
      if (Object.keys(changes).length) {
        await journal.stage(Core.makeUpdate(editingId, baseSeq(), changes, clientId));
      }
    } else {
      const sample = {
        id: Core.uuid(),
        photo: pendingPhoto,
        code: data.get("code").trim(),
        location: data.get("location").trim(),
        magnification: data.get("magnification").trim(),
        polarization: data.get("polarization"),
        minerals: data.get("minerals").trim(),
        texture: data.get("texture").trim(),
        comment: data.get("comment").trim(),
        createdAt: new Date().toISOString()
      };
      await journal.stage(Core.makeCreate(sample, clientId));
    }

    resetForm();
    render();
  });

  cancelEditBtn.addEventListener("click", resetForm);

  sampleGrid.addEventListener("click", async (event) => {
    const deleteId = event.target.dataset.delete;
    const editId = event.target.dataset.edit;
    if (editId) {
      startEdit(editId);
      return;
    }
    if (deleteId) {
      const sample = journal.view().samples.find((s) => s.id === deleteId);
      if (sample && !window.confirm(`确定删除样本 ${sample.code}？若与另一标签页的编辑并发，会保留双方版本待确认。`)) return;
      await journal.stage(Core.makeDelete(deleteId, baseSeq(), clientId));
      if (editingId === deleteId) resetForm();
      render();
    }
  });

  sampleGrid.addEventListener("change", async (event) => {
    const id = event.target.dataset.compare;
    if (!id) return;
    const view = journal.view();
    let ids;
    if (event.target.checked) {
      ids = [id, ...view.compareIds.filter((item) => item !== id)].slice(0, Core.COMPARE_LIMIT);
    } else {
      ids = view.compareIds.filter((item) => item !== id);
    }
    // 勾选即生成/重算对比快照。
    const { snapshot } = journal.getSnapshot("compare");
    lastCompareSnap = snapshot;
    await journal.stage(Core.makeCompare(ids, baseSeq(), clientId));
    render();
  });

  conflictDock.addEventListener("click", async (event) => {
    const resolveKey = event.target.dataset.resolve;
    const customKey = event.target.dataset.resolveCustom;
    const view = journal.view();
    if (resolveKey) {
      const [ci, vi] = resolveKey.split(":").map(Number);
      const conflict = view.conflicts[ci];
      const choice = conflict && conflict.versions[vi];
      if (conflict && choice) {
        await journal.resolve(conflict, choice);
        render();
      }
    } else if (customKey !== undefined) {
      const ci = Number(customKey);
      const conflict = view.conflicts[ci];
      const input = conflictDock.querySelector(`[data-custom="${ci}"]`);
      const value = input.value.trim();
      if (conflict && conflict.kind === "field" && value) {
        await journal.resolve(conflict, conflict.versions[0], value);
        render();
      }
    }
  });

  [mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", render));

  document.querySelector("#exportBtn").addEventListener("click", () => {
    // 样本信息一变，编号前进；这里取到的快照必与当前视图一致（旧的会现场重算）。
    const { snapshot, recomputed } = journal.getSnapshot("export");
    const blob = new Blob([JSON.stringify(snapshot.checklist, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `thin-section-checklist-${snapshot.sourceSeq}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    seqBadge.title = recomputed ? `导出快照 #${snapshot.sourceSeq} 为重算结果` : `导出快照 #${snapshot.sourceSeq}`;
  });

  // 另一标签页写入：合并其编号操作，本地待办保留并重新排队落账。
  window.addEventListener("storage", (event) => {
    if (!event.key || ![storageKey, storageKey + ".__backup"].includes(event.key)) return;
    clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
      journal.pull();
      if (journal.pending.length) journal.flush().catch(() => {});
      render();
    }, 80);
  });

  journal.onSync(render);

  // 失败后首次交互即尝试一次续作；按钮也可手动重试。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && journal.pending.length) {
      journal.retry().then(render).catch(() => {});
    }
  });

  render();
})();
