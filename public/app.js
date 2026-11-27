(() => {
  const state = {
    projects: [],
    stats: null,
    recentDeployments: [],
    selectedProjectId: null,
    selectedProject: null,
    projectDeployments: [],
    selectedDeploymentId: null,
    activeLogStream: null,
    globalEventStream: null,
    rawLogs: "",
    slugManuallyEdited: false,
    serverInfo: null,
  };

  const COMMAND_PRESETS = {
    bun: `# Pull code mới nhất & cài packages
git pull origin main
bun install
# Build & reload process (vd: pm2 hoặc systemd)
bun run build`,
    node: `git pull origin main
npm ci
npm run build
pm2 reload all`,
    docker: `git pull origin main
docker compose build
docker compose up -d --remove-orphans`,
    script: {
      runMode: "script",
      commands: `echo "=== Deploying $DARKIN_PROJECT (build #$DARKIN_BUILD_NUMBER) ==="
git pull origin "$DARKIN_BRANCH"

COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "n/a")
echo "Current commit: $COMMIT"

if [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
  bun install --frozen-lockfile
elif [ -f "package-lock.json" ]; then
  npm ci
fi

# Thêm lệnh build / restart service của bạn tại đây
echo "Deploy finished!"`,
    },
    demo: () =>
      state.serverInfo?.platform === "win32"
        ? `echo === Darkin Deploy Test ===
bun --version
echo Project: %DARKIN_PROJECT% ^| Build #%DARKIN_BUILD_NUMBER%
echo Done!`
        : `echo "=== Darkin Deploy Test ==="
bun --version
echo "Project: $DARKIN_PROJECT | Build #$DARKIN_BUILD_NUMBER"
echo "Done!"`,
  };

  const $ = (id) => document.getElementById(id);

  // ---------- Utilities ----------
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function slugify(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "d")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return "—";
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
  }

  function formatRelativeTime(iso) {
    if (!iso) return "—";
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 10) return "vừa xong";
    if (diffSec < 60) return `${diffSec}s trước`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}p trước`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}g trước`;
    return new Date(iso).toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function statusLabel(status) {
    const map = {
      success: "Thành công",
      failed: "Thất bại",
      running: "Đang chạy",
      queued: "Hàng đợi",
      cancelled: "Đã hủy",
    };
    return map[status] || status;
  }

  function renderStatusBadge(status) {
    const dot =
      status === "running" || status === "queued"
        ? `<span class="spinner-dot"></span>`
        : "";
    return `<span class="badge badge-${escapeHtml(status)}">${dot}${escapeHtml(statusLabel(status))}</span>`;
  }

  function showToast(message, type = "info") {
    const container = $("toastContainer");
    const el = document.createElement("div");
    el.className = `toast ${type === "success" ? "toast-success" : type === "error" ? "toast-error" : ""}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.2s";
      setTimeout(() => el.remove(), 220);
    }, 3400);
  }

  async function apiFetch(path, options = {}) {
    const headers = {
      ...(options.headers || {}),
    };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
    });
    if (res.status === 401) {
      openAuthModal();
      throw new Error("Cần nhập DARKIN_TOKEN để xác thực");
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `HTTP ${res.status}`);
    }
    return data;
  }

  function openAuthModal(errorMsg = "") {
    $("authErrorText").textContent = errorMsg;
    $("authModal").classList.remove("hidden");
    setTimeout(() => $("authTokenInput").focus(), 30);
  }

  // ---------- Console Log Rendering ----------
  function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  }

  function formatLogChunkHtml(chunk) {
    const clean = stripAnsi(chunk);
    return clean
      .split("\n")
      .map((line, idx, arr) => {
        const escaped = escapeHtml(line);
        const suffix = idx < arr.length - 1 ? "\n" : "";
        if (line.startsWith("▶ [Step") || line.startsWith("▶ [Script")) {
          return `<span class="log-step">${escaped}</span>${suffix}`;
        }
        if (line.startsWith("✔ [Step") || line.startsWith("✔ [Script")) {
          return `<span class="log-ok">${escaped}</span>${suffix}`;
        }
        if (
          line.startsWith("✖ [Step") ||
          line.startsWith("✖ [Script") ||
          line.includes("[darkin] ERROR:")
        ) {
          return `<span class="log-err">${escaped}</span>${suffix}`;
        }
        if (line.startsWith("[darkin]")) {
          return `<span class="log-sys">${escaped}</span>${suffix}`;
        }
        return escaped + suffix;
      })
      .join("");
  }

  function setConsoleText(fullLogs) {
    state.rawLogs = fullLogs || "";
    const out = $("consoleOutput");
    out.innerHTML = state.rawLogs
      ? formatLogChunkHtml(state.rawLogs)
      : "Chưa có log output...";
    if ($("autoScrollToggle").checked) {
      out.scrollTop = out.scrollHeight;
    }
  }

  function appendConsoleText(chunk) {
    if (!chunk) return;
    const out = $("consoleOutput");
    if (!state.rawLogs) {
      out.innerHTML = "";
    }
    state.rawLogs += chunk;
    out.insertAdjacentHTML("beforeend", formatLogChunkHtml(chunk));
    if ($("autoScrollToggle").checked) {
      out.scrollTop = out.scrollHeight;
    }
  }

  // ---------- Data Loading ----------
  function applySystemInfo(info) {
    if (!info) return;
    state.serverInfo = info;
    if (info.runtime && info.platform) {
      $("runtimeBadge").textContent = `${info.runtime} · ${info.platform}`;
    }
    if (info.cwd && !$("projectWorkDirInput").placeholder.includes(info.cwd)) {
      $("projectWorkDirInput").placeholder = `VD: ${info.cwd}`;
    }
    if (info.authRequired) {
      $("logoutBtn").classList.remove("hidden");
    } else {
      $("logoutBtn").classList.add("hidden");
    }
  }

  async function loadOverview() {
    try {
      const [projRes, statsRes] = await Promise.all([
        apiFetch("/api/projects"),
        apiFetch("/api/stats"),
      ]);
      state.projects = projRes.projects || [];
      state.stats = statsRes.stats;
      state.recentDeployments = statsRes.recentDeployments || [];
      applySystemInfo(statsRes.system);
      renderStats();
      renderProjects();
      renderRecentActivity();
      return true;
    } catch (err) {
      if (!String(err.message).includes("DARKIN_TOKEN")) {
        showToast(err.message, "error");
      }
      return false;
    }
  }

  async function loadProjectDetail(projectId, autoSelectDeploymentId = null) {
    try {
      const data = await apiFetch(`/api/projects/${projectId}`);
      state.selectedProjectId = projectId;
      state.selectedProject = data.project;
      state.projectDeployments = data.deployments || [];

      $("overviewView").classList.add("hidden");
      $("detailView").classList.remove("hidden");

      renderProjectDetail();
      renderBuildsList();

      const targetDeployId =
        autoSelectDeploymentId ||
        (state.selectedDeploymentId &&
        state.projectDeployments.some((d) => d.id === state.selectedDeploymentId)
          ? state.selectedDeploymentId
          : state.projectDeployments[0]?.id || null);

      if (targetDeployId) {
        selectDeployment(targetDeployId);
      } else {
        closeLogStream();
        state.selectedDeploymentId = null;
        $("consoleBuildTitle").textContent = "Console Output";
        $("consoleStatusBadge").className = "badge hidden";
        $("consoleMetaText").textContent = "";
        $("cancelBuildBtn").classList.add("hidden");
        setConsoleText('Dự án này chưa có build nào. Bấm "Deploy ngay" để bắt đầu!');
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  // ---------- Rendering ----------
  function renderStats() {
    const s = state.stats || {
      projects: 0,
      running: 0,
      queued: 0,
      success: 0,
      failed: 0,
    };
    $("statProjects").textContent = String(s.projects);
    $("statRunning").textContent = `${s.running}${s.queued ? ` (+${s.queued})` : ""}`;
    $("statSuccess").textContent = String(s.success);
    $("statFailed").textContent = String(s.failed);
  }

  function renderProjects() {
    const query = ($("searchInput").value || "").trim().toLowerCase();
    const list = state.projects.filter((p) => {
      if (!query) return true;
      return (
        p.name.toLowerCase().includes(query) ||
        p.slug.toLowerCase().includes(query) ||
        p.workDir.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query)
      );
    });

    const grid = $("projectsGrid");
    const empty = $("emptyProjects");

    if (state.projects.length === 0) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");

    if (list.length === 0) {
      grid.innerHTML = `<div class="muted-center" style="grid-column:1/-1">Không tìm thấy dự án phù hợp với "${escapeHtml(query)}".</div>`;
      return;
    }

    grid.innerHTML = list
      .map((p) => {
        const last = p.lastDeployment;
        const statusBadge = last
          ? renderStatusBadge(last.status)
          : `<span class="badge badge-cancelled">Chưa chạy</span>`;

        const lastInfo = last
          ? `#${last.buildNumber} · ${formatRelativeTime(last.createdAt)} · ${formatDuration(last.durationMs)}`
          : "Chưa có lịch sử deploy";

        return `
          <article class="project-card">
            <div class="project-card-top">
              <div style="min-width:0">
                <button class="project-title-btn" type="button" data-open-project="${escapeHtml(p.id)}">
                  ${escapeHtml(p.name)}
                </button>
                <div class="project-slug-row">
                  <span class="chip chip-mono">/${escapeHtml(p.slug)}</span>
                  ${p.branch ? `<span class="chip chip-branch">⎇ ${escapeHtml(p.branch)}</span>` : ""}
                  ${p.runMode === "script" ? `<span class="chip chip-script">Script</span>` : ""}
                  ${p.autoDeploy ? `<span class="chip chip-auto">Webhook</span>` : ""}
                </div>
              </div>
              ${statusBadge}
            </div>

            ${p.description ? `<p class="project-desc">${escapeHtml(p.description)}</p>` : ""}

            <div class="project-path" title="${escapeHtml(p.workDir)}">${escapeHtml(p.workDir)}</div>

            <div class="project-last-build">
              <span>${escapeHtml(lastInfo)}</span>
              <span>${p.totalDeployments} builds</span>
            </div>

            <div class="project-card-actions">
              <button class="btn btn-primary btn-sm" type="button" data-deploy-project="${escapeHtml(p.id)}">
                ${p.isRunning ? "⏳ Thêm hàng đợi" : "▶ Deploy ngay"}
              </button>
              <button class="btn btn-ghost btn-sm" type="button" data-open-project="${escapeHtml(p.id)}">
                Logs
              </button>
              <button class="btn btn-ghost btn-sm" type="button" data-edit-project="${escapeHtml(p.id)}">
                Sửa
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderRecentActivity() {
    const el = $("recentActivityList");
    if (!state.recentDeployments.length) {
      el.innerHTML = `<div class="muted-center">Chưa có lượt deploy nào.</div>`;
      return;
    }

    el.innerHTML = state.recentDeployments
      .map(
        (d) => `
        <div class="activity-row" data-open-deployment="${escapeHtml(d.projectId)}:${escapeHtml(d.id)}">
          <div class="activity-main">
            ${renderStatusBadge(d.status)}
            <strong>${escapeHtml(d.projectName)}</strong>
            <span class="chip chip-mono">#${d.buildNumber}</span>
            <span class="muted-sm">${escapeHtml(d.trigger)} · ${escapeHtml(d.triggeredBy || "system")}</span>
          </div>
          <div class="activity-meta">
            <span>${formatDuration(d.durationMs)}</span>
            <span>${formatRelativeTime(d.createdAt)}</span>
          </div>
        </div>
      `
      )
      .join("");
  }

  function renderProjectDetail() {
    const p = state.selectedProject;
    if (!p) return;

    $("detailName").textContent = p.name;
    $("detailSlug").textContent = `/${p.slug}`;
    $("detailBranch").textContent = `⎇ ${p.branch || "*"}`;
    const isScript = p.runMode === "script";
    $("detailRunMode").textContent = isScript ? "Script Mode" : "Step Mode";
    $("detailRunMode").className = `chip ${isScript ? "chip-script" : ""}`;
    $("detailAutoDeploy").textContent = p.autoDeploy ? "Webhook: Bật" : "Webhook: Tắt";
    $("detailAutoDeploy").className = `chip ${p.autoDeploy ? "chip-auto" : ""}`;
    $("detailDescription").textContent = p.description || "Không có mô tả";
    $("detailWorkDir").textContent = p.workDir;
    $("detailShell").textContent = `${p.shell} · ${isScript ? "script" : "steps"} (timeout ${p.timeoutSec}s)`;

    if (p.repoUrl) {
      $("detailRepoWrap").classList.remove("hidden");
      $("detailRepo").textContent = p.repoUrl;
    } else {
      $("detailRepoWrap").classList.add("hidden");
    }

    const webhookUrl = `${window.location.origin}/webhook/${p.slug}`;
    $("webhookUrlInput").value = webhookUrl;
    $("webhookSecretInput").value = p.webhookSecret;
    $("webhookSecretInput").type = "password";
    $("toggleSecretBtn").textContent = "Hiện";
    $("webhookCurlInput").value =
      `curl -X POST "${webhookUrl}" -H "Content-Type: application/json" -H "x-webhook-secret: ${p.webhookSecret}" -d '{"branch":"${p.branch || "main"}"}'`;
  }

  function renderBuildsList() {
    const container = $("buildsList");
    if (!state.projectDeployments.length) {
      container.innerHTML = `<div class="muted-center">Chưa có build nào.</div>`;
      return;
    }

    container.innerHTML = state.projectDeployments
      .map((d) => {
        const activeClass = d.id === state.selectedDeploymentId ? "active" : "";
        return `
          <button type="button" class="build-item ${activeClass}" data-select-build="${escapeHtml(d.id)}">
            <div class="build-item-top">
              <span class="build-num">#${d.buildNumber}</span>
              ${renderStatusBadge(d.status)}
            </div>
            <div class="build-item-sub">
              <span>${escapeHtml(d.trigger)}</span>
              <span>${formatDuration(d.durationMs)} · ${formatRelativeTime(d.createdAt)}</span>
            </div>
            ${
              d.commitMessage
                ? `<div class="build-commit" title="${escapeHtml(d.commitMessage)}">${escapeHtml(d.commitMessage)}</div>`
                : ""
            }
          </button>
        `;
      })
      .join("");
  }

  // ---------- Live Log Stream (SSE) ----------
  function closeLogStream() {
    if (state.activeLogStream) {
      state.activeLogStream.close();
      state.activeLogStream = null;
    }
  }

  function updateConsoleHeader(dep) {
    if (!dep) return;
    $("consoleBuildTitle").textContent = `Build #${dep.buildNumber}`;
    const badge = $("consoleStatusBadge");
    badge.className = `badge badge-${dep.status}`;
    badge.innerHTML =
      dep.status === "running" || dep.status === "queued"
        ? `<span class="spinner-dot"></span>${escapeHtml(statusLabel(dep.status))}`
        : escapeHtml(statusLabel(dep.status));

    const parts = [];
    if (dep.trigger) parts.push(dep.trigger);
    if (dep.branch) parts.push(`branch: ${dep.branch}`);
    if (dep.durationMs !== null && dep.durationMs !== undefined) {
      parts.push(formatDuration(dep.durationMs));
    }
    if (dep.exitCode !== null && dep.exitCode !== undefined) {
      parts.push(`exit ${dep.exitCode}`);
    }
    $("consoleMetaText").textContent = parts.join(" · ");

    const cancelBtn = $("cancelBuildBtn");
    if (dep.status === "running" || dep.status === "queued") {
      cancelBtn.classList.remove("hidden");
    } else {
      cancelBtn.classList.add("hidden");
    }
  }

  function selectDeployment(deploymentId) {
    closeLogStream();
    state.selectedDeploymentId = deploymentId;
    renderBuildsList();

    const summary = state.projectDeployments.find((d) => d.id === deploymentId);
    if (summary) updateConsoleHeader(summary);
    setConsoleText("Đang tải logs...");

    const es = new EventSource(`/api/deployments/${deploymentId}/stream`);
    state.activeLogStream = es;

    es.addEventListener("init", (e) => {
      const data = JSON.parse(e.data);
      setConsoleText(data.logs || "");
      const current = state.projectDeployments.find((d) => d.id === deploymentId);
      updateConsoleHeader({ ...(current || {}), ...data });
    });

    es.addEventListener("log", (e) => {
      const data = JSON.parse(e.data);
      appendConsoleText(data.chunk || "");
    });

    es.addEventListener("status", (e) => {
      const data = JSON.parse(e.data);
      const item = state.projectDeployments.find((d) => d.id === deploymentId);
      if (item) {
        item.status = data.status;
        renderBuildsList();
        updateConsoleHeader(item);
      }
    });

    es.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      const item = state.projectDeployments.find((d) => d.id === deploymentId);
      if (item) {
        item.status = data.status;
        item.exitCode = data.exitCode;
        item.durationMs = data.durationMs;
        item.finishedAt = data.finishedAt;
        renderBuildsList();
        updateConsoleHeader(item);
      }
      closeLogStream();
    });

    es.onerror = () => {
      // Browser auto-reconnects if still active; ignore clean close
    };
  }

  // ---------- Global SSE for Real-time Dashboard ----------
  function connectGlobalEvents() {
    if (state.globalEventStream) {
      state.globalEventStream.close();
    }
    const es = new EventSource("/api/events");
    state.globalEventStream = es;

    const indicator = $("liveIndicator");
    const liveText = $("liveText");

    es.addEventListener("connected", () => {
      indicator.classList.remove("offline");
      liveText.textContent = "Live";
    });

    let refreshTimer = null;
    es.addEventListener("update", (e) => {
      const evt = JSON.parse(e.data);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void loadOverview();
        if (
          state.selectedProjectId &&
          (evt.projectId === state.selectedProjectId || !evt.projectId)
        ) {
          void refreshProjectDeploymentsOnly();
        }
      }, 200);
    });

    es.onerror = () => {
      indicator.classList.add("offline");
      liveText.textContent = "Đang kết nối lại...";
    };
  }

  async function refreshProjectDeploymentsOnly() {
    if (!state.selectedProjectId) return;
    try {
      const data = await apiFetch(`/api/projects/${state.selectedProjectId}`);
      state.selectedProject = data.project;
      state.projectDeployments = data.deployments || [];
      renderProjectDetail();
      renderBuildsList();
    } catch {
      // ignore
    }
  }

  // ---------- Project Actions ----------
  async function triggerDeploy(projectId, openAfter = true) {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ triggeredBy: "Dashboard UI" }),
      });
      showToast(`Đã đưa Build #${res.deployment.buildNumber} vào hàng đợi!`, "success");
      if (openAfter) {
        await loadProjectDetail(projectId, res.deployment.id);
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  function openProjectModal(project = null) {
    const isEdit = Boolean(project);
    $("projectModalTitle").textContent = isEdit
      ? `Chỉnh sửa: ${project.name}`
      : "Thêm dự án mới";
    $("saveProjectBtn").textContent = isEdit ? "Lưu thay đổi" : "Tạo dự án";
    $("projectIdField").value = project?.id || "";
    $("projectNameInput").value = project?.name || "";
    $("projectSlugInput").value = project?.slug || "";
    $("projectDescInput").value = project?.description || "";
    $("projectWorkDirInput").value = project?.workDir || state.serverInfo?.cwd || "";
    $("projectBranchInput").value = project?.branch ?? "main";
    $("projectRunModeInput").value = project?.runMode === "script" ? "script" : "steps";
    $("projectShellInput").value = project?.shell || "auto";
    $("projectTimeoutInput").value = project?.timeoutSec ?? 600;
    $("projectRepoInput").value = project?.repoUrl || "";
    $("projectCommandsInput").value = project?.commands || "";
    $("projectEnvInput").value = project?.envVars || "";
    $("projectAutoDeployInput").checked = project ? Boolean(project.autoDeploy) : true;
    $("projectSecretInput").value = project?.webhookSecret || "";
    $("dirCheckResult").innerHTML = "";

    state.slugManuallyEdited = isEdit;
    updateSlugPreview();
    updateRunModeHint();

    $("projectModal").classList.remove("hidden");
    setTimeout(() => $("projectNameInput").focus(), 30);
  }

  function closeProjectModal() {
    $("projectModal").classList.add("hidden");
  }

  function updateSlugPreview() {
    const slug = slugify($("projectSlugInput").value || $("projectNameInput").value);
    $("slugPreview").textContent = `/webhook/${slug || "ten-du-an"}`;
  }

  function updateRunModeHint() {
    const mode = $("projectRunModeInput").value;
    const label = $("commandsLabel");
    const textarea = $("projectCommandsInput");
    const hint = $("commandsHint");
    if (mode === "script") {
      label.innerHTML = 'Nội dung Shell Script (Script Mode) <span class="req">*</span>';
      textarea.placeholder =
        '#!/usr/bin/env bash\n# Chạy nguyên script trong 1 phiên shell duy nhất\ncd app\nTAG=$(git rev-parse --short HEAD)\necho "Deploying $TAG"';
      hint.innerHTML =
        'Chạy toàn bộ nội dung như một <strong>file script duy nhất</strong> (giữ nguyên <code>cd</code>, biến <code>$VAR</code>, <code>if/else</code>, <code>for</code>, hỗ trợ shebang <code>#!</code> và tự dừng khi có lệnh lỗi với <code>bash -e -o pipefail</code>).';
    } else {
      label.innerHTML = 'Các lệnh Deploy (Pipeline Steps) <span class="req">*</span>';
      textarea.placeholder =
        "# Mỗi dòng là 1 step, dừng ngay nếu step lỗi\ngit pull origin main\nbun install\nbun run build";
      hint.innerHTML =
        'Mỗi dòng là một bước chạy tuần tự qua <code>Bun.spawn</code>. Dòng bắt đầu bằng <code>#</code> sẽ được bỏ qua.';
    }
  }

  async function saveProjectForm(e) {
    e.preventDefault();
    const id = $("projectIdField").value.trim();
    const payload = {
      name: $("projectNameInput").value.trim(),
      slug: $("projectSlugInput").value.trim() || undefined,
      description: $("projectDescInput").value.trim(),
      workDir: $("projectWorkDirInput").value.trim(),
      branch: $("projectBranchInput").value.trim(),
      runMode: $("projectRunModeInput").value,
      shell: $("projectShellInput").value,
      timeoutSec: Number($("projectTimeoutInput").value) || 600,
      repoUrl: $("projectRepoInput").value.trim(),
      commands: $("projectCommandsInput").value.trim(),
      envVars: $("projectEnvInput").value,
      autoDeploy: $("projectAutoDeployInput").checked,
      webhookSecret: $("projectSecretInput").value.trim() || undefined,
    };

    const btn = $("saveProjectBtn");
    btn.disabled = true;
    try {
      let res;
      if (id) {
        res = await apiFetch(`/api/projects/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showToast("Đã cập nhật cấu hình dự án!", "success");
      } else {
        res = await apiFetch("/api/projects", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast(`Đã tạo dự án "${res.project.name}"!`, "success");
      }

      closeProjectModal();
      await loadOverview();
      if (state.selectedProjectId === res.project.id || !id) {
        await loadProjectDetail(res.project.id);
      }
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function checkWorkDir() {
    const path = $("projectWorkDirInput").value.trim();
    const resultEl = $("dirCheckResult");
    if (!path) {
      resultEl.innerHTML = `<span class="dir-err">Vui lòng nhập đường dẫn thư mục.</span>`;
      return;
    }

    resultEl.textContent = "Đang kiểm tra...";
    try {
      const res = await apiFetch("/api/utils/check-dir", {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      if (!res.exists) {
        resultEl.innerHTML = `<span class="dir-err">✖ Thư mục chưa tồn tại trên server.</span>`;
      } else if (!res.isDirectory) {
        resultEl.innerHTML = `<span class="dir-err">✖ Đường dẫn này là file, không phải thư mục.</span>`;
      } else {
        const gitInfo = res.isGit
          ? ` · Git repo (branch: <strong>${escapeHtml(res.branch || "unknown")}</strong>)`
          : " · Không phải Git repo";
        resultEl.innerHTML = `<span class="dir-ok">✔ Thư mục hợp lệ${gitInfo}</span>`;
        if (res.isGit && res.branch) {
          $("projectBranchInput").value = res.branch;
        }
      }
    } catch (err) {
      resultEl.innerHTML = `<span class="dir-err">✖ ${escapeHtml(err.message)}</span>`;
    }
  }

  // ---------- Event Wiring ----------
  function bindEvents() {
    $("brandHomeBtn").addEventListener("click", goHome);
    $("backToOverviewBtn").addEventListener("click", goHome);
    $("addProjectBtn").addEventListener("click", () => openProjectModal(null));
    $("emptyAddBtn").addEventListener("click", () => openProjectModal(null));
    $("refreshBtn").addEventListener("click", () => loadOverview());
    $("searchInput").addEventListener("input", renderProjects);

    // Modal controls
    $("closeProjectModalBtn").addEventListener("click", closeProjectModal);
    $("cancelProjectModalBtn").addEventListener("click", closeProjectModal);
    $("projectModal").addEventListener("click", (e) => {
      if (e.target === $("projectModal")) closeProjectModal();
    });
    $("projectForm").addEventListener("submit", saveProjectForm);

    $("projectNameInput").addEventListener("input", () => {
      if (!state.slugManuallyEdited) {
        $("projectSlugInput").value = slugify($("projectNameInput").value);
      }
      updateSlugPreview();
    });
    $("projectSlugInput").addEventListener("input", () => {
      state.slugManuallyEdited = true;
      updateSlugPreview();
    });
    $("projectRunModeInput").addEventListener("change", updateRunModeHint);
    $("checkDirBtn").addEventListener("click", checkWorkDir);

    // Command Presets
    document.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-preset");
        const preset = COMMAND_PRESETS[key];
        if (preset) {
          if (typeof preset === "object" && preset.commands) {
            $("projectCommandsInput").value = preset.commands;
            if (preset.runMode) {
              $("projectRunModeInput").value = preset.runMode;
              updateRunModeHint();
            }
          } else {
            $("projectCommandsInput").value =
              typeof preset === "function" ? preset() : preset;
          }
          showToast(`Đã áp dụng mẫu lệnh "${btn.textContent}"`);
        }
      });
    });

    // Delegated clicks on Projects Grid
    $("projectsGrid").addEventListener("click", (e) => {
      const openBtn = e.target.closest("[data-open-project]");
      if (openBtn) {
        void loadProjectDetail(openBtn.getAttribute("data-open-project"));
        return;
      }
      const deployBtn = e.target.closest("[data-deploy-project]");
      if (deployBtn) {
        void triggerDeploy(deployBtn.getAttribute("data-deploy-project"), true);
        return;
      }
      const editBtn = e.target.closest("[data-edit-project]");
      if (editBtn) {
        const id = editBtn.getAttribute("data-edit-project");
        const proj = state.projects.find((p) => p.id === id);
        if (proj) openProjectModal(proj);
      }
    });

    // Delegated clicks on Recent Activity
    $("recentActivityList").addEventListener("click", (e) => {
      const row = e.target.closest("[data-open-deployment]");
      if (!row) return;
      const [projectId, deployId] = row.getAttribute("data-open-deployment").split(":");
      void loadProjectDetail(projectId, deployId);
    });

    // Detail View actions
    $("detailDeployBtn").addEventListener("click", () => {
      if (state.selectedProjectId) void triggerDeploy(state.selectedProjectId, true);
    });

    $("detailEditBtn").addEventListener("click", () => {
      if (state.selectedProject) openProjectModal(state.selectedProject);
    });

    $("detailWebhookToggleBtn").addEventListener("click", () => {
      $("webhookPanel").classList.toggle("hidden");
    });

    $("detailDeleteBtn").addEventListener("click", async () => {
      const p = state.selectedProject;
      if (!p) return;
      if (!confirm(`Xóa dự án "${p.name}" và toàn bộ lịch sử deploy?`)) return;
      try {
        await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" });
        showToast(`Đã xóa dự án "${p.name}"`, "success");
        goHome();
        await loadOverview();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    $("toggleSecretBtn").addEventListener("click", () => {
      const input = $("webhookSecretInput");
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      $("toggleSecretBtn").textContent = hidden ? "Ẩn" : "Hiện";
    });

    $("regenSecretBtn").addEventListener("click", async () => {
      if (!state.selectedProjectId) return;
      if (!confirm("Tạo mới Webhook Secret? Các webhook cũ dùng secret cũ sẽ không còn hợp lệ.")) {
        return;
      }
      try {
        const res = await apiFetch(
          `/api/projects/${state.selectedProjectId}/regenerate-secret`,
          { method: "POST" }
        );
        state.selectedProject.webhookSecret = res.webhookSecret;
        renderProjectDetail();
        showToast("Đã tạo Webhook Secret mới!", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    $("testWebhookBtn").addEventListener("click", async () => {
      const p = state.selectedProject;
      if (!p) return;
      try {
        const res = await fetch(`/webhook/${p.slug}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-webhook-secret": p.webhookSecret,
          },
          body: JSON.stringify({
            branch: p.branch || "main",
            actor: "Webhook Test Button",
            message: "Test webhook trigger from Darkin UI",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Webhook failed");
        if (data.skipped) {
          showToast(`Webhook bị bỏ qua: ${data.reason}`);
        } else {
          showToast(data.message || "Webhook đã kích hoạt deploy!", "success");
          if (data.deployment?.id) {
            await loadProjectDetail(p.id, data.deployment.id);
          }
        }
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    document.querySelectorAll("[data-copy-target]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const target = $(btn.getAttribute("data-copy-target"));
        if (!target) return;
        await navigator.clipboard.writeText(target.value);
        showToast("Đã copy vào clipboard!", "success");
      });
    });

    // Builds sidebar
    $("buildsList").addEventListener("click", (e) => {
      const item = e.target.closest("[data-select-build]");
      if (!item) return;
      selectDeployment(item.getAttribute("data-select-build"));
    });

    $("clearHistoryBtn").addEventListener("click", async () => {
      if (!state.selectedProjectId) return;
      if (!confirm("Xóa toàn bộ lịch sử build đã hoàn thành của dự án này?")) return;
      try {
        const res = await apiFetch(
          `/api/projects/${state.selectedProjectId}/deployments`,
          { method: "DELETE" }
        );
        showToast(`Đã xóa ${res.cleared} bản ghi lịch sử`, "success");
        await loadProjectDetail(state.selectedProjectId);
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Console controls
    $("cancelBuildBtn").addEventListener("click", async () => {
      if (!state.selectedDeploymentId) return;
      try {
        await apiFetch(`/api/deployments/${state.selectedDeploymentId}/cancel`, {
          method: "POST",
        });
        showToast("Đã gửi yêu cầu hủy build!");
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    $("copyLogsBtn").addEventListener("click", async () => {
      await navigator.clipboard.writeText(state.rawLogs || "");
      showToast("Đã copy toàn bộ logs!", "success");
    });

    $("downloadLogsBtn").addEventListener("click", () => {
      const blob = new Blob([state.rawLogs || ""], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.selectedProject?.slug || "darkin"}-build-${state.selectedDeploymentId || "log"}.log`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Auth form (HttpOnly Cookie session login)
    $("authForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = $("authTokenInput").value.trim();
      const btn = $("authSubmitBtn");
      $("authErrorText").textContent = "";
      btn.disabled = true;
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          $("authErrorText").textContent = data.error || "Đăng nhập thất bại.";
          return;
        }
        $("authTokenInput").value = "";
        $("authModal").classList.add("hidden");
        const loaded = await loadOverview();
        if (loaded) connectGlobalEvents();
      } catch (err) {
        $("authErrorText").textContent = err.message || "Lỗi kết nối server.";
      } finally {
        btn.disabled = false;
      }
    });

    $("logoutBtn").addEventListener("click", async () => {
      closeLogStream();
      if (state.globalEventStream) {
        state.globalEventStream.close();
        state.globalEventStream = null;
      }
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => {});
      state.projects = [];
      state.recentDeployments = [];
      renderProjects();
      renderRecentActivity();
      openAuthModal();
    });

    // Escape closes modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("projectModal").classList.contains("hidden")) {
        closeProjectModal();
      }
    });
  }

  function goHome() {
    closeLogStream();
    state.selectedProjectId = null;
    state.selectedProject = null;
    state.selectedDeploymentId = null;
    $("detailView").classList.add("hidden");
    $("webhookPanel").classList.add("hidden");
    $("overviewView").classList.remove("hidden");
    void loadOverview();
  }

  // ---------- Init ----------
  // Clean up any legacy token from older versions
  try {
    localStorage.removeItem("darkin_token");
  } catch {
    // ignore
  }
  bindEvents();
  void loadOverview().then((ok) => {
    if (ok) connectGlobalEvents();
  });
})();
