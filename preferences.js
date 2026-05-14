window.PaperMarkdownPrefs = {
  init() {
    this.bind("paper-markdown-test-api", () => this.testAPI());
    this.bindChange("paper-markdown-auto-convert", () => this.syncAutoConvertNotifier());
    this.bindChange("paper-markdown-api-token", () => this.syncAutoConvertNotifier());
  },

  bind(id, handler) {
    let element = document.getElementById(id);
    if (!element) return;
    element.addEventListener("click", async () => {
      try {
        await handler();
      }
      catch (error) {
        Zotero.logError(error);
      }
    });
  },

  bindChange(id, handler) {
    let element = document.getElementById(id);
    if (!element) return;
    element.addEventListener("change", async () => {
      try {
        await handler();
      }
      catch (error) {
        Zotero.logError(error);
      }
    });
  },

  get plugin() {
    if (!Zotero.PaperMarkdown) {
      throw new Error("Paper Markdown is not loaded yet. Restart Zotero and try again.");
    }
    return Zotero.PaperMarkdown;
  },

  async testAPI() {
    let button = document.getElementById("paper-markdown-test-api");
    button.disabled = true;
    await this.setL10n("paper-markdown-test-api-status", "paper-markdown-prefs-test-api-running");
    try {
      let result = await this.plugin.testMinerUAPI();
      await this.setL10n("paper-markdown-test-api-status", "paper-markdown-prefs-test-api-success", {
        status: result.status
      });
    }
    catch (error) {
      await this.setL10n("paper-markdown-test-api-status", "paper-markdown-prefs-test-api-error", {
        message: this.formatError(error)
      });
      throw error;
    }
    finally {
      button.disabled = false;
    }
  },

  async syncAutoConvertNotifier() {
    this.plugin.syncAutoConvertNotifier();
  },

  async setL10n(id, l10nID, args = {}) {
    let element = document.getElementById(id);
    if (!element) return;

    if (document.l10n?.formatValue) {
      element.textContent = await document.l10n.formatValue(l10nID, args);
      return;
    }

    element.textContent = l10nID;
  },

  formatError(error) {
    return error?.message || String(error);
  }
};
