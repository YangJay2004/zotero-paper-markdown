window.PaperMarkdownTaskCenter = {
  refreshTimer: null,

  init() {
    this.bind("paper-markdown-preview-bulk", () => this.previewBulk());
    this.bind("paper-markdown-start-queue", () => this.startQueue());
    this.bind("paper-markdown-retry-failed", () => this.retryFailed());
    this.bind("paper-markdown-stop-queue", () => this.stopQueue());
    this.bind("paper-markdown-preview-cleanup", () => this.previewCleanup());
    this.bind("paper-markdown-delete-cleanup", () => this.deleteCleanup());
    this.bind("paper-markdown-refresh-log", () => this.refreshStatus());
    this.bind("paper-markdown-clear-log", () => this.clearLog());

    let scope = document.getElementById("paper-markdown-bulk-scope");
    if (scope) {
      scope.addEventListener("change", () => {
        try {
          this.plugin.clearBulkPreview();
        }
        catch (error) {
          Zotero.logError(error);
        }
        this.setValue("paper-markdown-preview-details", "");
        this.refreshStatus();
      });
    }

    for (let id of ["paper-markdown-cleanup-scope", "paper-markdown-cleanup-target"]) {
      let element = document.getElementById(id);
      if (!element) continue;
      element.addEventListener("change", () => {
        try {
          this.plugin.clearCleanupPreview();
        }
        catch (error) {
          Zotero.logError(error);
        }
        this.setValue("paper-markdown-cleanup-details", "");
        this.refreshStatus();
      });
    }

    this.refreshStatus();
    this.refreshTimer = setInterval(() => this.refreshStatus(), 1500);
    window.addEventListener("unload", () => {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
    }, { once: true });
  },

  bind(id, handler) {
    let element = document.getElementById(id);
    if (!element) return;
    element.addEventListener("click", async () => {
      let failed = false;
      try {
        await handler();
      }
      catch (error) {
        failed = true;
        Zotero.logError(error);
        let statusID = this.getStatusElementForButton(id);
        if (statusID) {
          await this.setText(statusID, this.formatError(error));
        }
      }
      finally {
        if (!failed) {
          await this.refreshStatus();
        }
      }
    });
  },

  get plugin() {
    if (!Zotero.PaperMarkdown) {
      throw new Error("Paper Markdown is not loaded yet. Restart Zotero and try again.");
    }
    return Zotero.PaperMarkdown;
  },

  getScope() {
    return document.getElementById("paper-markdown-bulk-scope")?.value || "all";
  },

  getCleanupScope() {
    return document.getElementById("paper-markdown-cleanup-scope")?.value || "all";
  },

  getCleanupTarget() {
    return document.getElementById("paper-markdown-cleanup-target")?.value || "paperMarkdown";
  },

  getStatusElementForButton(buttonID) {
    if (buttonID.includes("cleanup")) return "paper-markdown-cleanup-status";
    return "paper-markdown-bulk-status";
  },

  async previewBulk() {
    let button = document.getElementById("paper-markdown-preview-bulk");
    button.disabled = true;
    await this.setL10n("paper-markdown-bulk-status", "paper-markdown-prefs-preview-running");
    try {
      let preview = await this.plugin.previewBulkConversion(this.getScope());
      await this.renderPreview(preview);
    }
    finally {
      button.disabled = false;
    }
  },

  async startQueue() {
    let button = document.getElementById("paper-markdown-start-queue");
    button.disabled = true;
    await this.setL10n("paper-markdown-bulk-status", "paper-markdown-prefs-queue-running");
    try {
      await this.plugin.startBulkQueueFromPreview();
    }
    catch (error) {
      await this.setText("paper-markdown-bulk-status", this.formatError(error));
      throw error;
    }
  },

  async retryFailed() {
    let button = document.getElementById("paper-markdown-retry-failed");
    button.disabled = true;
    await this.setL10n("paper-markdown-bulk-status", "paper-markdown-prefs-queue-retrying");
    try {
      await this.plugin.retryFailedTasks();
    }
    catch (error) {
      await this.setText("paper-markdown-bulk-status", this.formatError(error));
      throw error;
    }
  },

  async stopQueue() {
    this.plugin.stopQueueAfterCurrent();
    await this.refreshStatus();
  },

  async previewCleanup() {
    let button = document.getElementById("paper-markdown-preview-cleanup");
    button.disabled = true;
    await this.setL10n("paper-markdown-cleanup-status", "paper-markdown-prefs-cleanup-preview-running");
    try {
      let preview = await this.plugin.previewMarkdownCleanup(this.getCleanupScope(), this.getCleanupTarget());
      await this.renderCleanup({ status: "previewed", preview });
    }
    finally {
      button.disabled = false;
    }
  },

  async deleteCleanup() {
    let snapshot = this.plugin.getStatusSnapshot();
    let preview = snapshot.cleanup?.preview;
    if (!preview?.deleteCount) {
      await this.setL10n("paper-markdown-cleanup-status", "paper-markdown-prefs-cleanup-status-idle");
      return;
    }

    let message = await this.formatL10n("paper-markdown-prefs-cleanup-confirm", {
      count: preview.deleteCount,
      scope: preview.scopeLabel,
      target: preview.targetLabel
    });
    let confirmed = typeof Services !== "undefined" && Services.prompt
      ? Services.prompt.confirm(null, "Paper Markdown", message)
      : window.confirm(message);
    if (!confirmed) return;

    let button = document.getElementById("paper-markdown-delete-cleanup");
    button.disabled = true;
    await this.setL10n("paper-markdown-cleanup-status", "paper-markdown-prefs-cleanup-delete-running");
    try {
      let cleanup = await this.plugin.deleteMarkdownCleanupPreview();
      await this.renderCleanup(cleanup);
    }
    finally {
      button.disabled = false;
    }
  },

  async clearLog() {
    this.plugin.clearLogs();
    await this.refreshStatus();
  },

  async refreshStatus() {
    let snapshot;
    try {
      snapshot = this.plugin.getStatusSnapshot();
    }
    catch (error) {
      return;
    }

    if (snapshot.preview) {
      await this.renderPreview(snapshot.preview);
    }
    else {
      await this.setL10n("paper-markdown-bulk-status", "paper-markdown-prefs-convert-missing-status-idle");
    }
    await this.renderQueue(snapshot.queue);
    await this.renderCleanup(snapshot.cleanup);
    this.setValue("paper-markdown-log", snapshot.logs || "");
  },

  async renderPreview(preview) {
    await this.setL10n("paper-markdown-bulk-status", "paper-markdown-prefs-preview-done", {
      scope: preview.scopeLabel,
      total: preview.total,
      queued: preview.queued,
      converted: preview.converted,
      unavailable: preview.unavailable,
      onExisting: preview.onExisting
    });

    let lines = [
      `Scope: ${preview.scopeLabel}`,
      `Existing Markdown policy: ${preview.onExisting}`,
      `Total PDFs: ${preview.total}`,
      `Queued for conversion: ${preview.queued}`,
      `Already converted and skipped: ${preview.converted}`,
      `Unavailable: ${preview.unavailable}`,
      `  - Missing local PDFs: ${preview.missingLocal}`,
      `  - Standalone PDFs without parent items: ${preview.noParent}`,
      `  - Non-editable libraries: ${preview.notEditable}`,
      `  - Already running: ${preview.running}`,
      `  - Other errors: ${preview.errors}`
    ];
    if (preview.sample?.length) {
      lines.push("", "First queued PDFs:");
      for (let label of preview.sample) {
        lines.push(`- ${label}`);
      }
    }
    this.setValue("paper-markdown-preview-details", lines.join("\n"));
  },

  async renderQueue(queue) {
    let running = queue.status === "running";
    this.setDisabled("paper-markdown-start-queue", running || !this.plugin.lastBulkPreview?.pending?.length);
    this.setDisabled("paper-markdown-retry-failed", running || !queue.failed);
    this.setDisabled("paper-markdown-stop-queue", !running);

    if (queue.status === "idle") return;

    let lines = [
      "",
      `Queue status: ${queue.status}`,
      `Progress: ${queue.current}/${queue.total}`,
      `Converted: ${queue.converted}`,
      `Failed: ${queue.failed}`,
      `Skipped: ${queue.skipped}`
    ];
    if (queue.failedTasks?.length) {
      lines.push("", "Recent failures:");
      for (let task of queue.failedTasks) {
        lines.push(`- ${task.label}: ${task.error}`);
      }
    }

    let existing = document.getElementById("paper-markdown-preview-details")?.value || "";
    let previewPart = existing.split("\n\nQueue status:")[0];
    this.setValue("paper-markdown-preview-details", previewPart + lines.join("\n"));
  },

  async renderCleanup(cleanup) {
    if (!cleanup || cleanup.status === "idle") {
      await this.setL10n("paper-markdown-cleanup-status", "paper-markdown-prefs-cleanup-status-idle");
      this.setDisabled("paper-markdown-delete-cleanup", true);
      return;
    }

    if (cleanup.status === "previewed") {
      let preview = cleanup.preview;
      await this.setL10n("paper-markdown-cleanup-status", "paper-markdown-prefs-cleanup-preview-done", {
        scope: preview.scopeLabel,
        target: preview.targetLabel,
        total: preview.total,
        count: preview.deleteCount,
        skipped: preview.skipped
      });
      this.setDisabled("paper-markdown-delete-cleanup", !preview.deleteCount);

      let lines = [
        `Scope: ${preview.scopeLabel}`,
        `Target: ${preview.targetLabel}`,
        `Markdown attachments found: ${preview.total}`,
        `Ready to delete: ${preview.deleteCount}`,
        `Skipped by target filter: ${preview.skipped}`
      ];
      if (preview.sample?.length) {
        lines.push("", "First attachments to delete:");
        for (let label of preview.sample) {
          lines.push(`- ${label}`);
        }
      }
      this.setValue("paper-markdown-cleanup-details", lines.join("\n"));
      return;
    }

    let running = cleanup.status === "running";
    this.setDisabled("paper-markdown-delete-cleanup", true);
    await this.setL10n(
      "paper-markdown-cleanup-status",
      running ? "paper-markdown-prefs-cleanup-delete-running" : "paper-markdown-prefs-cleanup-delete-done",
      {
        total: cleanup.total,
        deleted: cleanup.deleted,
        failed: cleanup.failed,
        skipped: cleanup.skipped
      }
    );

    let lines = [
      `Cleanup status: ${cleanup.status}`,
      `Progress: ${cleanup.current}/${cleanup.total}`,
      `Deleted: ${cleanup.deleted}`,
      `Failed: ${cleanup.failed}`,
      `Skipped: ${cleanup.skipped}`
    ];
    if (cleanup.failedTasks?.length) {
      lines.push("", "Recent failures:");
      for (let task of cleanup.failedTasks) {
        lines.push(`- ${task.label}: ${task.error}`);
      }
    }
    this.setValue("paper-markdown-cleanup-details", lines.join("\n"));
  },

  setDisabled(id, disabled) {
    let element = document.getElementById(id);
    if (element) {
      element.disabled = Boolean(disabled);
    }
  },

  setValue(id, value) {
    let element = document.getElementById(id);
    if (element) {
      element.value = value;
    }
  },

  async setText(id, text) {
    let element = document.getElementById(id);
    if (element) {
      element.textContent = text;
    }
  },

  async setL10n(id, l10nID, args = {}) {
    let element = document.getElementById(id);
    if (!element) return;
    element.textContent = await this.formatL10n(l10nID, args);
  },

  async formatL10n(l10nID, args = {}) {
    if (document.l10n?.formatValue) {
      return document.l10n.formatValue(l10nID, args);
    }
    return l10nID;
  },

  formatError(error) {
    return error?.message || String(error);
  }
};
