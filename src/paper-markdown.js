PaperMarkdown = {
  id: null,
  version: null,
  rootURI: null,
  menuIDs: [],
  itemPaneSectionID: null,
  standalonePanelID: "paper-markdown-standalone-panel",
  standaloneButtonID: "paper-markdown-standalone-button",
  standalonePanelRetryTimer: null,
  notifierID: null,
  runningAttachmentIDs: new Set(),
  autoConvertQueue: Promise.resolve(),
  autoSeenAttachmentIDs: new Set(),
  lastBulkPreview: null,
  lastCleanupPreview: null,
  cleanupState: null,
  queueState: null,
  activeConversionState: null,
  taskHistory: [],
  queueAbortRequested: false,
  logEntries: [],
  filenameWarningKeys: new Set(),

  PREF_PREFIX: "extensions.paper-markdown.",
  API_BASE: "https://mineru.net/api/v4",
  AUTO_CONVERT_DELAY_MS: 30000,
  AUTO_CONVERT_RECENT_WINDOW_MS: 10 * 60 * 1000,
  MAX_LOG_ENTRIES: 300,
  MAX_TASK_HISTORY: 120,
  DEFAULT_FILENAME_TEMPLATE: "{{ title case=\"true\" }} - {{ firstCreator etal=\"true\" }} - {{ year }}",
  MARKDOWN_ATTACHMENT_TITLE: "markdown-paper",
  MENU_LABELS: {
    openTaskCenter: {
      en: "Open Paper Markdown Panel",
      zh: "打开 Paper Markdown 面板"
    },
    root: {
      en: "Paper Markdown",
      zh: "Paper Markdown"
    },
    convertSelected: {
      en: "Convert selected PDFs to Markdown",
      zh: "转换选中 PDF 为 Markdown"
    },
    previewSelected: {
      en: "Preview selected PDFs",
      zh: "预览选中 PDF"
    },
    cleanSelected: {
      en: "Preview selected Markdown cleanup",
      zh: "预览选中 Markdown 清理"
    }
  },

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  },

  async start() {
    Zotero.PaperMarkdown = this;
    this.registerItemPaneSection();
    this.registerStandaloneTaskPanel();
    this.registerMenus();
    this.syncAutoConvertNotifier();
    this.log("Started");
  },

  shutdown() {
    if (Zotero.MenuManager) {
      for (let menuID of this.menuIDs) {
        Zotero.MenuManager.unregisterMenu(menuID);
      }
    }
    this.menuIDs = [];
    this.unregisterStandaloneTaskPanel();
    this.unregisterItemPaneSection();
    this.unregisterNotifier();
    this.runningAttachmentIDs.clear();
    this.autoSeenAttachmentIDs.clear();
    this.autoConvertQueue = Promise.resolve();
    this.queueAbortRequested = true;
    this.filenameWarningKeys.clear();
    if (Zotero.PaperMarkdown === this) {
      delete Zotero.PaperMarkdown;
    }
  },

  log(message) {
    this.recordLog("info", message);
    Zotero.debug("Paper Markdown: " + message);
  },

  warn(message) {
    this.recordLog("warn", message);
    Zotero.warn("Paper Markdown: " + message);
  },

  recordLog(level, message) {
    this.logEntries.push({
      time: new Date().toISOString(),
      level,
      message: String(message)
    });
    if (this.logEntries.length > this.MAX_LOG_ENTRIES) {
      this.logEntries.splice(0, this.logEntries.length - this.MAX_LOG_ENTRIES);
    }
  },

  getLogText() {
    if (!this.logEntries.length) {
      return "No Paper Markdown log entries yet.";
    }
    return this.logEntries
      .map(entry => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message}`)
      .join("\n");
  },

  clearLogs() {
    this.logEntries = [];
    this.log("Log cleared");
  },

  getMenuLabel(key) {
    let labels = this.MENU_LABELS[key] || {};
    let locale = "";
    try {
      locale = Zotero.locale || Services.locale?.appLocaleAsBCP47 || "";
    }
    catch (_) {
      locale = "";
    }
    return locale.toLowerCase().startsWith("zh") ? labels.zh || labels.en : labels.en || labels.zh || key;
  },

  setMenuLabel(context, key) {
    context.menuElem?.setAttribute("label", this.getMenuLabel(key));
  },

  getPluginIcon(size) {
    return `${this.rootURI}icons/paper-markdown-${size}.svg`;
  },

  registerItemPaneSection() {
    if (!Zotero.ItemPaneManager) {
      this.warn("Zotero.ItemPaneManager is unavailable; Paper Markdown side panel was not registered");
      return;
    }
    if (this.itemPaneSectionID) return;

    this.itemPaneSectionID = Zotero.ItemPaneManager.registerSection({
      paneID: "paper-markdown-task-center",
      pluginID: this.id,
      header: {
        l10nID: "paper-markdown-item-pane-header",
        icon: this.getPluginIcon(16)
      },
      sidenav: {
        l10nID: "paper-markdown-item-pane-header",
        icon: this.getPluginIcon(20),
        orderable: true
      },
      bodyXHTML: this.getTaskCenterBodyXHTML(),
      onInit: ({ doc, body, paneID }) => {
        this.labelTaskCenterSection(doc, body, paneID);
        this.bindTaskCenterPanel(body);
      },
      onDestroy: ({ body }) => {
        if (body._paperMarkdownRefreshTimer) {
          clearInterval(body._paperMarkdownRefreshTimer);
          body._paperMarkdownRefreshTimer = null;
        }
      },
      onItemChange: ({ item, setEnabled }) => {
        setEnabled(!!item || this.getSelectedItems().length > 0);
      },
      onRender: ({ doc, body, paneID }) => {
        this.labelTaskCenterSection(doc, body, paneID);
        this.bindTaskCenterPanel(body);
        this.refreshTaskCenterPanel(body);
      }
    });

    if (!this.itemPaneSectionID) {
      this.warn("Paper Markdown side panel registration failed");
    }
  },

  unregisterItemPaneSection() {
    if (this.itemPaneSectionID && Zotero.ItemPaneManager) {
      Zotero.ItemPaneManager.unregisterSection(this.itemPaneSectionID);
    }
    this.itemPaneSectionID = null;
  },

  registerStandaloneTaskPanel() {
    let attempts = 0;
    let tryRegister = () => {
      attempts++;
      try {
        let panel = this.ensureStandaloneTaskPanel();
        let doc = Zotero.getMainWindow?.()?.document;
        let button = doc?.getElementById(this.standaloneButtonID);
        if (panel?.isConnected && button?.isConnected && this.standalonePanelRetryTimer) {
          clearInterval(this.standalonePanelRetryTimer);
          this.standalonePanelRetryTimer = null;
        }
      }
      catch (error) {
        if (attempts >= 10) {
          if (this.standalonePanelRetryTimer) {
            clearInterval(this.standalonePanelRetryTimer);
            this.standalonePanelRetryTimer = null;
          }
          this.warn(`Standalone task panel was not registered: ${this.formatError(error)}`);
        }
      }
    };

    tryRegister();
    let doc = Zotero.getMainWindow?.()?.document;
    if (!doc?.getElementById(this.standalonePanelID) || !doc?.getElementById(this.standaloneButtonID)) {
      this.standalonePanelRetryTimer = setInterval(tryRegister, 750);
    }
  },

  unregisterStandaloneTaskPanel() {
    if (this.standalonePanelRetryTimer) {
      clearInterval(this.standalonePanelRetryTimer);
      this.standalonePanelRetryTimer = null;
    }

    let mainWindow = Zotero.getMainWindow?.();
    let doc = mainWindow?.document;
    if (!doc) return;

    let panel = doc.getElementById(this.standalonePanelID);
    if (panel?._paperMarkdownRefreshTimer) {
      clearInterval(panel._paperMarkdownRefreshTimer);
      panel._paperMarkdownRefreshTimer = null;
    }
    panel?.remove();
    doc.getElementById(this.standaloneButtonID)?.closest(".pin-wrapper")?.remove();
  },

  ensureStandaloneTaskPanel(mainWindow = Zotero.getMainWindow?.()) {
    if (!mainWindow) {
      throw new Error("Zotero main window is unavailable.");
    }

    let doc = mainWindow.document;
    let deck = doc.getElementById("zotero-item-pane-content");
    if (!deck) {
      throw new Error("Zotero item pane deck is unavailable.");
    }

    let panel = doc.getElementById(this.standalonePanelID);
    if (!panel) {
      panel = doc.createXULElement("vbox");
      panel.id = this.standalonePanelID;
      panel.setAttribute("flex", "1");
      panel.setAttribute("data-paper-markdown-standalone", "true");
      panel.style.cssText = "overflow-y: auto; padding: 10px 14px; box-sizing: border-box;";

      let fragment = mainWindow.MozXULElement.parseXULToFragment(this.getTaskCenterBodyXHTML());
      panel.append(fragment);
      deck.append(panel);

      this.bindTaskCenterPanel(panel);
      this.refreshTaskCenterPanel(panel);
    }

    this.ensureStandaloneSidenavButton(mainWindow);
    return panel;
  },

  ensureStandaloneSidenavButton(mainWindow = Zotero.getMainWindow?.()) {
    let doc = mainWindow?.document;
    if (!doc || doc.getElementById(this.standaloneButtonID)) return;

    let sidenav = doc.getElementById("zotero-view-item-sidenav");
    let buttonContainer = sidenav?.querySelector?.(".inherit-flex");
    if (!buttonContainer) return;

    let wrapper = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wrapper.className = "pin-wrapper paper-markdown-standalone-wrapper";
    wrapper.hidden = false;

    let button = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    button.id = this.standaloneButtonID;
    button.className = "btn paper-markdown-standalone-sidenav-button";
    button.setAttribute("tabindex", "0");
    button.setAttribute("role", "tab");
    button.setAttribute("title", "Paper Markdown");
    button.setAttribute("aria-label", "Paper Markdown");
    button.style.cssText = [
      `background: url('${this.getPluginIcon(20)}') center / 20px 20px no-repeat`,
      "width: 28px",
      "height: 28px",
      "margin: 2px 0",
      "border-radius: 5px",
      "cursor: pointer",
      "fill: currentColor",
      "-moz-context-properties: fill, fill-opacity, stroke, stroke-opacity"
    ].join("; ");

    let open = event => {
      event.preventDefault();
      event.stopPropagation();
      this.openTaskCenter().catch(error => Zotero.logError(error));
    };
    button.addEventListener("click", open);
    button.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        open(event);
      }
    });

    wrapper.append(button);
    buttonContainer.append(wrapper);
  },

  showStandaloneTaskPanel(mainWindow = Zotero.getMainWindow?.()) {
    let panel = this.ensureStandaloneTaskPanel(mainWindow);
    let doc = mainWindow.document;
    let itemPane = doc.getElementById("zotero-item-pane");
    let deck = doc.getElementById("zotero-item-pane-content");

    if (itemPane && "collapsed" in itemPane) {
      itemPane.collapsed = false;
    }

    if (deck) {
      deck.selectedPanel = panel;
      let selectedIndex = Array.from(deck.children).indexOf(panel);
      if (selectedIndex > -1) {
        deck.selectedIndex = selectedIndex;
      }
    }

    this.refreshTaskCenterPanel(panel);
    panel.querySelector('[data-paper-markdown-field="bulkStatus"]')?.focus?.();
    this.updateStandaloneButtonSelected(doc, true);
    return panel;
  },

  updateStandaloneButtonSelected(doc, selected) {
    let button = doc?.getElementById(this.standaloneButtonID);
    if (!button) return;

    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.style.backgroundColor = selected ? "var(--fill-quinary, rgba(128,128,128,.16))" : "";
  },

  getTaskCenterBodyXHTML() {
    return `
      <html:div xmlns:html="http://www.w3.org/1999/xhtml" class="paper-markdown-panel">
        <html:style>
          .paper-markdown-panel { display: grid; gap: 12px; padding: 2px 0 10px; }
          .paper-markdown-panel h3 { margin: 0 0 6px; font-size: 1em; }
          .paper-markdown-panel label { display: grid; gap: 4px; font-size: 0.95em; }
          .paper-markdown-panel select,
          .paper-markdown-panel input,
          .paper-markdown-panel button,
          .paper-markdown-panel textarea { box-sizing: border-box; width: 100%; max-width: 100%; }
          .paper-markdown-panel input[type="checkbox"] { width: auto; }
          .paper-markdown-panel textarea { min-height: 92px; resize: vertical; font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
          .paper-markdown-panel .paper-markdown-panel-card { display: grid; gap: 8px; padding: 10px 0; border-top: 1px solid var(--fill-quinary, rgba(128,128,128,.25)); }
          .paper-markdown-panel .paper-markdown-panel-row { display: grid; gap: 6px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
          .paper-markdown-panel .paper-markdown-panel-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); }
          .paper-markdown-panel .paper-markdown-checkbox-row { display: grid; gap: 6px; grid-template-columns: 1fr; }
          .paper-markdown-panel .paper-markdown-checkbox-row label { display: flex; align-items: center; gap: 6px; }
          .paper-markdown-panel .paper-markdown-panel-status { color: var(--fill-secondary); line-height: 1.35; }
          .paper-markdown-panel .paper-markdown-panel-note { color: var(--fill-secondary); line-height: 1.35; margin: 0; }
          .paper-markdown-panel .paper-markdown-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
          .paper-markdown-panel .paper-markdown-stat { padding: 7px 8px; border-radius: 6px; background: var(--fill-senary, rgba(128,128,128,.08)); border: 1px solid var(--fill-quinary, rgba(128,128,128,.18)); }
          .paper-markdown-panel .paper-markdown-stat-value { display: block; font-size: 1.15em; font-weight: 600; color: var(--fill-primary); }
          .paper-markdown-panel .paper-markdown-stat-label { display: block; color: var(--fill-secondary); font-size: .86em; line-height: 1.25; }
          .paper-markdown-panel .paper-markdown-progress { display: grid; gap: 5px; }
          .paper-markdown-panel progress { width: 100%; height: 12px; }
          .paper-markdown-panel .paper-markdown-progress-label { color: var(--fill-secondary); line-height: 1.35; overflow-wrap: anywhere; }
          .paper-markdown-panel .paper-markdown-progress-label strong { color: var(--fill-primary); font-weight: 600; }
          .paper-markdown-panel .paper-markdown-preview-list { display: grid; gap: 10px; }
          .paper-markdown-panel .paper-markdown-preview-group { display: grid; gap: 6px; }
          .paper-markdown-panel .paper-markdown-preview-group-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; color: var(--fill-primary); }
          .paper-markdown-panel .paper-markdown-preview-scroll { display: grid; gap: 6px; max-height: 360px; overflow-y: auto; padding-right: 3px; }
          .paper-markdown-panel .paper-markdown-preview-count { color: var(--fill-secondary); font-weight: 500; font-size: .88em; white-space: nowrap; }
          .paper-markdown-panel .paper-markdown-preview-item { display: grid; gap: 5px; padding: 8px; border-radius: 6px; border: 1px solid var(--fill-quinary, rgba(128,128,128,.18)); background: var(--fill-senary, rgba(128,128,128,.07)); }
          .paper-markdown-panel .paper-markdown-preview-title { font-weight: 600; color: var(--fill-primary); line-height: 1.25; overflow-wrap: anywhere; }
          .paper-markdown-panel .paper-markdown-preview-row { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 7px; font-size: .9em; line-height: 1.3; }
          .paper-markdown-panel .paper-markdown-preview-label { color: var(--fill-secondary); }
          .paper-markdown-panel .paper-markdown-preview-value { color: var(--fill-primary); overflow-wrap: anywhere; }
          .paper-markdown-panel .paper-markdown-preview-more { color: var(--fill-secondary); font-size: .9em; line-height: 1.3; }
        </html:style>

        <html:section class="paper-markdown-panel-card">
          <html:h3>Prepare</html:h3>
          <html:div class="paper-markdown-panel-grid">
            <html:label>Scope
              <html:select data-paper-markdown-field="bulkScope">
                <html:option value="all">All library PDFs</html:option>
                <html:option value="collection">Current collection</html:option>
                <html:option value="selected">Selected items</html:option>
              </html:select>
            </html:label>
            <html:label>Model
              <html:select data-paper-markdown-field="modelVersion">
                <html:option value="vlm">vlm</html:option>
                <html:option value="pipeline">pipeline</html:option>
              </html:select>
            </html:label>
            <html:label>Language
              <html:select data-paper-markdown-field="language">
                <html:option value="ch">ch</html:option>
                <html:option value="en">en</html:option>
                <html:option value="ch_server">ch_server</html:option>
                <html:option value="chinese_cht">chinese_cht</html:option>
                <html:option value="japan">japan</html:option>
                <html:option value="korean">korean</html:option>
              </html:select>
            </html:label>
            <html:label>Existing Markdown
              <html:select data-paper-markdown-field="onExisting">
                <html:option value="skip">Skip</html:option>
                <html:option value="overwrite">Overwrite</html:option>
                <html:option value="version">Create new version</html:option>
              </html:select>
            </html:label>
            <html:label>Page ranges
              <html:input type="text" data-paper-markdown-field="pageRanges" placeholder="1-20,25"></html:input>
            </html:label>
            <html:label>Batch size
              <html:input type="number" min="1" max="50" step="1" data-paper-markdown-field="batchSize"></html:input>
            </html:label>
            <html:label>Parallel uploads
              <html:input type="number" min="1" max="50" step="1" data-paper-markdown-field="uploadConcurrency" title="How many prepared PDF files are uploaded to MinerU at the same time. Higher values can speed up uploads, but may hit local network or API throttling."></html:input>
            </html:label>
          </html:div>
          <html:div class="paper-markdown-checkbox-row">
            <html:label><html:input type="checkbox" data-paper-markdown-field="autoOCR"></html:input><html:span>Auto OCR from PDF text layer</html:span></html:label>
            <html:label><html:input type="checkbox" data-paper-markdown-field="isOCR"></html:input><html:span>Enable OCR manually</html:span></html:label>
            <html:label><html:input type="checkbox" data-paper-markdown-field="enableFormula"></html:input><html:span>Formula recognition</html:span></html:label>
            <html:label><html:input type="checkbox" data-paper-markdown-field="enableTable"></html:input><html:span>Table recognition</html:span></html:label>
            <html:label><html:input type="checkbox" data-paper-markdown-field="normalizeHeadings"></html:input><html:span>Normalize heading levels</html:span></html:label>
            <html:label><html:input type="checkbox" data-paper-markdown-field="tagConverted"></html:input><html:span>Tag parent items after conversion</html:span></html:label>
          </html:div>
        </html:section>

        <html:section class="paper-markdown-panel-card">
          <html:h3>Preview</html:h3>
          <html:div class="paper-markdown-panel-row">
            <html:button type="button" data-paper-markdown-action="previewBulk">Preview</html:button>
            <html:button type="button" data-paper-markdown-action="startQueue" disabled="disabled">Start Queue</html:button>
            <html:button type="button" data-paper-markdown-action="retryFailed" disabled="disabled">Retry Failed</html:button>
            <html:button type="button" data-paper-markdown-action="stopQueue" disabled="disabled">Stop After Batch</html:button>
          </html:div>
          <html:div class="paper-markdown-panel-status" data-paper-markdown-field="bulkStatus">Preview PDFs before starting a batch queue.</html:div>
          <html:div class="paper-markdown-stats" data-paper-markdown-field="bulkStats" hidden="hidden">
            <html:div class="paper-markdown-stat">
              <html:span class="paper-markdown-stat-value" data-paper-markdown-field="statQueued">0</html:span>
              <html:span class="paper-markdown-stat-label">Ready</html:span>
            </html:div>
            <html:div class="paper-markdown-stat">
              <html:span class="paper-markdown-stat-value" data-paper-markdown-field="statExisting">0</html:span>
              <html:span class="paper-markdown-stat-label">Existing</html:span>
            </html:div>
            <html:div class="paper-markdown-stat">
              <html:span class="paper-markdown-stat-value" data-paper-markdown-field="statSkipped">0</html:span>
              <html:span class="paper-markdown-stat-label">Skipped</html:span>
            </html:div>
            <html:div class="paper-markdown-stat">
              <html:span class="paper-markdown-stat-value" data-paper-markdown-field="statUnavailable">0</html:span>
              <html:span class="paper-markdown-stat-label">Unavailable</html:span>
            </html:div>
          </html:div>
          <html:div class="paper-markdown-progress" data-paper-markdown-field="conversionProgressBox" hidden="hidden">
            <html:progress data-paper-markdown-field="queueProgress" max="100" value="0"></html:progress>
            <html:div class="paper-markdown-progress-label" data-paper-markdown-field="queueProgressLabel"></html:div>
            <html:progress data-paper-markdown-field="taskProgress" max="100" value="0"></html:progress>
            <html:div class="paper-markdown-progress-label" data-paper-markdown-field="taskProgressLabel"></html:div>
          </html:div>
          <html:div class="paper-markdown-preview-list" data-paper-markdown-field="bulkPreviewList" hidden="hidden"></html:div>
          <html:textarea data-paper-markdown-field="bulkDetails" readonly="readonly"></html:textarea>
        </html:section>

        <html:section class="paper-markdown-panel-card">
          <html:h3>Review</html:h3>
          <html:div class="paper-markdown-panel-row">
            <html:button type="button" data-paper-markdown-action="copyFailureList" disabled="disabled">Copy Failures</html:button>
          </html:div>
          <html:div class="paper-markdown-panel-status" data-paper-markdown-field="reviewStatus">No completed queue yet.</html:div>
          <html:textarea data-paper-markdown-field="reviewDetails" readonly="readonly"></html:textarea>
        </html:section>

        <html:section class="paper-markdown-panel-card">
          <html:h3>Markdown Management</html:h3>
          <html:p class="paper-markdown-panel-note">Preview generated Markdown attachments before deleting anything.</html:p>
          <html:label>Scope
            <html:select data-paper-markdown-field="cleanupScope">
              <html:option value="all">All library Markdown</html:option>
              <html:option value="collection">Current collection</html:option>
              <html:option value="selected">Selected items</html:option>
            </html:select>
          </html:label>
          <html:label>Target
            <html:select data-paper-markdown-field="cleanupTarget">
              <html:option value="paperMarkdown">All Paper Markdown generated attachments</html:option>
              <html:option value="allMarkdown">All Markdown-like attachments</html:option>
            </html:select>
          </html:label>
          <html:div class="paper-markdown-panel-row">
            <html:button type="button" data-paper-markdown-action="previewCleanup">Preview Cleanup</html:button>
            <html:button type="button" data-paper-markdown-action="deleteCleanup" disabled="disabled">Delete Previewed</html:button>
            <html:button type="button" data-paper-markdown-action="copyCleanupList" disabled="disabled">Copy List</html:button>
          </html:div>
          <html:div class="paper-markdown-panel-status" data-paper-markdown-field="cleanupStatus">Preview cleanup before deleting Markdown attachments.</html:div>
          <html:textarea data-paper-markdown-field="cleanupDetails" readonly="readonly"></html:textarea>
        </html:section>

        <html:section class="paper-markdown-panel-card">
          <html:h3>Logs and Privacy</html:h3>
          <html:p class="paper-markdown-panel-note">PDFs are sent to MinerU only when conversion starts. The API token stays in local Zotero preferences.</html:p>
          <html:div class="paper-markdown-panel-row">
            <html:button type="button" data-paper-markdown-action="refreshLog">Refresh Log</html:button>
            <html:button type="button" data-paper-markdown-action="clearLog">Clear Log</html:button>
          </html:div>
          <html:textarea data-paper-markdown-field="log" readonly="readonly"></html:textarea>
        </html:section>
      </html:div>
    `;
  },

  labelTaskCenterSection(doc, body, paneID) {
    let label = "Paper Markdown";
    let section = body.closest("item-pane-custom-section")?.querySelector("collapsible-section");
    if (section) {
      section.label = label;
      section.setAttribute("label", label);
      section.removeAttribute("data-l10n-id");
    }

    try {
      let selector = `.btn[data-pane="${CSS.escape(paneID || this.itemPaneSectionID || "")}"]`;
      let button = doc.querySelector(selector);
      if (button) {
        button.setAttribute("tooltiptext", label);
        button.setAttribute("aria-label", label);
        button.removeAttribute("data-l10n-id");
      }
    }
    catch (_) {
      // Non-critical: section body still works if the sidenav label cannot be adjusted.
    }
  },

  bindTaskCenterPanel(body) {
    if (body._paperMarkdownBound) return;
    body._paperMarkdownBound = true;

    let action = name => body.querySelector(`[data-paper-markdown-action="${name}"]`);
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let value = name => field(name)?.value || "";

    this.initializeTaskCenterSettings(body);

    let run = (statusName, callback) => {
      return async () => {
        let status = field(statusName);
        let failed = false;
        try {
          await callback();
        }
        catch (error) {
          failed = true;
          Zotero.logError(error);
          if (status) status.textContent = this.formatError(error);
          this.warn(`${statusName} failed: ${this.formatError(error)}`);
        }
        finally {
          if (!failed) {
            this.refreshTaskCenterPanel(body);
          }
        }
      };
    };

    action("previewBulk")?.addEventListener("click", run("bulkStatus", async () => {
      field("bulkStatus").textContent = "Previewing PDFs...";
      let preview = await this.previewBulkConversion(value("bulkScope") || "all", this.getPanelConversionSettings(body));
      this.renderTaskCenterPreview(body, preview);
    }));

    action("startQueue")?.addEventListener("click", run("bulkStatus", async () => {
      field("bulkStatus").textContent = "Queue running...";
      await this.startBulkQueueFromPreview();
    }));

    action("retryFailed")?.addEventListener("click", run("bulkStatus", async () => {
      field("bulkStatus").textContent = "Retrying failed tasks...";
      await this.retryFailedTasks();
    }));

    action("stopQueue")?.addEventListener("click", run("bulkStatus", async () => {
      this.stopQueueAfterCurrent();
    }));

    action("previewCleanup")?.addEventListener("click", run("cleanupStatus", async () => {
      field("cleanupStatus").textContent = "Previewing cleanup...";
      let preview = await this.previewMarkdownCleanup(
        value("cleanupScope") || "all",
        value("cleanupTarget") || "paperMarkdown"
      );
      this.renderTaskCenterCleanup(body, { status: "previewed", preview });
    }));

    action("deleteCleanup")?.addEventListener("click", run("cleanupStatus", async () => {
      let snapshot = this.getStatusSnapshot();
      let preview = snapshot.cleanup?.preview;
      if (!preview?.deleteCount) {
        field("cleanupStatus").textContent = "Nothing to delete.";
        return;
      }
      let confirmed = Services.prompt.confirm(
        null,
        "Paper Markdown",
        `Delete ${preview.deleteCount} Markdown attachment(s) from ${preview.scopeLabel}? This only deletes the previewed attachments.`
      );
      if (!confirmed) return;
      field("cleanupStatus").textContent = "Deleting previewed Markdown attachments...";
      let cleanup = await this.deleteMarkdownCleanupPreview();
      this.renderTaskCenterCleanup(body, cleanup);
    }));

    action("copyCleanupList")?.addEventListener("click", run("cleanupStatus", async () => {
      let tasks = this.lastCleanupPreview?.pending || [];
      if (!tasks.length) {
        field("cleanupStatus").textContent = "Nothing to copy.";
        return;
      }
      this.copyText(tasks.map(task => this.formatCleanupTaskLabel(task)).join("\n"));
      field("cleanupStatus").textContent = `Copied ${tasks.length} cleanup preview item(s).`;
    }));

    action("copyFailureList")?.addEventListener("click", () => {
      let failures = this.getLatestFailureList();
      if (!failures.length) return;
      this.copyText(failures.map(task => `${task.label}: ${task.error}`).join("\n"));
      this.refreshTaskCenterPanel(body);
    });

    action("refreshLog")?.addEventListener("click", () => this.refreshTaskCenterPanel(body));
    action("clearLog")?.addEventListener("click", () => {
      this.clearLogs();
      this.refreshTaskCenterPanel(body);
    });

    for (let name of [
      "bulkScope", "modelVersion", "language", "onExisting", "pageRanges", "batchSize",
      "uploadConcurrency", "autoOCR", "isOCR", "enableFormula", "enableTable", "normalizeHeadings", "tagConverted",
      "cleanupScope", "cleanupTarget"
    ]) {
      field(name)?.addEventListener("change", () => {
        if (!name.startsWith("cleanup")) {
          this.clearBulkPreview();
          if (field("bulkDetails")) field("bulkDetails").value = "";
          if (field("bulkStats")) field("bulkStats").hidden = true;
          this.clearBulkPreviewList(body);
        }
        else {
          this.clearCleanupPreview();
          field("cleanupDetails").value = "";
        }
        this.refreshTaskCenterPanel(body);
      });
    }

    body._paperMarkdownRefresh = () => this.refreshTaskCenterPanel(body);
    body._paperMarkdownRefreshTimer = setInterval(() => this.refreshTaskCenterPanel(body), 1500);
  },

  initializeTaskCenterSettings(body) {
    if (body._paperMarkdownSettingsInitialized) return;
    body._paperMarkdownSettingsInitialized = true;

    let settings = this.getSettings();
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let setValue = (name, value) => {
      let element = field(name);
      if (!element) return;
      if (element.type === "checkbox") {
        element.checked = Boolean(value);
      }
      else {
        element.value = value;
      }
    };

    setValue("modelVersion", settings.modelVersion);
    setValue("language", settings.language);
    setValue("onExisting", settings.onExisting);
    setValue("pageRanges", settings.pageRanges);
    setValue("batchSize", settings.batchSize);
    setValue("uploadConcurrency", settings.uploadConcurrency);
    setValue("autoOCR", settings.autoOCR);
    setValue("isOCR", settings.isOCR);
    setValue("enableFormula", settings.enableFormula);
    setValue("enableTable", settings.enableTable);
    setValue("normalizeHeadings", settings.normalizeHeadings);
    setValue("tagConverted", settings.tagConverted);
  },

  getPanelConversionSettings(body) {
    let base = this.getSettings();
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let value = name => field(name)?.value || "";
    let checked = name => Boolean(field(name)?.checked);
    return {
      ...base,
      modelVersion: value("modelVersion") || base.modelVersion,
      language: value("language") || base.language,
      onExisting: value("onExisting") || base.onExisting,
      pageRanges: value("pageRanges").trim(),
      batchSize: this.clampInt(value("batchSize"), base.batchSize, 1, 50),
      uploadConcurrency: this.clampInt(value("uploadConcurrency"), base.uploadConcurrency, 1, 50),
      autoOCR: checked("autoOCR"),
      isOCR: checked("isOCR"),
      enableFormula: checked("enableFormula"),
      enableTable: checked("enableTable"),
      normalizeHeadings: checked("normalizeHeadings"),
      tagConverted: checked("tagConverted")
    };
  },

  refreshTaskCenterPanel(body) {
    if (!body?.isConnected) return;
    let snapshot = this.getStatusSnapshot();
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let action = name => body.querySelector(`[data-paper-markdown-action="${name}"]`);

    if (snapshot.preview) {
      this.renderTaskCenterPreview(body, snapshot.preview);
    }
    else {
      if (field("bulkStats")) field("bulkStats").hidden = true;
      this.clearBulkPreviewList(body);
      if (field("bulkDetails")) field("bulkDetails").value = "";
      field("bulkStatus").textContent = "Preview PDFs before starting a batch queue.";
    }

    this.renderTaskCenterQueue(body, snapshot.queue);
    this.renderConversionProgress(body, snapshot.queue, snapshot.activeConversion);
    this.renderTaskCenterReview(body, snapshot.queue, snapshot.history);
    this.renderTaskCenterCleanup(body, snapshot.cleanup);
    field("log").value = snapshot.logs || "";

    let queueRunning = snapshot.queue.status === "running";
    if (action("startQueue")) action("startQueue").disabled = queueRunning || !this.lastBulkPreview?.pending?.length;
    if (action("retryFailed")) action("retryFailed").disabled = queueRunning || !snapshot.queue.failed;
    if (action("stopQueue")) action("stopQueue").disabled = !queueRunning;
    if (action("copyCleanupList")) action("copyCleanupList").disabled = !snapshot.cleanup?.preview?.deleteCount;
    if (action("copyFailureList")) action("copyFailureList").disabled = !this.getLatestFailureList().length;
  },

  renderTaskCenterPreview(body, preview) {
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let stats = field("bulkStats");
      if (stats) {
        stats.hidden = false;
      field("statQueued").textContent = preview.readyNew ?? preview.queued;
      field("statExisting").textContent = preview.existing;
      field("statSkipped").textContent = preview.converted;
      field("statUnavailable").textContent = preview.unavailable;
    }
    field("bulkStatus").textContent =
      `${preview.scopeLabel}: ${preview.readyNew ?? preview.queued}/${preview.total} new, ${preview.existing} existing Markdown, ${preview.queued} queued by policy, ${preview.unavailable} unavailable. ${this.getPreviewRecommendation(preview)}`;
    this.renderBulkPreviewList(body, preview);

    let lines = [
      `Scope: ${preview.scopeLabel}`,
      `Existing Markdown policy: ${this.formatExistingPolicy(preview.onExisting)}`,
      `Model: ${preview.modelVersion}; Language: ${preview.language}`,
      `OCR: ${preview.autoOCR ? "auto" : (preview.isOCR ? "on" : "off")}; Formula: ${preview.enableFormula ? "on" : "off"}; Table: ${preview.enableTable ? "on" : "off"}`,
      `Batch: ${preview.batchSize}; Parallel uploads: ${preview.uploadConcurrency}`,
      `Total PDFs: ${preview.total}`,
      `Ready for conversion: ${preview.readyNew ?? preview.queued}`,
      `Queued by current policy: ${preview.queued}`,
      `Existing Markdown queued by policy: ${preview.queuedExisting || 0}`,
      `Existing Markdown detected: ${preview.existing}`,
      `Skipped because policy is skip: ${preview.converted}`,
      `Unavailable: ${preview.unavailable}`,
      `  - Missing local PDFs: ${preview.missingLocal}`,
      `  - Standalone PDFs without parent items: ${preview.noParent}`,
      `  - Non-editable libraries: ${preview.notEditable}`,
      `  - Already running: ${preview.running}`,
      `  - Other errors: ${preview.errors}`
    ];
    field("bulkDetails").value = lines.join("\n");
  },

  renderBulkPreviewList(body, preview) {
    let list = body.querySelector('[data-paper-markdown-field="bulkPreviewList"]');
    if (!list) return;
    if (list.dataset.paperMarkdownPreviewID === preview.id) {
      list.hidden = list.dataset.paperMarkdownPreviewRendered !== "true";
      return;
    }

    this.clearNode(list);
    list.dataset.paperMarkdownPreviewID = preview.id || "";
    let groups = [
      {
        title: "Ready for conversion",
        total: preview.readyNew ?? preview.queued,
        items: preview.readyItems || [],
        overflow: preview.readyOverflow || 0
      },
      {
        title: "Existing Markdown detected",
        total: preview.existing,
        items: preview.existingItems || [],
        overflow: preview.existingOverflow || 0
      },
      {
        title: "Unavailable PDFs",
        total: preview.unavailable,
        items: preview.unavailableItems || [],
        overflow: preview.unavailableOverflow || 0
      }
    ];

    let rendered = false;
    for (let group of groups) {
      if (!group.total) continue;
      this.appendPreviewGroup(list, group);
      rendered = true;
    }
    list.dataset.paperMarkdownPreviewRendered = rendered ? "true" : "false";
    list.hidden = !rendered;
  },

  appendPreviewGroup(container, group) {
    let doc = container.ownerDocument;
    let section = this.createHTMLElement(doc, "div", "paper-markdown-preview-group");
    let title = this.createHTMLElement(doc, "div", "paper-markdown-preview-group-title");
    let label = this.createHTMLElement(doc, "span", "", group.title);
    let count = this.createHTMLElement(doc, "span", "paper-markdown-preview-count", `${group.total} item(s)`);
    title.appendChild(label);
    title.appendChild(count);
    section.appendChild(title);

    let scroll = this.createHTMLElement(doc, "div", "paper-markdown-preview-scroll");
    for (let item of group.items) {
      scroll.appendChild(this.createPreviewItem(doc, item));
    }
    section.appendChild(scroll);
    if (group.overflow) {
      section.appendChild(this.createHTMLElement(
        doc,
        "div",
        "paper-markdown-preview-more",
        `Showing ${group.items.length} of ${group.total}; ${group.overflow} more not shown.`
      ));
    }
    container.appendChild(section);
  },

  createPreviewItem(doc, item) {
    let box = this.createHTMLElement(doc, "div", "paper-markdown-preview-item");
    box.appendChild(this.createHTMLElement(doc, "div", "paper-markdown-preview-title", item.title || "PDF"));
    this.appendPreviewRow(doc, box, "PDF", item.pdf);
    this.appendPreviewRow(doc, box, "Markdown", item.markdown);
    this.appendPreviewRow(doc, box, "Existing", item.existing);
    this.appendPreviewRow(doc, box, "Reason", item.reason);
    return box;
  },

  appendPreviewRow(doc, container, labelText, valueText) {
    if (!valueText) return;
    let row = this.createHTMLElement(doc, "div", "paper-markdown-preview-row");
    row.appendChild(this.createHTMLElement(doc, "span", "paper-markdown-preview-label", labelText));
    row.appendChild(this.createHTMLElement(doc, "span", "paper-markdown-preview-value", valueText));
    container.appendChild(row);
  },

  createHTMLElement(doc, tag, className = "", text = "") {
    let element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  },

  clearBulkPreviewList(body) {
    let list = body?.querySelector?.('[data-paper-markdown-field="bulkPreviewList"]');
    if (!list) return;
    this.clearNode(list);
    delete list.dataset.paperMarkdownPreviewID;
    delete list.dataset.paperMarkdownPreviewRendered;
    list.hidden = true;
  },

  clearNode(node) {
    while (node.firstChild) {
      node.firstChild.remove();
    }
  },

  getPreviewRecommendation(preview) {
    if (!preview.total) return "No PDFs found in this scope.";
    if (preview.queued) return "Ready to start.";
    if (preview.existing && preview.onExisting === "skip") return "Nothing new to convert with skip policy.";
    if (preview.unavailable) return "Some PDFs need local files or parent items first.";
    return "Nothing to convert.";
  },

  formatExistingPolicy(policy) {
    if (policy === "overwrite") return "overwrite existing Markdown";
    if (policy === "version") return "create a new Markdown version";
    return "skip PDFs with existing Markdown";
  },

  formatExistingActionReason(policy) {
    if (policy === "overwrite") return "Will overwrite existing Markdown";
    if (policy === "version") return "Will create a new Markdown version";
    return "Markdown already exists";
  },

  renderTaskCenterQueue(body, queue) {
    if (!queue || queue.status === "idle") return;
    let details = body.querySelector('[data-paper-markdown-field="bulkDetails"]');
    let lines = details.value ? details.value.split("\n") : [];
    let queueIndex = lines.findIndex(line => line.startsWith("Queue status:"));
    if (queueIndex > -1) {
      lines = lines.slice(0, Math.max(0, queueIndex - 1));
    }
    lines.push(
      "",
      `Queue status: ${queue.status}`,
      `Progress: ${queue.current}/${queue.total}`,
      `MinerU batch size: ${queue.batchSize || 1}`,
      `Upload concurrency: ${queue.uploadConcurrency || 1}`,
      `Converted: ${queue.converted}`,
      `Failed: ${queue.failed}`,
      `Skipped: ${queue.skipped}`
    );
    if (queue.failedTasks?.length) {
      lines.push("", "Recent failures:");
      for (let task of queue.failedTasks) {
        lines.push(`- ${task.label}: ${task.error}`);
      }
    }
    details.value = lines.join("\n");
  },

  renderConversionProgress(body, queue, activeConversion) {
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let box = field("conversionProgressBox");
    let queueProgress = field("queueProgress");
    let queueLabel = field("queueProgressLabel");
    let taskProgress = field("taskProgress");
    let taskLabel = field("taskProgressLabel");
    if (!box || !queueProgress || !queueLabel || !taskProgress || !taskLabel) return;

    let hasQueue = queue && queue.status !== "idle" && queue.total > 0;
    let hasActive = activeConversion && activeConversion.status && activeConversion.status !== "idle";
    if (!hasQueue && !hasActive) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    let queuePercent = hasQueue
      ? Math.max(0, Math.min(100, Math.round((queue.current / queue.total) * 100)))
      : 0;
    queueProgress.value = queuePercent;
    queueLabel.textContent = hasQueue
      ? `${queue.status}: ${queue.current}/${queue.total} PDFs, converted ${queue.converted}, failed ${queue.failed}, skipped ${queue.skipped}`
      : "Single conversion";

    let taskPercent = Number.isFinite(activeConversion?.percent)
      ? Math.max(0, Math.min(100, Math.round(activeConversion.percent)))
      : 0;
    taskProgress.value = taskPercent;
    taskLabel.textContent = hasActive
      ? `${activeConversion.label || "Current PDF"}: ${activeConversion.message || activeConversion.status}`
      : "Waiting for next PDF...";
  },

  renderTaskCenterCleanup(body, cleanup) {
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let action = name => body.querySelector(`[data-paper-markdown-action="${name}"]`);

    if (!cleanup || cleanup.status === "idle") {
      field("cleanupStatus").textContent = "Preview cleanup before deleting Markdown attachments.";
      action("deleteCleanup").disabled = true;
      let copyButton = action("copyCleanupList");
      if (copyButton) copyButton.disabled = true;
      return;
    }

    if (cleanup.status === "previewed") {
      let preview = cleanup.preview;
      field("cleanupStatus").textContent =
        `${preview.scopeLabel}: ${preview.deleteCount}/${preview.total} Markdown attachment(s) ready to delete.`;
      action("deleteCleanup").disabled = !preview.deleteCount;
      let copyButton = action("copyCleanupList");
      if (copyButton) copyButton.disabled = !preview.deleteCount;

      let lines = [
        `Scope: ${preview.scopeLabel}`,
        `Target: ${preview.targetLabel}`,
        `Markdown attachments scanned: ${preview.total}`,
        `Ready to delete: ${preview.deleteCount}`,
        `Skipped: ${preview.skipped}`
      ];
      if (preview.sample?.length) {
        lines.push("", "Previewed attachments:");
        for (let label of preview.sample) {
          lines.push(`- ${label}`);
        }
      }
      field("cleanupDetails").value = lines.join("\n");
      return;
    }

    action("deleteCleanup").disabled = true;
    let copyButton = action("copyCleanupList");
    if (copyButton) copyButton.disabled = true;
    field("cleanupStatus").textContent =
      `Cleanup ${cleanup.status}: deleted ${cleanup.deleted}, failed ${cleanup.failed}, skipped ${cleanup.skipped}.`;
    let lines = [
      `Cleanup status: ${cleanup.status}`,
      `Progress: ${cleanup.current}/${cleanup.total}`,
      `Deleted: ${cleanup.deleted}`,
      `Failed: ${cleanup.failed}`,
      `Skipped: ${cleanup.skipped}`
    ];
    if (cleanup.failedTasks?.length) {
      lines.push("", "Recent cleanup failures:");
      for (let task of cleanup.failedTasks) {
        lines.push(`- ${task.label}: ${task.error}`);
      }
    }
    field("cleanupDetails").value = lines.join("\n");
  },

  renderTaskCenterReview(body, queue, history) {
    let field = name => body.querySelector(`[data-paper-markdown-field="${name}"]`);
    let status = field("reviewStatus");
    let details = field("reviewDetails");
    if (!status || !details) return;

    let record = queue?.status && !["idle", "running"].includes(queue.status)
      ? queue
      : history?.[0];
    if (!record) {
      status.textContent = "No completed queue yet.";
      details.value = "";
      return;
    }

    let duration = this.formatDuration(record.durationMs || 0);
    status.textContent = `${record.status}: converted ${record.converted}, failed ${record.failed}, skipped ${record.skipped}, duration ${duration}.`;
    let timings = record.timings || {};
    let lines = [
      `Status: ${record.status}`,
      `Scope: ${record.scopeLabel || "unknown"}`,
      `Converted: ${record.converted}`,
      `Failed: ${record.failed}`,
      `Skipped: ${record.skipped}`,
      `Duration: ${duration}`,
      `Upload: ${this.formatDuration(timings.uploadMs || 0)}`,
      `MinerU wait: ${this.formatDuration(timings.mineruWaitMs || 0)}`,
      `Download + attach: ${this.formatDuration(timings.attachMs || 0)}`
    ];
    if (record.total) {
      lines.push(`Average per PDF: ${this.formatDuration((record.durationMs || 0) / record.total)}`);
    }
    if (record.settingsSummary) {
      let settings = record.settingsSummary;
      lines.push(
        "",
      `Settings: ${settings.modelVersion}, ${settings.language}, OCR ${settings.autoOCR ? "auto" : (settings.isOCR ? "on" : "off")}, formula ${settings.enableFormula ? "on" : "off"}, table ${settings.enableTable ? "on" : "off"}, headings ${settings.normalizeHeadings ? "normalize" : "raw"}`,
        `Batch: ${settings.batchSize}; Parallel uploads: ${settings.uploadConcurrency}; Existing policy: ${settings.onExisting}`
      );
    }
    if (record.failedTasks?.length) {
      lines.push("", "Failed PDFs:");
      for (let task of record.failedTasks) {
        lines.push(`- ${task.label}: ${task.error}`);
      }
    }
    else {
      lines.push("", "Failed PDFs: none");
    }
    if (record.convertedTasks?.length) {
      lines.push("", "Recent converted PDFs:");
      for (let label of record.convertedTasks) {
        lines.push(`- ${label}`);
      }
    }
    details.value = lines.join("\n");
  },

  getLatestFailureList() {
    let queueFailures = this.queueState?.tasks
      ?.filter(task => task.status === "failed")
      .map(task => ({ label: this.formatTaskLabel(task), error: task.error })) || [];
    if (queueFailures.length) return queueFailures;
    return this.taskHistory[0]?.failedTasks || [];
  },

  registerMenus() {
    if (!Zotero.MenuManager) {
      this.warn("Zotero.MenuManager is unavailable; item context menu was not registered");
      return;
    }

    this.menuIDs.push(Zotero.MenuManager.registerMenu({
      menuID: "paper-markdown-tools",
      pluginID: this.id,
      target: "main/menubar/tools",
      menus: [
        {
          menuType: "menuitem",
          onShowing: (event, context) => {
            this.setMenuLabel(context, "openTaskCenter");
          },
          onCommand: async () => {
            await this.openTaskCenter();
          }
        }
      ]
    }));

    this.menuIDs.push(Zotero.MenuManager.registerMenu({
      menuID: "paper-markdown-item-actions",
      pluginID: this.id,
      target: "main/library/item",
      menus: [
        {
          menuType: "submenu",
          onShowing: (event, context) => {
            this.setMenuLabel(context, "root");
            let items = context.items || [];
            let hasActions = this.itemsContainPDF(items) || this.itemsContainMarkdown(items);
            context.setVisible(hasActions);
            context.setEnabled(hasActions);
          },
          menus: [
            {
              menuType: "menuitem",
              onShowing: (event, context) => {
                this.setMenuLabel(context, "convertSelected");
                context.setEnabled(this.itemsContainPDF(context.items || []));
              },
              onCommand: async (event, context) => {
                await this.convertItems(context.items || []);
              }
            },
            {
              menuType: "menuitem",
              onShowing: (event, context) => {
                this.setMenuLabel(context, "previewSelected");
                context.setEnabled(this.itemsContainPDF(context.items || []));
              },
              onCommand: async (event, context) => {
                await this.previewBulkConversionForItems(context.items || []);
                await this.openTaskCenter();
              }
            },
            {
              menuType: "menuitem",
              onShowing: (event, context) => {
                this.setMenuLabel(context, "cleanSelected");
                context.setEnabled(this.itemsContainMarkdown(context.items || []));
              },
              onCommand: async (event, context) => {
                await this.previewMarkdownCleanupForItems(context.items || []);
                await this.openTaskCenter();
              }
            }
          ]
        }
      ]
    }));

    this.menuIDs = this.menuIDs.filter(Boolean);
  },

  async openTaskCenter() {
    let mainWindow = Zotero.getMainWindow();
    if (!mainWindow) {
      throw new Error("Zotero main window is unavailable.");
    }

    mainWindow.focus();
    let doc = mainWindow.document;
    let selectedItems = this.getSelectedItems();

    if (selectedItems.length !== 1) {
      return this.showStandaloneTaskPanel(mainWindow);
    }

    let itemDetails = doc.querySelector("item-details");
    if (!itemDetails || !this.itemPaneSectionID) {
      return this.showStandaloneTaskPanel(mainWindow);
    }

    try {
      itemDetails.renderCustomSections?.();
    }
    catch (error) {
      Zotero.logError(error);
    }

    let parentPane = itemDetails.closest("item-pane, context-pane");
    if (parentPane && "collapsed" in parentPane) {
      parentPane.collapsed = false;
    }

    let pane = itemDetails.getPane?.(this.itemPaneSectionID)
      || doc.querySelector(`item-pane-custom-section[data-pane="${CSS.escape(this.itemPaneSectionID)}"]`);
    if (!pane) {
      return this.showStandaloneTaskPanel(mainWindow);
    }

    let section = pane.querySelector("collapsible-section");
    if (section) {
      section.open = true;
    }

    try {
      itemDetails.pinnedPane = this.itemPaneSectionID;
      await itemDetails.scrollToPane?.(this.itemPaneSectionID, "smooth");
    }
    catch (error) {
      Zotero.logError(error);
      pane.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }

    pane.querySelector('[data-paper-markdown-field="bulkStatus"]')?.focus?.();
    pane.querySelector('[data-type="body"]')?._paperMarkdownRefresh?.();
    this.updateStandaloneButtonSelected(doc, false);
    return pane;
  },

  registerNotifier() {
    if (!Zotero.Notifier) {
      this.warn("Zotero.Notifier is unavailable; automatic conversion was not registered");
      return;
    }
    if (this.notifierID) return;

    this.notifierID = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        this.onItemNotify(event, type, ids).catch(error => Zotero.logError(error));
      }
    }, ["item"], "paper-markdown-auto-convert");
    this.log("Auto convert observer registered");
  },

  unregisterNotifier() {
    if (!this.notifierID || !Zotero.Notifier) return;

    Zotero.Notifier.unregisterObserver(this.notifierID);
    this.notifierID = null;
    this.log("Auto convert observer unregistered");
  },

  syncAutoConvertNotifier() {
    let settings = this.getSettings();
    if (settings.autoConvert && settings.apiToken) {
      this.registerNotifier();
      return;
    }
    this.unregisterNotifier();
  },

  async onItemNotify(event, type, ids) {
    if (type !== "item" || event !== "add") return;

    let settings = this.getSettings();
    if (!settings.autoConvert) return;
    if (!settings.apiToken) {
      this.warn("Auto convert is enabled, but no MinerU API token is configured");
      return;
    }

    this.queueAutoConvert(ids);
  },

  queueAutoConvert(ids) {
    let itemIDs = this.toArray(ids).filter(id => id !== null && id !== undefined);
    if (!itemIDs.length) return;
    let queuedAt = Date.now();
    this.log(`Auto convert noticed ${itemIDs.length} new Zotero item event(s); waiting for Zotero metadata and attachment processing`);

    this.autoConvertQueue = this.autoConvertQueue
      .catch(error => Zotero.logError(error))
      .then(async () => {
        await this.delay(this.AUTO_CONVERT_DELAY_MS);
        await this.convertItemIDsAutomatically(itemIDs, {
          since: queuedAt - this.AUTO_CONVERT_RECENT_WINDOW_MS
        });
      });
  },

  async convertItemIDsAutomatically(itemIDs, options = {}) {
    let settings = this.getSettings();
    if (!settings.autoConvert || !settings.apiToken) return;

    let items = await Zotero.Items.getAsync(itemIDs);
    let attachments = this.resolvePDFAttachments(this.toArray(items));
    if (options.since) {
      let recentAttachments = await this.getRecentlyAddedPDFAttachments(options.since);
      attachments = this.uniqueAttachments([...attachments, ...recentAttachments]);
    }
    let readyAttachments = [];

    for (let attachment of attachments) {
      if (!attachment?.id) continue;
      if (this.autoSeenAttachmentIDs.has(attachment.id)) continue;
      if (this.runningAttachmentIDs.has(attachment.id)) continue;
      if (!(await this.shouldAutoConvertAttachment(attachment, settings))) continue;

      this.autoSeenAttachmentIDs.add(attachment.id);
      readyAttachments.push(attachment);
    }

    if (!readyAttachments.length) {
      this.log(`Auto convert found no ready new PDFs after scanning ${attachments.length} candidate attachment(s)`);
      return;
    }

    this.log(`Auto converting ${readyAttachments.length} PDF attachment(s)`);
    await this.convertAttachments(readyAttachments, settings, { interactive: false });
  },

  async getRecentlyAddedPDFAttachments(sinceMs) {
    let attachments = await this.getAllPDFAttachments();
    return attachments.filter(attachment => this.isRecentlyAddedAttachment(attachment, sinceMs));
  },

  isRecentlyAddedAttachment(attachment, sinceMs) {
    if (!sinceMs) return true;
    let dates = [attachment?.dateAdded];
    if (attachment?.parentID) {
      let parentItem = Zotero.Items.get(attachment.parentID);
      dates.push(parentItem?.dateAdded);
    }
    return dates.some(value => {
      let time = this.parseZoteroDate(value);
      return time && time >= sinceMs;
    });
  },

  parseZoteroDate(value) {
    if (!value) return 0;
    let text = String(value).trim();
    let normalized = text.includes("T") ? text : text.replace(" ", "T") + "Z";
    let time = Date.parse(normalized);
    return Number.isFinite(time) ? time : 0;
  },

  async shouldAutoConvertAttachment(attachment, settings) {
    try {
      let pdfPath = await attachment.getFilePathAsync();
      if (!pdfPath) {
        this.warn(`Auto convert skipped ${this.formatAttachmentLabel(attachment)} because the PDF is not available locally`);
        return false;
      }

      let parentItem = this.getOutputParentItem(attachment);
      if (!parentItem?.isRegularItem?.()) {
        return false;
      }
      let outputInfo = this.getMarkdownOutputInfo(attachment, pdfPath, settings);
      let existing = this.findExistingMarkdownAttachment(parentItem, outputInfo.filename);
      if (existing && settings.onExisting === "skip") {
        this.log(`Auto convert skipped ${this.formatAttachmentLabel(attachment)} because Markdown already exists`);
        return false;
      }
      return true;
    }
    catch (error) {
      this.warn(`Auto convert skipped ${this.formatAttachmentLabel(attachment)}: ${this.formatError(error)}`);
      return false;
    }
  },

  getPref(name) {
    return Zotero.Prefs.get(this.PREF_PREFIX + name, true);
  },

  getIntPref(name, fallback) {
    let value = Number(this.getPref(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  },

  getClampedIntPref(name, fallback, min, max) {
    return this.clampInt(this.getPref(name), fallback, min, max);
  },

  clampInt(value, fallback, min, max) {
    value = Number(value);
    if (!Number.isFinite(value) || value <= 0) {
      value = fallback;
    }
    return Math.max(min, Math.min(max, value));
  },

  getSettings() {
    return {
      apiToken: String(this.getPref("apiToken") || "").trim(),
      modelVersion: String(this.getPref("modelVersion") || "vlm"),
      language: String(this.getPref("language") || "ch"),
      isOCR: Boolean(this.getPref("isOCR")),
      enableFormula: Boolean(this.getPref("enableFormula")),
      enableTable: Boolean(this.getPref("enableTable")),
      pageRanges: String(this.getPref("pageRanges") || "").trim(),
      onExisting: String(this.getPref("onExisting") || "skip"),
      useZoteroRenameTemplate: this.getPref("useZoteroRenameTemplate") !== false,
      filenameTemplate: String(this.getPref("filenameTemplate") || this.DEFAULT_FILENAME_TEMPLATE).trim(),
      keepRawZip: Boolean(this.getPref("keepRawZip")),
      normalizeHeadings: Boolean(this.getPref("normalizeHeadings")),
      pollIntervalMs: this.getIntPref("pollIntervalMs", 5000),
      pollTimeoutMs: this.getIntPref("pollTimeoutMs", 900000),
      batchSize: this.getClampedIntPref("batchSize", 10, 1, 50),
      uploadConcurrency: this.getClampedIntPref("uploadConcurrency", 4, 1, 50),
      autoOCR: Boolean(this.getPref("autoOCR")),
      tagConverted: Boolean(this.getPref("tagConverted")),
      autoConvert: Boolean(this.getPref("autoConvert"))
    };
  },

  toArray(value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" && typeof value[Symbol.iterator] === "function") {
      return Array.from(value);
    }
    return [value];
  },

  itemsContainPDF(items) {
    return this.resolvePDFAttachments(items).length > 0;
  },

  itemsContainMarkdown(items) {
    return this.resolveMarkdownAttachments(items).length > 0;
  },

  resolvePDFAttachments(items) {
    let attachments = [];
    let seen = new Set();

    for (let item of items) {
      if (!item) continue;

      if (item.isAttachment?.() && item.isPDFAttachment?.()) {
        this.pushUniqueAttachment(attachments, seen, item);
        continue;
      }

      if (!item.isRegularItem?.()) continue;

      for (let attachmentID of item.getAttachments()) {
        let attachment = Zotero.Items.get(attachmentID);
        if (attachment?.isPDFAttachment?.()) {
          this.pushUniqueAttachment(attachments, seen, attachment);
        }
      }
    }

    return attachments;
  },

  pushUniqueAttachment(attachments, seen, attachment) {
    if (seen.has(attachment.id)) return;
    seen.add(attachment.id);
    attachments.push(attachment);
  },

  async convertItems(items) {
    let settings = this.getSettings();
    if (!settings.apiToken) {
      this.alert("Please set your MinerU API Token in Zotero Settings -> Paper Markdown.");
      return;
    }

    let attachments = this.resolvePDFAttachments(items);
    if (!attachments.length) {
      this.alert("No local PDF attachment was found in the selected Zotero item.");
      return;
    }

    await this.convertAttachments(attachments, settings, { interactive: true });
  },

  async convertMissingPDFs() {
    let preview = await this.previewBulkConversion("all");
    if (!preview.queued) {
      return preview;
    }
    return this.startBulkQueueFromPreview();
  },

  async previewBulkConversion(scope = "all", settingsOverride = null) {
    let settings = settingsOverride || this.getSettings();
    let attachments = this.uniqueAttachments(await this.getPDFAttachmentsForScope(scope));
    return this.buildBulkPreview(attachments, settings, scope, this.getScopeLabel(scope));
  },

  async previewBulkConversionForItems(items, settingsOverride = null) {
    let settings = settingsOverride || this.getSettings();
    let attachments = this.uniqueAttachments(this.resolvePDFAttachments(items));
    return this.buildBulkPreview(attachments, settings, "selected", "selected items");
  },

  async buildBulkPreview(attachments, settings, scope, scopeLabel) {
    let preview = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      scope,
      scopeLabel,
      settings: {
        onExisting: settings.onExisting,
        modelVersion: settings.modelVersion,
        language: settings.language,
        autoOCR: settings.autoOCR,
        isOCR: settings.isOCR,
        enableFormula: settings.enableFormula,
        enableTable: settings.enableTable,
        batchSize: settings.batchSize,
        uploadConcurrency: settings.uploadConcurrency
      },
      runSettings: { ...settings },
      createdAt: new Date().toISOString(),
      total: attachments.length,
      pending: [],
      converted: [],
      unavailable: [],
      skipped: [],
      counts: {
        ready: 0,
        existing: 0,
        converted: 0,
        missingLocal: 0,
        noParent: 0,
        notEditable: 0,
        running: 0,
        error: 0
      }
    };

    for (let attachment of attachments) {
      let analysis = await this.analyzeAttachmentForBulk(attachment, settings);
      if (analysis.status === "ready") {
        preview.pending.push(analysis.task);
        preview.counts.ready++;
        if (analysis.task.existingMarkdown) {
          preview.counts.existing++;
        }
      }
      else if (analysis.status === "converted") {
        preview.converted.push(analysis.task);
        preview.counts.converted++;
        preview.counts.existing++;
      }
      else if (analysis.status === "skipped") {
        preview.skipped.push(analysis.task);
        preview.counts[analysis.reason] = (preview.counts[analysis.reason] || 0) + 1;
      }
      else {
        preview.unavailable.push(analysis.task);
        preview.counts[analysis.reason] = (preview.counts[analysis.reason] || 0) + 1;
      }
    }

    this.lastBulkPreview = preview;
    let summary = this.summarizeBulkPreview(preview);
    this.log(`Previewed ${summary.total} PDF(s) in ${summary.scopeLabel}; ${summary.queued} queued, ${summary.converted} already converted, ${summary.unavailable} unavailable`);
    return summary;
  },

  clearBulkPreview() {
    this.lastBulkPreview = null;
  },

  async getAllPDFAttachments() {
    let sql = `
      SELECT IA.itemID
      FROM itemAttachments IA
      JOIN items I ON IA.itemID = I.itemID
      WHERE IA.contentType = 'application/pdf'
        AND IA.parentItemID IS NOT NULL
        AND IA.itemID NOT IN (SELECT itemID FROM deletedItems)
        AND IA.parentItemID NOT IN (SELECT itemID FROM deletedItems)
      ORDER BY I.dateAdded
    `;
    let ids = await Zotero.DB.columnQueryAsync(sql);
    let items = await Zotero.Items.getAsync(ids);
    return this.toArray(items).filter(item => item?.isPDFAttachment?.());
  },

  async getPDFAttachmentsForScope(scope) {
    if (scope === "selected") {
      return this.getSelectedPDFAttachments();
    }
    if (scope === "collection") {
      return this.getCurrentCollectionPDFAttachments();
    }
    return this.getAllPDFAttachments();
  },

  getZoteroPane() {
    return Zotero.getMainWindow()?.ZoteroPane;
  },

  getSelectedItems() {
    return this.getZoteroPane()?.getSelectedItems?.() || [];
  },

  getSelectedPDFAttachments() {
    return this.resolvePDFAttachments(this.getSelectedItems());
  },

  async getCurrentCollectionPDFAttachments() {
    let collection = this.getZoteroPane()?.getSelectedCollection?.();
    if (!collection) {
      throw new Error("No Zotero collection is selected in the main window.");
    }

    let itemIDs = new Set(collection.getChildItems(true, false));
    for (let descendent of collection.getDescendents(false, "collection", false)) {
      let childCollection = Zotero.Collections.get(descendent.id);
      for (let itemID of childCollection.getChildItems(true, false)) {
        itemIDs.add(itemID);
      }
    }

    let items = await Zotero.Items.getAsync([...itemIDs]);
    return this.resolvePDFAttachments(this.toArray(items));
  },

  uniqueAttachments(attachments) {
    let unique = [];
    let seen = new Set();
    for (let attachment of attachments || []) {
      if (!attachment?.id || seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      unique.push(attachment);
    }
    return unique;
  },

  async analyzeAttachmentForBulk(attachment, settings) {
    let fallbackTask = this.makeAttachmentTask(attachment, null, null, "skip");
    if (!attachment?.id) {
      return { status: "unavailable", reason: "error", task: { ...fallbackTask, reason: "Invalid attachment" } };
    }
    if (this.runningAttachmentIDs.has(attachment.id)) {
      return { status: "skipped", reason: "running", task: { ...fallbackTask, reason: "Already running" } };
    }

    try {
      if (!(await attachment.fileExists())) {
        return { status: "unavailable", reason: "missingLocal", task: { ...fallbackTask, reason: "PDF is not available locally" } };
      }

      let parentItem = this.getOutputParentItem(attachment);
      let library = Zotero.Libraries.get(parentItem.libraryID);
      if (library && library.filesEditable === false) {
        return { status: "unavailable", reason: "notEditable", task: { ...fallbackTask, parentTitle: parentItem.getField("title") || "", reason: "Library files are not editable" } };
      }

      let pdfPath = await attachment.getFilePathAsync();
      let outputInfo = this.getMarkdownOutputInfo(attachment, pdfPath, settings);
      let existing = this.findExistingMarkdownAttachment(parentItem, outputInfo.filename);
      let task = this.makeAttachmentTask(attachment, parentItem, outputInfo, existing ? settings.onExisting : "create");
      if (existing) {
        task.existingMarkdown = true;
        task.existingMarkdownLabel = this.formatMarkdownAttachmentLabel(existing);
        task.reason = this.formatExistingActionReason(settings.onExisting);
      }

      if (existing && settings.onExisting === "skip") {
        return { status: "converted", reason: "converted", task: { ...task, reason: "Markdown already exists" } };
      }

      return { status: "ready", task };
    }
    catch (error) {
      let message = this.formatError(error);
      let reason = message.includes("Standalone PDF") ? "noParent" : "error";
      return { status: "unavailable", reason, task: { ...fallbackTask, reason: message } };
    }
  },

  makeAttachmentTask(attachment, parentItem, outputInfo, action) {
    return {
      attachmentID: attachment?.id || null,
      attachmentKey: attachment?.key || "",
      pdfFilename: attachment?.attachmentFilename || "",
      markdownFilename: outputInfo?.filename || "",
      parentTitle: parentItem?.getField?.("title") || "",
      action,
      existingMarkdown: false,
      existingMarkdownLabel: "",
      status: "queued",
      attempts: 0,
      error: "",
      reason: ""
    };
  },

  summarizeBulkPreview(preview) {
    let unavailable = preview.unavailable.length;
    let skipped = preview.skipped.length;
    let previewLimit = 24;
    let readyTasks = preview.pending.filter(task => !task.existingMarkdown);
    let pendingExistingTasks = preview.pending.filter(task => task.existingMarkdown);
    let existingTasks = [...pendingExistingTasks, ...preview.converted];
    return {
      id: preview.id,
      scope: preview.scope,
      scopeLabel: preview.scopeLabel,
      total: preview.total,
      queued: preview.pending.length,
      readyNew: readyTasks.length,
      queuedExisting: pendingExistingTasks.length,
      converted: preview.converted.length,
      existing: preview.counts.existing || 0,
      unavailable,
      skipped,
      missingLocal: preview.counts.missingLocal || 0,
      noParent: preview.counts.noParent || 0,
      notEditable: preview.counts.notEditable || 0,
      running: preview.counts.running || 0,
      errors: preview.counts.error || 0,
      onExisting: preview.settings.onExisting,
      modelVersion: preview.settings.modelVersion,
      language: preview.settings.language,
      autoOCR: preview.settings.autoOCR,
      isOCR: preview.settings.isOCR,
      enableFormula: preview.settings.enableFormula,
      enableTable: preview.settings.enableTable,
      batchSize: preview.settings.batchSize,
      uploadConcurrency: preview.settings.uploadConcurrency,
      sample: preview.pending.slice(0, 8).map(task => this.formatTaskLabel(task)),
      existingSample: existingTasks
        .slice(0, 8)
        .map(task => this.formatExistingTaskLabel(task)),
      unavailableSample: preview.unavailable.slice(0, 8).map(task => {
        let label = this.formatTaskLabel(task);
        return task.reason ? `${label}: ${task.reason}` : label;
      }),
      readyItems: readyTasks.slice(0, previewLimit).map(task => this.formatPreviewTaskDetails(task)),
      readyOverflow: Math.max(0, readyTasks.length - previewLimit),
      existingItems: existingTasks.slice(0, previewLimit).map(task => this.formatPreviewTaskDetails(task)),
      existingOverflow: Math.max(0, existingTasks.length - previewLimit),
      unavailableItems: preview.unavailable.slice(0, previewLimit).map(task => this.formatPreviewTaskDetails(task)),
      unavailableOverflow: Math.max(0, preview.unavailable.length - previewLimit)
    };
  },

  getScopeLabel(scope) {
    if (scope === "selected") return "selected items";
    if (scope === "collection") return "current collection";
    return "all libraries";
  },

  async startBulkQueueFromPreview() {
    if (!this.lastBulkPreview) {
      throw new Error("Run a preview before starting the batch queue.");
    }

    let tasks = this.lastBulkPreview.pending.map(task => ({
      ...task,
      status: "queued",
      attempts: 0,
      error: ""
    }));
    return this.runTaskQueue(tasks, {
      source: "preview",
      scope: this.lastBulkPreview.scope,
      scopeLabel: this.lastBulkPreview.scopeLabel,
      settings: this.lastBulkPreview.runSettings
    });
  },

  async retryFailedTasks() {
    let failedTasks = this.queueState?.tasks?.filter(task => task.status === "failed") || [];
    if (!failedTasks.length) {
      return this.getQueueStatus();
    }

    let retryTasks = failedTasks.map(task => ({
      ...task,
      status: "queued",
      error: ""
    }));
    return this.runTaskQueue(retryTasks, {
      source: "retry",
      scope: "failed",
      scopeLabel: "failed tasks"
    });
  },

  stopQueueAfterCurrent() {
    if (this.queueState?.status === "running") {
      this.queueAbortRequested = true;
      this.log("Queue stop requested; the current MinerU batch will finish first");
    }
    return this.getQueueStatus();
  },

  async runTaskQueue(tasks, context = {}) {
    if (this.queueState?.status === "running") {
      throw new Error("A Paper Markdown queue is already running.");
    }

    let settings = context.settings || this.getSettings();
    if (!settings.apiToken) {
      throw new Error("Please set your MinerU API Token in Zotero Settings -> Paper Markdown.");
    }

    this.queueAbortRequested = false;
    this.queueState = {
      status: tasks.length ? "running" : "done",
      source: context.source || "manual",
      scope: context.scope || "all",
      scopeLabel: context.scopeLabel || this.getScopeLabel(context.scope || "all"),
      batchSize: settings.batchSize,
      uploadConcurrency: settings.uploadConcurrency,
      settingsSummary: this.summarizeSettingsForHistory(settings),
      total: tasks.length,
      current: 0,
      converted: 0,
      failed: 0,
      skipped: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      timings: {
        uploadMs: 0,
        mineruWaitMs: 0,
        attachMs: 0
      },
      activeTask: null,
      tasks
    };

    if (!tasks.length) {
      this.queueState.finishedAt = new Date().toISOString();
      return this.getQueueStatus();
    }

    this.log(`Queue started for ${this.queueState.scopeLabel}: ${tasks.length} task(s); MinerU batch size ${settings.batchSize}, upload concurrency ${settings.uploadConcurrency}`);
    for (let offset = 0; offset < tasks.length; offset += settings.batchSize) {
      if (this.queueAbortRequested) {
        this.queueState.status = "stopped";
        this.log("Queue stopped before starting the next batch");
        break;
      }
      await this.runMinerUBatch(tasks.slice(offset, offset + settings.batchSize), settings, offset);
    }

    if (this.queueState.status === "running") {
      this.queueState.status = "done";
    }
    this.queueState.finishedAt = new Date().toISOString();
    this.recordQueueHistory(this.queueState);
    this.setActiveConversion({
      status: this.queueState.status,
      label: this.queueState.scopeLabel,
      percent: 100,
      message: `Queue ${this.queueState.status}: converted ${this.queueState.converted}, failed ${this.queueState.failed}, skipped ${this.queueState.skipped}`,
      queueCurrent: this.queueState.current,
      queueTotal: this.queueState.total
    });
    this.log(`Queue ${this.queueState.status}: converted ${this.queueState.converted}, failed ${this.queueState.failed}, skipped ${this.queueState.skipped}`);
    return this.getQueueStatus();
  },

  async runMinerUBatch(tasks, settings, offset = 0) {
    let prepared = [];
    let batchLabel = `${offset + 1}-${Math.min(offset + tasks.length, this.queueState.total)}`;
    this.setActiveConversion({
      status: "running",
      label: `Batch ${batchLabel}`,
      percent: 1,
      message: "Preparing PDF batch...",
      queueCurrent: this.queueState.current,
      queueTotal: this.queueState.total
    });

    for (let i = 0; i < tasks.length; i++) {
      let task = tasks[i];
      task.status = "preparing";
      task.attempts = (task.attempts || 0) + 1;
      task.error = "";
      task.reason = "";

      try {
        let preparedTask = await this.prepareBatchConversionTask(task, settings, offset + i);
        if (preparedTask) {
          prepared.push(preparedTask);
        }
      }
      catch (error) {
        task.status = "failed";
        task.error = this.formatError(error);
        this.queueState.failed++;
        this.queueState.current++;
        Zotero.logError(error);
        this.warn(`Queue failed ${this.formatTaskLabel(task)}: ${task.error}`);
      }
    }

    if (!prepared.length) return;

    this.log(`Submitting MinerU batch ${batchLabel}: ${prepared.length} PDF(s)`);
    let batch;
    try {
      batch = await this.createMinerUBatchUploadTask(prepared, settings);
    }
    catch (error) {
      for (let item of prepared) {
        this.failPreparedTask(item, error);
      }
      return;
    }

    let uploadStartedAt = Date.now();
    prepared = await this.uploadPreparedFiles(batch, prepared, settings);
    this.queueState.timings.uploadMs += Date.now() - uploadStartedAt;
    if (!prepared.length) return;

    let batchResults;
    try {
      let mineruStartedAt = Date.now();
      batchResults = await this.pollBatchResults(batch.batchID, prepared, settings, update => {
        this.setActiveConversion({
          status: "running",
          label: `Batch ${batchLabel}`,
          percent: update.percent,
          message: update.message,
          queueCurrent: this.queueState.current,
          queueTotal: this.queueState.total
        });
      });
      this.queueState.timings.mineruWaitMs += Date.now() - mineruStartedAt;
    }
    catch (error) {
      for (let item of prepared) {
        this.failPreparedTask(item, error);
      }
      return;
    }

    for (let item of prepared) {
      let task = item.task;
      let failure = batchResults.failures.get(item.dataID);
      if (failure) {
        this.failPreparedTask(item, failure);
        continue;
      }

      let result = batchResults.results.get(item.dataID);
      if (!result) {
        this.failPreparedTask(item, new Error("MinerU did not return a result for this PDF."));
        continue;
      }

      try {
        task.status = "saving";
        this.setActiveConversion({
          status: "running",
          label: this.formatTaskLabel(task),
          percent: 88,
          message: "Downloading MinerU result and attaching Markdown...",
          queueCurrent: this.queueState.current + 1,
          queueTotal: this.queueState.total
        });
        let attachStartedAt = Date.now();
        await this.attachMinerUResult(item, result, settings);
        this.queueState.timings.attachMs += Date.now() - attachStartedAt;
        task.status = "done";
        this.runningAttachmentIDs.delete(item.attachment?.id);
        this.queueState.converted++;
        this.queueState.current++;
        this.setActiveConversion({
          status: "done",
          label: this.formatTaskLabel(task),
          percent: 100,
          message: "Markdown attached.",
          queueCurrent: this.queueState.current,
          queueTotal: this.queueState.total
        });
        this.log(`Queue converted ${this.formatTaskLabel(task)}`);
      }
      catch (error) {
        this.failPreparedTask(item, error);
      }
    }
  },

  async prepareBatchConversionTask(task, settings, absoluteIndex) {
    let attachment = Zotero.Items.get(task.attachmentID);
    if (!attachment?.isPDFAttachment?.()) {
      throw new Error("PDF attachment no longer exists.");
    }
    if (this.runningAttachmentIDs.has(attachment.id)) {
      throw new Error("PDF attachment is already being converted.");
    }

    let pdfPath = await attachment.getFilePathAsync();
    if (!pdfPath) {
      throw new Error("The selected PDF is not available locally. Download it in Zotero first.");
    }

    let parentItem = this.getOutputParentItem(attachment);
    let outputInfo = this.getMarkdownOutputInfo(attachment, pdfPath, settings);
    let existing = this.findExistingMarkdownAttachment(parentItem, outputInfo.filename);
    if (existing) {
      task.existingMarkdown = true;
      task.existingMarkdownLabel = this.formatMarkdownAttachmentLabel(existing);
    }
    if (existing && settings.onExisting === "skip") {
      task.status = "skipped";
      task.reason = "Markdown already exists";
      this.queueState.skipped++;
      this.queueState.current++;
      this.log(`Queue skipped ${this.formatTaskLabel(task)}`);
      return null;
    }
    if (existing && settings.onExisting === "version") {
      outputInfo = this.getVersionedMarkdownOutputInfo(outputInfo);
    }

    let effectiveSettings = await this.getEffectiveSettingsForAttachment(attachment, settings);
    task.markdownFilename = outputInfo.filename;
    task.effectiveOCR = effectiveSettings.isOCR;
    task.status = "queued";
    this.runningAttachmentIDs.add(attachment.id);
    let dataID = this.getMinerUDataID(parentItem, attachment);
    return { task, attachment, pdfPath, parentItem, outputInfo, existing, dataID, absoluteIndex, effectiveSettings };
  },

  failPreparedTask(item, error) {
    let task = item.task;
    task.status = "failed";
    task.error = this.formatError(error);
    this.runningAttachmentIDs.delete(item.attachment?.id);
    this.queueState.failed++;
    this.queueState.current++;
    this.setActiveConversion({
      status: "failed",
      label: this.formatTaskLabel(task),
      percent: 100,
      message: task.error,
      queueCurrent: this.queueState.current,
      queueTotal: this.queueState.total
    });
    Zotero.logError(error);
    this.warn(`Queue failed ${this.formatTaskLabel(task)}: ${task.error}`);
  },

  getQueueStatus() {
    let state = this.queueState;
    if (!state) {
      return {
        status: "idle",
        total: 0,
        current: 0,
        converted: 0,
        failed: 0,
        skipped: 0,
        activeTask: null,
        failedTasks: []
      };
    }

    return {
      status: state.status,
      source: state.source,
      scope: state.scope,
      scopeLabel: state.scopeLabel,
      batchSize: state.batchSize,
      uploadConcurrency: state.uploadConcurrency,
      total: state.total,
      current: state.current,
      converted: state.converted,
      failed: state.failed,
      skipped: state.skipped,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      durationMs: state.finishedAt ? new Date(state.finishedAt) - new Date(state.startedAt) : Date.now() - new Date(state.startedAt),
      timings: state.timings,
      settingsSummary: state.settingsSummary,
      activeTask: state.activeTask,
      failedTasks: state.tasks
        .filter(task => task.status === "failed")
        .slice(-10)
        .map(task => ({
          label: this.formatTaskLabel(task),
          error: task.error
        }))
    };
  },

  summarizeSettingsForHistory(settings) {
    return {
      modelVersion: settings.modelVersion,
      language: settings.language,
      autoOCR: settings.autoOCR,
      isOCR: settings.isOCR,
      enableFormula: settings.enableFormula,
      enableTable: settings.enableTable,
      onExisting: settings.onExisting,
      batchSize: settings.batchSize,
      uploadConcurrency: settings.uploadConcurrency
    };
  },

  recordQueueHistory(state) {
    this.taskHistory.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      status: state.status,
      scopeLabel: state.scopeLabel,
      total: state.total,
      converted: state.converted,
      failed: state.failed,
      skipped: state.skipped,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      durationMs: new Date(state.finishedAt) - new Date(state.startedAt),
      timings: { ...state.timings },
      settingsSummary: { ...state.settingsSummary },
      failedTasks: state.tasks
        .filter(task => task.status === "failed")
        .map(task => ({
          label: this.formatTaskLabel(task),
          error: task.error
        })),
      convertedTasks: state.tasks
        .filter(task => task.status === "done")
        .slice(-12)
        .map(task => this.formatTaskLabel(task))
    });
    if (this.taskHistory.length > this.MAX_TASK_HISTORY) {
      this.taskHistory.splice(this.MAX_TASK_HISTORY);
    }
  },

  setActiveConversion(update) {
    this.activeConversionState = {
      ...(this.activeConversionState || {}),
      ...update,
      updatedAt: new Date().toISOString()
    };
    if (this.queueState?.status === "running") {
      this.queueState.activeTask = this.activeConversionState;
    }
  },

  clearActiveConversion() {
    this.activeConversionState = null;
    if (this.queueState) {
      this.queueState.activeTask = null;
    }
  },

  async previewMarkdownCleanup(scope = "all", target = "paperMarkdown") {
    let attachments = this.uniqueAttachments(await this.getMarkdownAttachmentsForScope(scope));
    this.log(`Markdown management preview scanned ${attachments.length} Markdown-like attachment(s) for ${this.getScopeLabel(scope)}; target ${target}`);
    return this.buildMarkdownCleanupPreview(
      attachments,
      scope,
      this.getScopeLabel(scope),
      target
    );
  },

  async previewMarkdownCleanupForItems(items, target = "paperMarkdown") {
    let attachments = this.uniqueAttachments(this.resolveMarkdownAttachments(items));
    return this.buildMarkdownCleanupPreview(attachments, "selected", "selected items", target);
  },

  async buildMarkdownCleanupPreview(attachments, scope, scopeLabel, target) {
    let preview = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      scope,
      scopeLabel,
      target,
      targetLabel: this.getCleanupTargetLabel(target),
      createdAt: new Date().toISOString(),
      total: attachments.length,
      pending: [],
      skipped: []
    };

    for (let attachment of attachments) {
      let parentItem = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
      let task = this.makeCleanupTask(attachment, parentItem);

      if (target === "paperMarkdown" && !(await this.isPaperMarkdownGeneratedAttachment(attachment))) {
        preview.skipped.push({ ...task, reason: "Not recognized as a Paper Markdown attachment" });
        continue;
      }

      preview.pending.push(task);
    }

    this.lastCleanupPreview = preview;
    this.cleanupState = null;
    let summary = this.summarizeCleanupPreview(preview);
    this.log(`Previewed Markdown cleanup in ${summary.scopeLabel}: ${summary.deleteCount} attachment(s) ready to delete`);
    return summary;
  },

  clearCleanupPreview() {
    this.lastCleanupPreview = null;
    this.cleanupState = null;
  },

  summarizeCleanupPreview(preview) {
    return {
      id: preview.id,
      scope: preview.scope,
      scopeLabel: preview.scopeLabel,
      target: preview.target,
      targetLabel: preview.targetLabel,
      total: preview.total,
      deleteCount: preview.pending.length,
      skipped: preview.skipped.length,
      sample: preview.pending.slice(0, 12).map(task => this.formatCleanupTaskLabel(task))
    };
  },

  getCleanupStatus() {
    if (this.lastCleanupPreview) {
      return {
        status: "previewed",
        preview: this.summarizeCleanupPreview(this.lastCleanupPreview)
      };
    }

    if (this.cleanupState) {
      return {
        status: this.cleanupState.status,
        scopeLabel: this.cleanupState.scopeLabel,
        targetLabel: this.cleanupState.targetLabel,
        total: this.cleanupState.total,
        current: this.cleanupState.current,
        deleted: this.cleanupState.deleted,
        failed: this.cleanupState.failed,
        skipped: this.cleanupState.skipped,
        failedTasks: this.cleanupState.failedTasks.slice(-10)
      };
    }

    return {
      status: "idle",
      total: 0,
      current: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      failedTasks: []
    };
  },

  async deleteMarkdownCleanupPreview() {
    if (!this.lastCleanupPreview) {
      throw new Error("Run a cleanup preview before deleting Markdown attachments.");
    }

    let preview = this.lastCleanupPreview;
    let tasks = preview.pending.map(task => ({ ...task }));
    this.lastCleanupPreview = null;
    this.cleanupState = {
      status: tasks.length ? "running" : "done",
      scopeLabel: preview.scopeLabel,
      targetLabel: preview.targetLabel,
      total: tasks.length,
      current: 0,
      deleted: 0,
      failed: 0,
      skipped: preview.skipped.length,
      failedTasks: []
    };

    this.log(`Markdown cleanup started for ${preview.scopeLabel}: ${tasks.length} attachment(s)`);
    for (let index = 0; index < tasks.length; index++) {
      let task = tasks[index];
      this.cleanupState.current = index + 1;

      try {
        let attachment = Zotero.Items.get(task.attachmentID);
        if (!attachment) {
          this.cleanupState.skipped++;
          continue;
        }
        if (!this.isMarkdownAttachment(attachment)) {
          this.cleanupState.skipped++;
          continue;
        }

        await attachment.eraseTx();
        this.cleanupState.deleted++;
      }
      catch (error) {
        let message = this.formatError(error);
        this.cleanupState.failed++;
        this.cleanupState.failedTasks.push({
          label: this.formatCleanupTaskLabel(task),
          error: message
        });
        Zotero.logError(error);
        this.warn(`Markdown cleanup failed for ${this.formatCleanupTaskLabel(task)}: ${message}`);
      }
    }

    this.cleanupState.status = "done";
    this.log(`Markdown cleanup done: deleted ${this.cleanupState.deleted}, failed ${this.cleanupState.failed}, skipped ${this.cleanupState.skipped}`);
    return this.getCleanupStatus();
  },

  async getMarkdownAttachmentsForScope(scope) {
    if (scope === "selected") {
      return this.getSelectedMarkdownAttachments();
    }
    if (scope === "collection") {
      return this.getCurrentCollectionMarkdownAttachments();
    }
    return this.getAllMarkdownAttachments();
  },

  async getAllMarkdownAttachments() {
    let sql = `
      SELECT I.itemID
      FROM items I
      JOIN itemTypes IT ON IT.itemTypeID = I.itemTypeID
      WHERE IT.typeName = 'attachment'
        AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
      ORDER BY I.dateAdded
    `;
    let ids = await Zotero.DB.columnQueryAsync(sql);
    let items = await Zotero.Items.getAsync(ids);
    return this.toArray(items).filter(item => item?.parentID && this.isMarkdownAttachment(item));
  },

  getSelectedMarkdownAttachments() {
    return this.resolveMarkdownAttachments(this.getSelectedItems());
  },

  async getCurrentCollectionMarkdownAttachments() {
    let collection = this.getZoteroPane()?.getSelectedCollection?.();
    if (!collection) {
      throw new Error("No Zotero collection is selected in the main window.");
    }

    let itemIDs = new Set(collection.getChildItems(true, false));
    for (let descendent of collection.getDescendents(false, "collection", false)) {
      let childCollection = Zotero.Collections.get(descendent.id);
      for (let itemID of childCollection.getChildItems(true, false)) {
        itemIDs.add(itemID);
      }
    }

    let items = await Zotero.Items.getAsync([...itemIDs]);
    return this.resolveMarkdownAttachments(this.toArray(items));
  },

  resolveMarkdownAttachments(items) {
    let attachments = [];
    let seen = new Set();

    for (let item of items) {
      if (!item) continue;

      if (item.isAttachment?.() && this.isMarkdownAttachment(item)) {
        this.pushUniqueAttachment(attachments, seen, item);
        continue;
      }

      if (!item.isRegularItem?.()) continue;

      for (let attachmentID of item.getAttachments()) {
        let attachment = Zotero.Items.get(attachmentID);
        if (this.isMarkdownAttachment(attachment)) {
          this.pushUniqueAttachment(attachments, seen, attachment);
        }
      }
    }

    return attachments;
  },

  isMarkdownAttachment(attachment) {
    if (!attachment?.isAttachment?.()) return false;

    let contentType = attachment.attachmentContentType || "";
    let filename = attachment.attachmentFilename || "";
    let path = attachment.attachmentPath || "";
    let title = attachment.getField?.("title") || "";
    return contentType === "text/markdown"
      || contentType === "text/x-markdown"
      || filename.toLowerCase().endsWith(".md")
      || path.toLowerCase().endsWith(".md")
      || title.toLowerCase().endsWith(".md");
  },

  async isPaperMarkdownGeneratedAttachment(attachment) {
    if (!this.isMarkdownAttachment(attachment)) return false;
    if (await this.hasPaperMarkdownMetadata(attachment)) return true;

    let title = attachment.getField?.("title") || "";
    return title === this.MARKDOWN_ATTACHMENT_TITLE || title.startsWith("Markdown - ");
  },

  async hasPaperMarkdownMetadata(attachment) {
    try {
      let dir = Zotero.Attachments.getStorageDirectory(attachment).path;
      let metadataPath = PathUtils.join(dir, "paper-markdown-meta.json");
      let stat = await IOUtils.stat(metadataPath);
      return stat?.type === "regular";
    }
    catch (error) {
      return false;
    }
  },

  makeCleanupTask(attachment, parentItem) {
    return {
      attachmentID: attachment?.id || null,
      attachmentKey: attachment?.key || "",
      title: attachment?.getField?.("title") || "",
      filename: attachment?.attachmentFilename || "",
      parentTitle: parentItem?.getField?.("title") || ""
    };
  },

  formatCleanupTaskLabel(task) {
    let name = task.title || task.filename || task.attachmentKey || String(task.attachmentID || "Markdown");
    return task.parentTitle ? `${task.parentTitle} -> ${name}` : name;
  },

  getCleanupTargetLabel(target) {
    if (target === "allMarkdown") return "all Markdown-like attachments";
    return "Paper Markdown generated attachments";
  },

  getStatusSnapshot() {
    return {
      version: this.version,
      preview: this.lastBulkPreview ? this.summarizeBulkPreview(this.lastBulkPreview) : null,
      cleanup: this.getCleanupStatus(),
      queue: this.getQueueStatus(),
      activeConversion: this.activeConversionState,
      history: this.taskHistory.slice(0, 8),
      logs: this.getLogText()
    };
  },

  formatTaskLabel(task) {
    let source = task.pdfFilename || task.parentTitle || task.attachmentKey || String(task.attachmentID || "PDF");
    return task.markdownFilename ? `${source} -> ${task.markdownFilename}` : source;
  },

  formatExistingTaskLabel(task) {
    let label = this.formatTaskLabel(task);
    return task.existingMarkdownLabel ? `${label} (existing: ${task.existingMarkdownLabel})` : label;
  },

  formatPreviewTaskDetails(task) {
    return {
      title: task.parentTitle || task.pdfFilename || task.attachmentKey || String(task.attachmentID || "PDF"),
      pdf: task.pdfFilename || "",
      markdown: task.markdownFilename || "",
      existing: task.existingMarkdownLabel || "",
      reason: task.reason || task.error || ""
    };
  },

  async convertAttachments(attachments, settings, options = {}) {
    let interactive = options.interactive !== false;
    let uniqueAttachments = this.uniqueAttachments(attachments);
    let result = {
      created: 0,
      skipped: 0,
      failed: 0
    };

    for (let index = 0; index < uniqueAttachments.length; index++) {
      let attachment = uniqueAttachments[index];
      if (this.runningAttachmentIDs.has(attachment.id)) {
        this.log(`Skipping already running attachment ${attachment.key}`);
        result.skipped++;
        continue;
      }

      this.runningAttachmentIDs.add(attachment.id);
      try {
        let parentItem = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
        let label = parentItem?.getField?.("title") || attachment.attachmentFilename || this.formatAttachmentLabel(attachment);
        this.setActiveConversion({
          status: "running",
          label,
          percent: 1,
          message: "Starting conversion...",
          queueCurrent: index + 1,
          queueTotal: uniqueAttachments.length
        });
        let conversion = await this.convertPDFAttachment(attachment, settings, {
          interactive,
          progressSink: update => this.setActiveConversion({
            ...update,
            status: "running",
            label,
            queueCurrent: index + 1,
            queueTotal: uniqueAttachments.length
          })
        });
        if (conversion?.status === "created") {
          result.created++;
          this.setActiveConversion({
            status: "done",
            label,
            percent: 100,
            message: "Markdown attached.",
            queueCurrent: index + 1,
            queueTotal: uniqueAttachments.length
          });
          this.log(`Converted ${this.formatAttachmentLabel(attachment)}`);
        }
        else {
          result.skipped++;
          this.setActiveConversion({
            status: "skipped",
            label,
            percent: 100,
            message: "Skipped by current existing-Markdown policy.",
            queueCurrent: index + 1,
            queueTotal: uniqueAttachments.length
          });
        }
      }
      catch (error) {
        result.failed++;
        this.setActiveConversion({
          status: "failed",
          label: this.formatAttachmentLabel(attachment),
          percent: 100,
          message: this.formatError(error),
          queueCurrent: index + 1,
          queueTotal: uniqueAttachments.length
        });
        Zotero.logError(error);
        if (interactive) {
          this.alert(this.formatError(error));
        }
        else {
          this.warn(`Auto convert failed for ${this.formatAttachmentLabel(attachment)}: ${this.formatError(error)}`);
        }
      }
      finally {
        this.runningAttachmentIDs.delete(attachment.id);
      }
    }

    return result;
  },

  async convertPDFAttachment(pdfAttachment, settings, options = {}) {
    let interactive = options.interactive !== false;
    let progressSink = typeof options.progressSink === "function" ? options.progressSink : null;
    let pdfPath = await pdfAttachment.getFilePathAsync();
    if (!pdfPath) {
      throw new Error("The selected PDF is not available locally. Download it in Zotero first.");
    }

    let parentItem = this.getOutputParentItem(pdfAttachment);
    let outputInfo = this.getMarkdownOutputInfo(pdfAttachment, pdfPath, settings);
    let effectiveSettings = await this.getEffectiveSettingsForAttachment(pdfAttachment, settings);
    let existing = this.findExistingMarkdownAttachment(parentItem, outputInfo.filename);
    if (existing && settings.onExisting === "skip") {
      let message = `Markdown already exists for "${parentItem.getField("title")}".`;
      if (interactive) {
        this.alert(message);
      }
      else {
        this.log(message);
      }
      return { status: "skipped" };
    }
    if (existing && settings.onExisting === "version") {
      outputInfo = this.getVersionedMarkdownOutputInfo(outputInfo);
    }

    let progress = this.createProgress(`Converting "${parentItem.getField("title") || pdfAttachment.attachmentFilename}"`);
    let reportProgress = (percent, message, extra = {}) => {
      let boundedPercent = Number.isFinite(percent) ? Math.max(1, Math.min(100, Math.round(percent))) : null;
      if (boundedPercent !== null) {
        progress.item.setProgress(boundedPercent);
      }
      if (message) {
        progress.item.setText(message);
      }
      if (progressSink) {
        progressSink({
          percent: boundedPercent,
          message: message || "",
          ...extra
        });
      }
    };
    let tempDir = null;
    try {
      reportProgress(5, "Requesting MinerU upload URL...");
      let uploadTask = await this.createMinerUUploadTask(pdfAttachment, pdfPath, parentItem, effectiveSettings);

      reportProgress(15, "Uploading PDF to MinerU...");
      await this.uploadFile(uploadTask.fileURL, pdfPath);

      reportProgress(25, "Waiting for MinerU extraction...");
      let result = await this.pollBatchResult(uploadTask.batchID, uploadTask.dataID, effectiveSettings, progress, progressSink);

      reportProgress(82, "Downloading MinerU result...");
      tempDir = await this.createTempDirectory();
      let zipPath = PathUtils.join(tempDir, "mineru-result.zip");
      await Zotero.HTTP.download(result.full_zip_url, zipPath, { timeout: 0 });

      reportProgress(88, "Preparing Markdown attachment...");
      await this.extractZip(zipPath, tempDir);
      if (!settings.keepRawZip) {
        await IOUtils.remove(zipPath, { ignoreAbsent: true });
      }

      let markdown = await this.findMarkdownFile(tempDir);
      if (!markdown) {
        throw new Error("MinerU result did not contain full.md or another Markdown file.");
      }
      markdown = await this.organizeMinerUOutputDirectory(tempDir, markdown, settings, pdfPath);
      markdown = await this.renameMarkdownFile(markdown, outputInfo.filename);

      await this.writeMetadata(tempDir, {
        plugin: "paper-markdown",
        pluginVersion: this.version,
        createdAt: new Date().toISOString(),
        zotero: {
          parentItemKey: parentItem.key,
          pdfAttachmentKey: pdfAttachment.key,
          pdfFilename: pdfAttachment.attachmentFilename,
          markdownAttachmentTitle: outputInfo.attachmentTitle,
          markdownFilename: outputInfo.filename
        },
        mineru: {
          batchID: uploadTask.batchID,
          dataID: uploadTask.dataID,
          modelVersion: effectiveSettings.modelVersion,
          language: effectiveSettings.language,
          isOCR: effectiveSettings.isOCR,
          autoOCR: settings.autoOCR,
          result: result
        }
      });

      let markdownAttachment = await this.createStoredMarkdownAttachment({
        parentItem,
        directory: tempDir,
        relativeMarkdownPath: markdown.relativePath,
        title: outputInfo.attachmentTitle
      });
      tempDir = null;

      if (existing && settings.onExisting === "overwrite") {
        await existing.eraseTx();
      }

      if (settings.tagConverted) {
        await this.tagParentItem(parentItem, "paper-markdown:converted");
      }

      reportProgress(100, `Attached Markdown: ${markdownAttachment.getField("title")}`);
      progress.window.startCloseTimer(5000);
      return {
        status: "created",
        attachment: markdownAttachment
      };
    }
    catch (error) {
      if (tempDir) {
        await IOUtils.remove(tempDir, { recursive: true, ignoreAbsent: true }).catch(e => Zotero.logError(e));
      }
      progress.item.setError();
      progress.item.setText(this.formatError(error));
      if (progressSink) {
        progressSink({
          percent: 100,
          message: this.formatError(error),
          status: "failed"
        });
      }
      progress.window.startCloseTimer(10000);
      throw error;
    }
  },

  async attachMinerUResult(prepared, result, settings) {
    let tempDir = null;
    try {
      tempDir = await this.createTempDirectory();
      let zipPath = PathUtils.join(tempDir, "mineru-result.zip");
      await Zotero.HTTP.download(result.full_zip_url, zipPath, { timeout: 0 });

      await this.extractZip(zipPath, tempDir);
      if (!settings.keepRawZip) {
        await IOUtils.remove(zipPath, { ignoreAbsent: true });
      }

      let markdown = await this.findMarkdownFile(tempDir);
      if (!markdown) {
        throw new Error("MinerU result did not contain full.md or another Markdown file.");
      }
      markdown = await this.organizeMinerUOutputDirectory(tempDir, markdown, settings, prepared.pdfPath);
      markdown = await this.renameMarkdownFile(markdown, prepared.outputInfo.filename);

      await this.writeMetadata(tempDir, {
        plugin: "paper-markdown",
        pluginVersion: this.version,
        createdAt: new Date().toISOString(),
        zotero: {
          parentItemKey: prepared.parentItem.key,
          pdfAttachmentKey: prepared.attachment.key,
          pdfFilename: prepared.attachment.attachmentFilename,
          markdownAttachmentTitle: prepared.outputInfo.attachmentTitle,
          markdownFilename: prepared.outputInfo.filename
        },
        mineru: {
          batchID: result.batch_id || result.batchID || "",
          dataID: prepared.dataID,
          modelVersion: prepared.effectiveSettings?.modelVersion || settings.modelVersion,
          language: prepared.effectiveSettings?.language || settings.language,
          isOCR: prepared.effectiveSettings?.isOCR ?? settings.isOCR,
          autoOCR: settings.autoOCR,
          result
        }
      });

      let markdownAttachment = await this.createStoredMarkdownAttachment({
        parentItem: prepared.parentItem,
        directory: tempDir,
        relativeMarkdownPath: markdown.relativePath,
        title: prepared.outputInfo.attachmentTitle
      });
      tempDir = null;

      if (prepared.existing && settings.onExisting === "overwrite") {
        await prepared.existing.eraseTx();
      }

      if (settings.tagConverted) {
        await this.tagParentItem(prepared.parentItem, "paper-markdown:converted");
      }

      return markdownAttachment;
    }
    catch (error) {
      if (tempDir) {
        await IOUtils.remove(tempDir, { recursive: true, ignoreAbsent: true }).catch(e => Zotero.logError(e));
      }
      throw error;
    }
  },

  getOutputParentItem(pdfAttachment) {
    if (!pdfAttachment.parentID) {
      throw new Error("Standalone PDF attachments are not supported yet. Create a parent item first.");
    }
    return Zotero.Items.get(pdfAttachment.parentID);
  },

  async getEffectiveSettingsForAttachment(attachment, settings) {
    if (!settings.autoOCR) {
      return settings;
    }
    let hasTextLayer = await this.attachmentHasTextLayer(attachment);
    return {
      ...settings,
      isOCR: !hasTextLayer
    };
  },

  async attachmentHasTextLayer(attachment) {
    try {
      let cacheFile = Zotero.Fulltext?.getItemCacheFile?.(attachment);
      let cachePath = cacheFile?.path;
      if (!cachePath || !(await IOUtils.exists(cachePath))) {
        return false;
      }
      let text = await Zotero.File.getContentsAsync(cachePath, "utf-8");
      return this.hasMeaningfulText(text);
    }
    catch (error) {
      this.warn(`Auto OCR could not inspect text layer for ${this.formatAttachmentLabel(attachment)}: ${this.formatError(error)}`);
      return false;
    }
  },

  hasMeaningfulText(text) {
    let compact = String(text || "").replace(/\s+/g, "");
    return compact.length >= 200 && /[A-Za-z\u4e00-\u9fff]/.test(compact);
  },

  async tagParentItem(parentItem, tag) {
    if (!parentItem?.addTag) return;
    try {
      parentItem.addTag(tag);
      await parentItem.saveTx();
    }
    catch (error) {
      this.warn(`Could not tag ${parentItem.key}: ${this.formatError(error)}`);
    }
  },

  getMarkdownOutputInfo(pdfAttachment, pdfPath, settings = null) {
    let parentItem = this.getOutputParentItem(pdfAttachment);
    let baseName = this.getTemplateDerivedBaseName(parentItem, pdfAttachment, settings || this.getSettings())
      || this.getPDFDerivedBaseName(pdfAttachment, pdfPath);
    let filename = `${baseName}.md`;
    return {
      attachmentTitle: this.MARKDOWN_ATTACHMENT_TITLE,
      filename
    };
  },

  getTemplateDerivedBaseName(parentItem, pdfAttachment, settings) {
    let attachmentTitle = pdfAttachment?.getField?.("title") || pdfAttachment?.attachmentFilename || "";
    let attempts = [];

    if (settings.useZoteroRenameTemplate) {
      attempts.push({
        label: "Zotero file renaming template",
        options: { attachmentTitle }
      });
    }

    let fallbackTemplate = settings.filenameTemplate || this.DEFAULT_FILENAME_TEMPLATE;
    attempts.push({
      label: "Paper Markdown filename template",
      options: {
        attachmentTitle,
        formatString: fallbackTemplate
      }
    });

    for (let attempt of attempts) {
      try {
        let baseName = Zotero.Attachments.getFileBaseNameFromItem(parentItem, attempt.options);
        baseName = this.normalizeMarkdownBaseName(baseName);
        if (baseName) {
          return baseName;
        }
      }
      catch (error) {
        this.warnOnce(
          `filename-template-${attempt.label}`,
          `${attempt.label} failed; falling back to the next filename source: ${this.formatError(error)}`
        );
      }
    }

    return "";
  },

  getVersionedMarkdownOutputInfo(outputInfo) {
    let stem = this.removeMarkdownExtension(outputInfo.filename);
    let filename = `${stem} ${this.getTimestampSuffix()}.md`;
    return {
      attachmentTitle: outputInfo.attachmentTitle || this.MARKDOWN_ATTACHMENT_TITLE,
      filename
    };
  },

  getPDFDerivedBaseName(pdfAttachment, pdfPath) {
    let filename = pdfAttachment.attachmentFilename || (pdfPath ? PathUtils.filename(pdfPath) : "");
    let baseName = filename || pdfAttachment.key || "Paper";

    if (baseName.toLowerCase().endsWith(".pdf")) {
      baseName = baseName.slice(0, -4);
    }
    else {
      baseName = baseName.replace(/\.[^.]+$/, "");
    }

    return this.sanitizeFilename(baseName) || "Paper";
  },

  normalizeMarkdownBaseName(baseName) {
    let clean = this.sanitizeFilename(baseName);
    clean = clean.replace(/\.(pdf|md)$/i, "");
    return clean || "";
  },

  sanitizeFilename(filename) {
    let clean = String(filename || "")
      .replace(/[\/\\:\x00-\x1F\x7F]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    clean = clean.replace(/^\.+$/, "").replace(/^\.+/, "");
    return clean || "Paper";
  },

  removeMarkdownExtension(filename) {
    return String(filename || "").replace(/\.md$/i, "");
  },

  getTimestampSuffix() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  },

  findExistingMarkdownAttachment(parentItem, outputFilename) {
    for (let attachmentID of parentItem.getAttachments()) {
      let attachment = Zotero.Items.get(attachmentID);
      if (!attachment) continue;

      let contentType = attachment.attachmentContentType;
      let isMarkdown = contentType === "text/markdown"
        || contentType === "text/x-markdown"
        || attachment.attachmentFilename?.toLowerCase().endsWith(".md")
        || attachment.attachmentPath?.toLowerCase().endsWith(".md")
        || attachment.getField("title") === this.MARKDOWN_ATTACHMENT_TITLE
        || attachment.getField("title")?.startsWith("Markdown - ");
      if (!isMarkdown) continue;

      let title = attachment.getField("title") || "";
      let filename = attachment.attachmentFilename || "";
      let path = attachment.attachmentPath || "";
      if (this.markdownNameMatches(filename, outputFilename)
          || this.markdownNameMatches(path, outputFilename)
          || this.markdownNameMatches(title, outputFilename)
          || title === this.MARKDOWN_ATTACHMENT_TITLE
          || title.startsWith("Markdown - ")) {
        return attachment;
      }
    }
    return null;
  },

  markdownNameMatches(value, outputFilename) {
    if (!value || !outputFilename) return false;
    if (value === outputFilename) return true;

    let expectedStem = this.removeMarkdownExtension(outputFilename);
    let valueStem = this.removeMarkdownExtension(value);
    let valueBasename = valueStem.split(/[\\/]/).pop() || valueStem.replace(/^storage:/, "");
    return valueStem === expectedStem
      || valueStem.startsWith(expectedStem + " ")
      || valueBasename === expectedStem
      || valueBasename.startsWith(expectedStem + " ");
  },

  formatMarkdownAttachmentLabel(attachment) {
    return attachment?.attachmentFilename
      || attachment?.attachmentPath?.replace(/^storage:/, "")
      || attachment?.getField?.("title")
      || attachment?.key
      || "";
  },

  getMinerUDataID(parentItem, pdfAttachment) {
    return `zotero_${parentItem.key}_${pdfAttachment.key}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  },

  async createMinerUUploadTask(pdfAttachment, pdfPath, parentItem, settings) {
    let dataID = this.getMinerUDataID(parentItem, pdfAttachment);
    let file = {
      name: pdfAttachment.attachmentFilename || PathUtils.filename(pdfPath),
      data_id: dataID,
      is_ocr: settings.isOCR
    };
    if (settings.pageRanges) {
      file.page_ranges = settings.pageRanges;
    }

    let payload = {
      files: [file],
      model_version: settings.modelVersion,
      language: settings.language,
      enable_formula: settings.enableFormula,
      enable_table: settings.enableTable
    };

    let response = await this.requestJSON(`${this.API_BASE}/file-urls/batch`, {
      method: "POST",
      token: settings.apiToken,
      body: payload
    });

    let batchID = response.data?.batch_id;
    let fileURL = response.data?.file_urls?.[0];
    if (!batchID || !fileURL) {
      throw new Error("MinerU did not return a batch_id and upload URL.");
    }

    return { batchID, fileURL, dataID };
  },

  async createMinerUBatchUploadTask(prepared, settings) {
    let files = prepared.map(item => {
      let file = {
        name: item.attachment.attachmentFilename || PathUtils.filename(item.pdfPath),
        data_id: item.dataID,
        is_ocr: item.effectiveSettings?.isOCR ?? settings.isOCR
      };
      if (settings.pageRanges) {
        file.page_ranges = settings.pageRanges;
      }
      return file;
    });

    let payload = {
      files,
      model_version: settings.modelVersion,
      language: settings.language,
      enable_formula: settings.enableFormula,
      enable_table: settings.enableTable
    };

    let response = await this.requestJSON(`${this.API_BASE}/file-urls/batch`, {
      method: "POST",
      token: settings.apiToken,
      body: payload
    });

    let batchID = response.data?.batch_id;
    let fileURLs = response.data?.file_urls || [];
    if (!batchID || !fileURLs) {
      throw new Error("MinerU did not return a batch_id and upload URLs.");
    }

    return { batchID, fileURLs };
  },

  async uploadPreparedFiles(batch, prepared, settings) {
    let uploaded = [];
    let total = prepared.length;
    let completed = 0;

    await this.runWithConcurrency(prepared, settings.uploadConcurrency, async (item, index) => {
      let task = item.task;
      try {
        task.status = "uploading";
        let fileURL = this.getBatchFileURL(batch.fileURLs, index, item.dataID);
        this.setActiveConversion({
          status: "running",
          label: this.formatTaskLabel(task),
          percent: 15,
          message: `Uploading PDF to MinerU (${completed + 1}/${total})...`,
          queueCurrent: this.queueState.current,
          queueTotal: this.queueState.total
        });
        await this.uploadFile(fileURL, item.pdfPath);
        task.status = "uploaded";
        uploaded.push(item);
        completed++;
      }
      catch (error) {
        completed++;
        this.failPreparedTask(item, error);
      }
    });

    this.setActiveConversion({
      status: "running",
      label: `MinerU batch ${batch.batchID}`,
      percent: 25,
      message: `Uploaded ${uploaded.length}/${total} PDFs; waiting for MinerU extraction...`,
      queueCurrent: this.queueState.current,
      queueTotal: this.queueState.total
    });
    return uploaded;
  },

  getBatchFileURL(fileURLs, index, dataID) {
    if (Array.isArray(fileURLs)) {
      let byID = fileURLs.find(item => item && typeof item === "object" && item.data_id === dataID);
      let item = byID || fileURLs[index];
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        return item.file_url || item.fileURL || item.url;
      }
    }
    else if (fileURLs && typeof fileURLs === "object") {
      let item = fileURLs[dataID] || fileURLs[String(index)];
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        return item.file_url || item.fileURL || item.url;
      }
    }
    throw new Error("MinerU did not return an upload URL for one PDF.");
  },

  async pollBatchResults(batchID, prepared, settings, progressSink = null) {
    let startedAt = Date.now();
    let url = `${this.API_BASE}/extract-results/batch/${encodeURIComponent(batchID)}`;
    let pending = new Map(prepared.map(item => [item.dataID, item]));
    let resultsByID = new Map();
    let failuresByID = new Map();

    while (Date.now() - startedAt < settings.pollTimeoutMs) {
      let response = await this.requestJSON(url, {
        method: "GET",
        token: settings.apiToken
      });

      let results = response.data?.extract_result || [];
      for (let result of results) {
        let dataID = result.data_id;
        if (!pending.has(dataID)) continue;

        let item = pending.get(dataID);
        let task = item.task;
        let state = result.state;
        task.mineruState = state;
        if (state === "done") {
          if (!result.full_zip_url) {
            failuresByID.set(dataID, new Error("MinerU marked the task done but did not return full_zip_url."));
          }
          else {
            resultsByID.set(dataID, { ...result, batch_id: batchID });
            task.status = "extracted";
          }
          pending.delete(dataID);
          continue;
        }
        if (state === "failed") {
          failuresByID.set(dataID, new Error(result.err_msg || "MinerU extraction failed."));
          pending.delete(dataID);
          continue;
        }

        task.status = "extracting";
        if (result.extract_progress) {
          task.extractProgress = result.extract_progress;
        }
      }

      let done = prepared.length - pending.size;
      let percent = Math.max(30, Math.min(85, 30 + Math.round((done / prepared.length) * 55)));
      let message = `MinerU extracting batch ${batchID}: ${done}/${prepared.length} PDFs done`;
      let firstPending = pending.values().next().value;
      if (firstPending?.task?.extractProgress?.total_pages) {
        let progress = firstPending.task.extractProgress;
        message += `; current ${progress.extracted_pages}/${progress.total_pages} pages`;
      }
      progressSink?.({ percent, message });

      if (!pending.size) {
        return { results: resultsByID, failures: failuresByID };
      }
      await this.delay(settings.pollIntervalMs);
    }

    for (let [dataID] of pending) {
      failuresByID.set(dataID, new Error(`MinerU extraction timed out after ${Math.round(settings.pollTimeoutMs / 1000)} seconds.`));
    }
    return { results: resultsByID, failures: failuresByID };
  },

  async runWithConcurrency(items, concurrency, worker) {
    let nextIndex = 0;
    let workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        let index = nextIndex++;
        await worker(items[index], index);
      }
    }));
  },

  async uploadFile(fileURL, filePath) {
    let bytes = await IOUtils.read(filePath);
    let response = await fetch(fileURL, {
      method: "PUT",
      body: bytes
    });
    if (!response.ok) {
      throw new Error(`MinerU upload failed with HTTP ${response.status}.`);
    }
  },

  async pollBatchResult(batchID, dataID, settings, progress, progressSink = null) {
    let startedAt = Date.now();
    let url = `${this.API_BASE}/extract-results/batch/${encodeURIComponent(batchID)}`;

    while (Date.now() - startedAt < settings.pollTimeoutMs) {
      let response = await this.requestJSON(url, {
        method: "GET",
        token: settings.apiToken
      });

      let results = response.data?.extract_result || [];
      let result = results.find(item => item.data_id === dataID) || results[0];
      if (result) {
        let state = result.state;
        if (state === "done") {
          if (!result.full_zip_url) {
            throw new Error("MinerU marked the task done but did not return full_zip_url.");
          }
          return result;
        }
        if (state === "failed") {
          throw new Error(result.err_msg || "MinerU extraction failed.");
        }
        this.updateProgressFromMinerU(progress, state, result.extract_progress, progressSink);
      }

      await this.delay(settings.pollIntervalMs);
    }

    throw new Error(`MinerU extraction timed out after ${Math.round(settings.pollTimeoutMs / 1000)} seconds.`);
  },

  updateProgressFromMinerU(progress, state, extractProgress, progressSink = null) {
    if (extractProgress?.total_pages) {
      let percent = Math.max(30, Math.min(80,
        30 + Math.round((extractProgress.extracted_pages / extractProgress.total_pages) * 50)
      ));
      let message = `MinerU ${state}: ${extractProgress.extracted_pages}/${extractProgress.total_pages} pages`;
      progress.item.setProgress(percent);
      progress.item.setText(message);
      progressSink?.({
        percent,
        message,
        mineruState: state,
        extractedPages: extractProgress.extracted_pages,
        totalPages: extractProgress.total_pages
      });
      return;
    }
    let message = `MinerU ${state || "running"}...`;
    progress.item.setText(message);
    progressSink?.({
      percent: 35,
      message,
      mineruState: state || "running"
    });
  },

  async testMinerUAPI() {
    let settings = this.getSettings();
    if (!settings.apiToken) {
      throw new Error("Please set your MinerU API Token first.");
    }

    let url = `${this.API_BASE}/extract-results/batch/paper-markdown-api-test-${Date.now()}`;
    let response = await fetch(url, {
      method: "GET",
      headers: new Headers({
        "Accept": "application/json",
        "Authorization": `Bearer ${settings.apiToken}`
      })
    });
    let text = await response.text();
    let data = this.parseMaybeJSON(text);
    let message = data?.msg || data?.message || text || `HTTP ${response.status}`;

    if (response.status === 401 || response.status === 403) {
      throw new Error(`MinerU rejected the API token: ${message}`);
    }
    if (data?.code !== undefined && data.code !== 0 && /token|auth|unauthor/i.test(message)) {
      throw new Error(`MinerU rejected the API token: ${message}`);
    }
    if (response.status >= 500) {
      throw new Error(`MinerU API is reachable but returned HTTP ${response.status}: ${message}`);
    }

    let result = {
      ok: true,
      status: response.status,
      message: response.ok
        ? "MinerU API is reachable and the token was accepted."
        : `MinerU API is reachable; token was not rejected (HTTP ${response.status}: ${message}).`
    };
    this.log(`MinerU API test passed: ${result.message}`);
    return result;
  },

  parseMaybeJSON(text) {
    try {
      return text ? JSON.parse(text) : {};
    }
    catch (error) {
      return null;
    }
  },

  async requestJSON(url, { method, token, body }) {
    let headers = new Headers({
      "Accept": "application/json"
    });
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    let response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    }
    catch (error) {
      throw new Error(`MinerU returned non-JSON response: HTTP ${response.status}.`);
    }

    if (!response.ok) {
      throw new Error(`MinerU request failed with HTTP ${response.status}: ${data.msg || text}`);
    }
    if (data.code !== 0) {
      throw new Error(`MinerU request failed: ${data.msg || data.code}`);
    }
    return data;
  },

  async createTempDirectory() {
    let storageDir = Zotero.getStorageDirectory().path;
    let name = `tmp-paper-markdown-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let tempDir = PathUtils.join(storageDir, name);
    await IOUtils.makeDirectory(tempDir, { permissions: 0o755 });
    return tempDir;
  },

  async extractZip(zipPath, destDir) {
    let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zipReader.open(Zotero.File.pathToFile(zipPath));
    try {
      let entries = zipReader.findEntries("*");
      while (entries.hasMore()) {
        let entryName = entries.getNext();
        if (!this.isSafeZipEntry(entryName)) {
          this.warn(`Skipping unsafe zip entry ${entryName}`);
          continue;
        }

        let targetPath = PathUtils.join(destDir, ...entryName.split("/").filter(Boolean));
        let entry = zipReader.getEntry(entryName);
        if (entry.isDirectory) {
          await IOUtils.makeDirectory(targetPath, { ignoreExisting: true, permissions: 0o755 });
          continue;
        }

        await IOUtils.makeDirectory(PathUtils.parent(targetPath), { ignoreExisting: true, permissions: 0o755 });
        zipReader.extract(entryName, Zotero.File.pathToFile(targetPath));
      }
    }
    finally {
      zipReader.close();
    }
  },

  isSafeZipEntry(entryName) {
    return entryName
      && !entryName.startsWith("/")
      && !entryName.includes("\\")
      && !entryName.split("/").includes("..");
  },

  async findMarkdownFile(rootDir) {
    return (await this.findFileByName(rootDir, "full.md"))
      || (await this.findFirstFileWithExtension(rootDir, ".md"));
  },

  async organizeMinerUOutputDirectory(rootDir, markdown, settings, pdfPath = "") {
    let normalizedMarkdown = await this.renameMinerUImagesDirectory(rootDir, markdown, pdfPath);
    if (settings.normalizeHeadings) {
      normalizedMarkdown = await this.normalizeMarkdownHeadingLevels(normalizedMarkdown);
    }
    await this.removeUnusedMinerUArtifacts(rootDir, settings);
    return normalizedMarkdown;
  },

  async normalizeMarkdownHeadingLevels(markdown) {
    let text = await Zotero.File.getContentsAsync(markdown.path, "utf-8");
    let normalized = this.normalizeMarkdownHeadingText(text);
    if (normalized !== text) {
      await Zotero.File.putContentsAsync(markdown.path, normalized);
    }
    return markdown;
  },

  normalizeMarkdownHeadingText(text) {
    let lines = String(text || "").split("\n");
    let sawDocumentTitle = false;
    let sawMainSection = false;
    let changed = false;

    let normalized = lines.map((line) => {
      let match = line.match(/^(#{1,6})([ \t]+)(.+?)([ \t]*)$/);
      if (!match) return line;

      let headingText = match[3].trim();
      let targetLevel = null;
      if (!sawDocumentTitle && !this.isPaperMainSectionHeading(headingText)) {
        targetLevel = 1;
        sawDocumentTitle = true;
      }
      else {
        targetLevel = this.getPaperHeadingLevel(headingText, sawMainSection);
        if (!targetLevel && !sawDocumentTitle) {
          targetLevel = 1;
          sawDocumentTitle = true;
        }
      }

      if (!targetLevel) return line;
      if (targetLevel === 2) sawMainSection = true;
      let hashes = "#".repeat(Math.max(1, Math.min(6, targetLevel)));
      if (hashes !== match[1]) changed = true;
      return `${hashes}${match[2]}${match[3]}${match[4]}`;
    });

    return changed ? normalized.join("\n") : text;
  },

  getPaperHeadingLevel(headingText, sawMainSection) {
    if (this.isPaperMainSectionHeading(headingText)) return 2;

    let numbered = headingText.match(/^(\d+(?:\.\d+)+)\.?\s+\S/);
    if (numbered) {
      return Math.min(6, numbered[1].split(".").length + 1);
    }

    if (sawMainSection && /^[A-Z]\.\s+\S/.test(headingText)) {
      return 3;
    }

    return null;
  },

  isPaperMainSectionHeading(headingText) {
    let text = String(headingText || "").trim();
    if (this.isLikelyRomanSectionHeading(text)) return true;
    if (/^\d+[\.)]\s+\S/.test(text)) return true;
    if (/^(?:abstract|references|bibliography|acknowledg(?:e)?ments?|appendix(?:\s+[A-Z0-9]+)?|keywords|index terms)$/i.test(text)) {
      return true;
    }
    if (/^appendix\s+[A-Z0-9]+[:.]?\s+\S/i.test(text)) return true;
    return false;
  },

  isLikelyRomanSectionHeading(headingText) {
    let match = String(headingText || "").trim().match(/^([IVXLCDM]+)\.\s+\S/i);
    if (!match) return false;
    let token = match[1].toUpperCase();
    return /^[IVX]/.test(token);
  },

  async renameMinerUImagesDirectory(rootDir, markdown, pdfPath = "") {
    let imagesDir = PathUtils.join(rootDir, "images");
    let attachmentsDir = PathUtils.join(rootDir, "Attachments");
    let visualAssets = await this.collectMinerUVisualAssets(rootDir);
    if (await IOUtils.exists(imagesDir)) {
      await IOUtils.remove(attachmentsDir, { recursive: true, ignoreAbsent: true });
      await IOUtils.move(imagesDir, attachmentsDir);
    }
    else if (visualAssets.crops.length) {
      await IOUtils.makeDirectory(attachmentsDir, { ignoreExisting: true, permissions: 0o755 });
    }

    if (pdfPath && visualAssets.crops.length) {
      await this.renderMinerUVisualCrops(pdfPath, attachmentsDir, visualAssets);
    }

    let text = await Zotero.File.getContentsAsync(markdown.path, "utf-8");
    text = text
      .replace(/\]\(\.\/images\//g, "](Attachments/")
      .replace(/\]\(images\//g, "](Attachments/")
      .replace(/src=(["'])\.\/images\//g, "src=$1Attachments/")
      .replace(/src=(["'])images\//g, "src=$1Attachments/");
    text = this.applyAttachmentPathReplacements(text, visualAssets.replacements);
    text = this.appendMinerUPreservedImageSection(text, visualAssets);
    await Zotero.File.putContentsAsync(markdown.path, text);
    await this.pruneUnreferencedAttachmentFiles(attachmentsDir, text, visualAssets);
    return markdown;
  },

  async collectMinerUVisualAssets(rootDir) {
    let assets = {
      tables: new Set(),
      algorithms: new Set(),
      figures: new Set(),
      replacements: new Map(),
      crops: []
    };
    await this.walkFiles(rootDir, async ({ path }) => {
      let name = PathUtils.filename(path).toLowerCase();
      if (!name.endsWith(".json") || !name.includes("content")) {
        return null;
      }

      try {
        let text = await Zotero.File.getContentsAsync(path, "utf-8");
        this.collectVisualAssetsFromMinerUValue(JSON.parse(text), assets);
      }
      catch (error) {
        this.warn(`Could not inspect MinerU content list ${PathUtils.filename(path)} for visual crops: ${this.formatError(error)}`);
      }
      return null;
    });
    this.mergeAdjacentFigureCrops(assets);
    return assets;
  },

  collectVisualAssetsFromMinerUValue(value, assets) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (let item of value) {
        this.collectVisualAssetsFromMinerUValue(item, assets);
      }
      return;
    }

    let kind = this.getMinerUVisualKind(value);
    let attachmentPath = this.normalizeMinerUImagePathForAttachment(value.img_path || value.image_path);
    if (kind && attachmentPath) {
      this.addVisualAssetPath(assets, kind, attachmentPath);
    }
    if (kind) {
      let cropRequest = this.getMinerUVisualCropRequest(value, kind, assets.crops.length + 1, attachmentPath);
      if (cropRequest && !this.hasDuplicateCropRequest(assets.crops, cropRequest)) {
        assets.crops.push(cropRequest);
      }
    }

    for (let child of Object.values(value)) {
      this.collectVisualAssetsFromMinerUValue(child, assets);
    }
  },

  getMinerUVisualKind(value) {
    let type = String(value?.type || "").toLowerCase();
    if (type === "table" || value?.table_body !== undefined || value?.table_caption !== undefined || value?.table_footnote !== undefined) {
      return "table";
    }
    if (type === "algorithm"
      || type === "code"
      || value?.sub_type === "algorithm"
      || value?.code !== undefined
      || value?.code_body !== undefined
      || value?.code_caption !== undefined
      || value?.algorithm_content !== undefined
      || value?.algorithm_caption !== undefined) {
      return "algorithm";
    }
    if (type === "image" || type === "chart") {
      return "figure";
    }
    return "";
  },

  addVisualAssetPath(assets, kind, attachmentPath) {
    if (kind === "table") {
      assets.tables.add(attachmentPath);
    }
    else if (kind === "algorithm") {
      assets.algorithms.add(attachmentPath);
    }
    else if (kind === "figure") {
      assets.figures.add(attachmentPath);
    }
  },

  removeVisualAssetPath(assets, kind, attachmentPath) {
    if (kind === "table") {
      assets.tables.delete(attachmentPath);
    }
    else if (kind === "algorithm") {
      assets.algorithms.delete(attachmentPath);
    }
    else if (kind === "figure") {
      assets.figures.delete(attachmentPath);
    }
  },

  getMinerUVisualCropRequest(value, kind, index, sourceAttachmentPath = "") {
    let bbox = Array.isArray(value?.bbox) ? value.bbox.map(Number) : null;
    let pageIndex = Number(value?.page_idx);
    if (!bbox || bbox.length < 4 || !Number.isInteger(pageIndex) || pageIndex < 0) {
      return null;
    }
    if (!bbox.every(Number.isFinite) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
      return null;
    }
    return {
      kind,
      pageIndex,
      bbox,
      sourceAttachmentPath,
      filename: `${kind}-page-${pageIndex + 1}-${index}.png`
    };
  },

  hasDuplicateCropRequest(requests, candidate) {
    return requests.some(request => {
      if (request.kind !== candidate.kind || request.pageIndex !== candidate.pageIndex) return false;
      return request.bbox.every((value, index) => Math.abs(value - candidate.bbox[index]) < 1);
    });
  },

  mergeAdjacentFigureCrops(assets) {
    let figures = assets.crops
      .filter(request => request.kind === "figure")
      .sort((a, b) => {
        let pageDiff = a.pageIndex - b.pageIndex;
        if (pageDiff) return pageDiff;
        let yDiff = a.bbox[1] - b.bbox[1];
        if (Math.abs(yDiff) > 8) return yDiff;
        return a.bbox[0] - b.bbox[0];
      });
    let groups = [];

    for (let request of figures) {
      let group = groups.find(candidate => this.canMergeFigureIntoGroup(candidate, request));
      if (group) {
        group.requests.push(request);
        group.bbox = this.unionBBox(group.bbox, request.bbox);
      }
      else {
        groups.push({
          pageIndex: request.pageIndex,
          bbox: request.bbox.slice(),
          requests: [request]
        });
      }
    }

    let mergedRequests = [];
    let mergedMembers = new Set();
    for (let group of groups) {
      if (group.requests.length < 2) continue;
      let sourcePaths = group.requests
        .map(request => request.sourceAttachmentPath)
        .filter(Boolean);
      let merged = {
        kind: "figure",
        pageIndex: group.pageIndex,
        bbox: group.bbox,
        sourceAttachmentPath: sourcePaths[0] || "",
        sourceAttachmentPaths: sourcePaths,
        filename: `figure-page-${group.pageIndex + 1}-merged-${mergedRequests.length + 1}.png`
      };
      mergedRequests.push(merged);
      for (let request of group.requests) {
        mergedMembers.add(request);
      }
    }
    if (!mergedRequests.length) return;

    assets.crops = assets.crops
      .filter(request => !mergedMembers.has(request))
      .concat(mergedRequests);
  },

  canMergeFigureIntoGroup(group, request) {
    if (group.pageIndex !== request.pageIndex) return false;
    let overlap = this.verticalOverlapRatio(group.bbox, request.bbox);
    if (overlap < 0.65) return false;
    let gap = Math.max(0, request.bbox[0] - group.bbox[2], group.bbox[0] - request.bbox[2]);
    return gap <= 12;
  },

  verticalOverlapRatio(a, b) {
    let overlap = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    let shorter = Math.min(a[3] - a[1], b[3] - b[1]);
    return shorter > 0 ? overlap / shorter : 0;
  },

  unionBBox(a, b) {
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3])
    ];
  },

  normalizeMinerUImagePathForAttachment(imagePath) {
    let value = String(imagePath || "").trim().replace(/\\/g, "/");
    if (!value) return "";

    value = value.replace(/^\.?\//, "");
    if (value.startsWith("Attachments/")) {
      return this.safeDecodeURI(value);
    }
    if (value.startsWith("images/")) {
      return this.safeDecodeURI(`Attachments/${value.slice("images/".length)}`);
    }

    let imagesIndex = value.indexOf("/images/");
    if (imagesIndex !== -1) {
      return this.safeDecodeURI(`Attachments/${value.slice(imagesIndex + "/images/".length)}`);
    }
    return this.safeDecodeURI(`Attachments/${value}`);
  },

  async renderMinerUVisualCrops(pdfPath, attachmentsDir, visualAssets) {
    let pdftoppm = await this.findExecutable("pdftoppm", [
      "/opt/homebrew/bin/pdftoppm",
      "/usr/local/bin/pdftoppm",
      "/usr/bin/pdftoppm",
      "/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm"
    ]);
    let pdfinfo = await this.findExecutable("pdfinfo", [
      "/opt/homebrew/bin/pdfinfo",
      "/usr/local/bin/pdfinfo",
      "/usr/bin/pdfinfo",
      "/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdfinfo"
    ]);
    if (!pdftoppm || !pdfinfo) {
      this.warn("PDF visual cropping skipped because pdftoppm or pdfinfo was not found; keeping MinerU images where available.");
      return;
    }

    let pageSizeCache = new Map();
    for (let request of visualAssets.crops.slice(0, 80)) {
      try {
        let pageNumber = request.pageIndex + 1;
        let pageSize = pageSizeCache.get(pageNumber);
        if (!pageSize) {
          pageSize = await this.getPDFPageSize(pdfinfo, pdfPath, pageNumber);
          pageSizeCache.set(pageNumber, pageSize);
        }

        let outputPath = await this.renderPDFCropWithPdftoppm(pdftoppm, pdfPath, request, pageSize);
        let targetPath = PathUtils.join(attachmentsDir, request.filename);
        await IOUtils.remove(targetPath, { ignoreAbsent: true });
        await IOUtils.move(outputPath, targetPath);
        await IOUtils.remove(PathUtils.parent(outputPath), { recursive: true, ignoreAbsent: true }).catch(e => Zotero.logError(e));
        let croppedAttachmentPath = `Attachments/${request.filename}`;
        let sourcePaths = request.sourceAttachmentPaths || (request.sourceAttachmentPath ? [request.sourceAttachmentPath] : []);
        for (let sourcePath of sourcePaths) {
          this.removeVisualAssetPath(visualAssets, request.kind, sourcePath);
        }
        this.addVisualAssetPath(visualAssets, request.kind, croppedAttachmentPath);
        for (let sourcePath of sourcePaths) {
          visualAssets.replacements.set(sourcePath, croppedAttachmentPath);
        }
      }
      catch (error) {
        this.warn(`Could not crop ${request.kind} image on page ${request.pageIndex + 1}: ${this.formatError(error)}`);
      }
    }
  },

  async getPDFPageSize(pdfinfo, pdfPath, pageNumber) {
    let tempDir = await this.createTempDirectory();
    try {
      let outputPath = PathUtils.join(tempDir, "pdfinfo.txt");
      await this.runShellCommand(`${this.shellQuote(pdfinfo)} -f ${pageNumber} -l ${pageNumber} ${this.shellQuote(pdfPath)} > ${this.shellQuote(outputPath)}`);
      let text = await Zotero.File.getContentsAsync(outputPath, "utf-8");
      let pageSpecific = new RegExp(`Page\\s+${pageNumber}\\s+size:\\s+([0-9.]+)\\s+x\\s+([0-9.]+)\\s+pts`, "i").exec(text);
      let generic = /Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/i.exec(text);
      let match = pageSpecific || generic;
      if (!match) {
        throw new Error("pdfinfo did not report page size.");
      }
      return {
        widthPt: Number(match[1]),
        heightPt: Number(match[2])
      };
    }
    finally {
      await IOUtils.remove(tempDir, { recursive: true, ignoreAbsent: true }).catch(e => Zotero.logError(e));
    }
  },

  async renderPDFCropWithPdftoppm(pdftoppm, pdfPath, request, pageSize) {
    let cropDir = await this.createTempDirectory();
    try {
      let dpi = 300;
      let scale = dpi / 72;
      let paddingPt = request.kind === "figure" ? 4 : 2;
      let x0Pt = Math.max(0, (request.bbox[0] / 1000) * pageSize.widthPt - paddingPt);
      let y0Pt = Math.max(0, (request.bbox[1] / 1000) * pageSize.heightPt - paddingPt);
      let x1Pt = Math.min(pageSize.widthPt, (request.bbox[2] / 1000) * pageSize.widthPt + paddingPt);
      let y1Pt = Math.min(pageSize.heightPt, (request.bbox[3] / 1000) * pageSize.heightPt + paddingPt);
      let outputRoot = PathUtils.join(cropDir, "visual-crop");
      let args = [
        "-png",
        "-f", String(request.pageIndex + 1),
        "-l", String(request.pageIndex + 1),
        "-r", String(dpi),
        "-x", String(Math.max(0, Math.round(x0Pt * scale))),
        "-y", String(Math.max(0, Math.round(y0Pt * scale))),
        "-W", String(Math.max(1, Math.round((x1Pt - x0Pt) * scale))),
        "-H", String(Math.max(1, Math.round((y1Pt - y0Pt) * scale))),
        pdfPath,
        outputRoot
      ];
      await this.runProcess(pdftoppm, args);
      let output = await this.findFirstFileWithExtension(cropDir, ".png");
      if (!output) {
        throw new Error("pdftoppm did not create a PNG crop.");
      }
      return output.path;
    }
    catch (error) {
      await IOUtils.remove(cropDir, { recursive: true, ignoreAbsent: true }).catch(e => Zotero.logError(e));
      throw error;
    }
  },

  async findExecutable(name, candidates = []) {
    let allCandidates = [...candidates];
    try {
      let pathValue = Services.env.get("PATH") || "";
      for (let directory of pathValue.split(":")) {
        if (directory) allCandidates.push(PathUtils.join(directory, name));
      }
    }
    catch (_) {}

    let seen = new Set();
    for (let candidate of allCandidates) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (await IOUtils.exists(candidate)) {
        return candidate;
      }
    }
    return "";
  },

  runProcess(executablePath, args) {
    return new Promise((resolve, reject) => {
      try {
        let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(executablePath);
        let process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
        process.init(file);
        process.runwAsync(args, args.length, {
          observe: () => {
            if (process.exitValue === 0) resolve();
            else reject(new Error(`${PathUtils.filename(executablePath)} exited with code ${process.exitValue}`));
          }
        }, false);
      }
      catch (error) {
        reject(error);
      }
    });
  },

  async runShellCommand(command) {
    let shell = await this.findExecutable("sh", ["/bin/sh", "/usr/bin/sh"]);
    if (!shell) {
      throw new Error("Shell executable was not found.");
    }
    return this.runProcess(shell, ["-c", command]);
  },

  shellQuote(value) {
    return `'${String(value || "").replace(/'/g, "'\\''")}'`;
  },

  applyAttachmentPathReplacements(markdownText, replacements) {
    let text = String(markdownText || "");
    for (let [fromPath, toPath] of replacements || []) {
      if (!fromPath || !toPath || fromPath === toPath) continue;
      text = text.split(fromPath).join(toPath);
      text = text.split(this.encodeMarkdownImagePath(fromPath)).join(this.encodeMarkdownImagePath(toPath));
    }
    return text;
  },

  appendMinerUPreservedImageSection(markdownText, preservedImagePaths) {
    let groups = [
      { title: "Table Images", paths: preservedImagePaths?.tables || new Set(), label: "Table" },
      { title: "Algorithm Images", paths: preservedImagePaths?.algorithms || new Set(), label: "Algorithm" },
      { title: "Figure Images", paths: preservedImagePaths?.figures || new Set(), label: "Figure" }
    ];
    if (!groups.some(group => group.paths.size)) {
      return markdownText;
    }

    let referenced = this.getReferencedAttachmentPaths(markdownText);
    let sections = [];
    for (let group of groups) {
      let missing = [...group.paths]
        .filter(path => !referenced.has(path))
        .sort();
      if (!missing.length) {
        continue;
      }
      let lines = missing.map((path, index) => `![${group.label} ${index + 1}](${this.encodeMarkdownImagePath(path)})`);
      sections.push(`## ${group.title}\n\n${lines.join("\n\n")}`);
    }
    if (!sections.length) {
      return markdownText;
    }

    let text = String(markdownText || "").replace(/\s*$/, "");
    return `${text}\n\n${sections.join("\n\n")}\n`;
  },

  encodeMarkdownImagePath(path) {
    return String(path || "")
      .split("/")
      .map(part => encodeURIComponent(part))
      .join("/");
  },

  async pruneUnreferencedAttachmentFiles(attachmentsDir, markdownText, extraReferencedPaths = null) {
    if (!(await IOUtils.exists(attachmentsDir))) {
      return;
    }
    let referenced = this.getReferencedAttachmentPaths(markdownText);
    if (extraReferencedPaths instanceof Set) {
      for (let path of extraReferencedPaths) {
        referenced.add(path);
      }
    }
    else if (extraReferencedPaths && typeof extraReferencedPaths === "object") {
      for (let group of Object.values(extraReferencedPaths)) {
        if (!(group instanceof Set)) continue;
        for (let path of group || []) {
          referenced.add(path);
        }
      }
    }

    await this.walkFiles(attachmentsDir, async ({ path, relativePath }) => {
      let normalized = `Attachments/${relativePath}`;
      if (!referenced.has(normalized)) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
      return null;
    });
    await this.removeEmptyDirectories(attachmentsDir);
  },

  getReferencedAttachmentPaths(markdownText) {
    let referenced = new Set();
    let text = String(markdownText || "");
    let patterns = [
      /!\[[^\]]*]\((?:\.\/)?(Attachments\/[^)\s]+)[^)]*\)/g,
      /<img\b[^>]*\bsrc=["'](?:\.\/)?(Attachments\/[^"']+)["'][^>]*>/gi
    ];
    for (let pattern of patterns) {
      let match;
      while ((match = pattern.exec(text))) {
        referenced.add(this.safeDecodeURI(match[1]));
      }
    }
    return referenced;
  },

  safeDecodeURI(value) {
    try {
      return decodeURIComponent(value);
    }
    catch (_) {
      return value;
    }
  },

  async removeUnusedMinerUArtifacts(rootDir, settings) {
    await this.walkFiles(rootDir, async ({ path, relativePath }) => {
      let name = PathUtils.filename(path);
      let lower = name.toLowerCase();
      if (lower === "layout.json" || lower.endsWith("_origin.pdf")) {
        await IOUtils.remove(path, { ignoreAbsent: true });
        return null;
      }
      if (!settings.keepRawZip && lower === "mineru-result.zip") {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
      return null;
    });
  },

  async renameMarkdownFile(markdown, outputFilename) {
    let safeFilename = this.sanitizeFilename(outputFilename);
    if (!safeFilename.toLowerCase().endsWith(".md")) {
      safeFilename += ".md";
    }

    let targetPath = PathUtils.join(PathUtils.parent(markdown.path), safeFilename);
    let targetRelativePath = this.getRelativeSiblingPath(markdown.relativePath, safeFilename);
    if (markdown.path === targetPath) {
      return {
        path: markdown.path,
        relativePath: targetRelativePath
      };
    }

    await IOUtils.remove(targetPath, { ignoreAbsent: true });
    await IOUtils.move(markdown.path, targetPath);
    return {
      path: targetPath,
      relativePath: targetRelativePath
    };
  },

  getRelativeSiblingPath(relativePath, filename) {
    let slashIndex = String(relativePath || "").lastIndexOf("/");
    if (slashIndex === -1) {
      return filename;
    }
    return `${relativePath.slice(0, slashIndex + 1)}${filename}`;
  },

  async findFileByName(rootDir, targetName) {
    return this.walkFiles(rootDir, async ({ path, relativePath }) => {
      if (PathUtils.filename(path).toLowerCase() === targetName.toLowerCase()) {
        return { path, relativePath };
      }
      return null;
    });
  },

  async findFirstFileWithExtension(rootDir, extension) {
    return this.walkFiles(rootDir, async ({ path, relativePath }) => {
      if (PathUtils.filename(path).toLowerCase().endsWith(extension)) {
        return { path, relativePath };
      }
      return null;
    });
  },

  async walkFiles(rootDir, visitor, relativePrefix = "") {
    let children = await IOUtils.getChildren(rootDir);
    for (let child of children) {
      let name = PathUtils.filename(child);
      let relativePath = relativePrefix ? `${relativePrefix}/${name}` : name;
      let stat = await IOUtils.stat(child);
      if (stat.type === "directory") {
        let found = await this.walkFiles(child, visitor, relativePath);
        if (found) return found;
        continue;
      }

      let found = await visitor({ path: child, relativePath });
      if (found) return found;
    }
    return null;
  },

  async removeEmptyDirectories(rootDir) {
    if (!(await IOUtils.exists(rootDir))) return true;
    let children = await IOUtils.getChildren(rootDir);
    let isEmpty = true;
    for (let child of children) {
      let stat = await IOUtils.stat(child);
      if (stat.type === "directory") {
        let childEmpty = await this.removeEmptyDirectories(child);
        if (!childEmpty) isEmpty = false;
        continue;
      }
      isEmpty = false;
    }
    if (isEmpty) {
      await IOUtils.remove(rootDir, { recursive: true, ignoreAbsent: true });
    }
    return isEmpty;
  },

  async writeMetadata(tempDir, metadata) {
    let path = PathUtils.join(tempDir, "paper-markdown-meta.json");
    await Zotero.File.putContentsAsync(path, JSON.stringify(metadata, null, 2));
  },

  async createStoredMarkdownAttachment({ parentItem, directory, relativeMarkdownPath, title }) {
    let attachmentItem = new Zotero.Item("attachment");
    attachmentItem.libraryID = parentItem.libraryID;
    attachmentItem.parentID = parentItem.id;
    attachmentItem.setField("title", title);
    attachmentItem.attachmentLinkMode = Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
    attachmentItem.attachmentContentType = "text/markdown";
    attachmentItem.attachmentCharset = "utf-8";
    attachmentItem.attachmentPath = "storage:" + relativeMarkdownPath;

    await attachmentItem.saveTx();
    let destDir = Zotero.Attachments.getStorageDirectory(attachmentItem).path;
    try {
      await IOUtils.remove(destDir, { recursive: true, ignoreAbsent: true });
      await IOUtils.move(directory, destDir);
    }
    catch (error) {
      await attachmentItem.eraseTx();
      throw error;
    }

    try {
      await Zotero.FullText.queueItem(attachmentItem);
    }
    catch (error) {
      Zotero.logError(error);
    }

    return attachmentItem;
  },

  createProgress(headline) {
    let progressWindow = new Zotero.ProgressWindow({
      window: Zotero.getMainWindow(),
      closeOnClick: false
    });
    progressWindow.changeHeadline("Paper Markdown");
    let item = new progressWindow.ItemProgress("attachment-pdf", headline);
    item.setProgress(1);
    progressWindow.show();
    return {
      window: progressWindow,
      item
    };
  },

  alert(message) {
    Services.prompt.alert(null, "Paper Markdown", message);
  },

  copyText(text) {
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(String(text || ""));
  },

  formatError(error) {
    return error?.message || String(error);
  },

  warnOnce(key, message) {
    if (this.filenameWarningKeys.has(key)) return;
    this.filenameWarningKeys.add(key);
    this.warn(message);
  },

  formatAttachmentLabel(attachment) {
    return attachment?.key || attachment?.id || "attachment";
  },

  formatDuration(ms) {
    ms = Math.max(0, Number(ms) || 0);
    let seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    let minutes = Math.floor(seconds / 60);
    seconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    let hours = Math.floor(minutes / 60);
    minutes = minutes % 60;
    return `${hours}h ${minutes}m`;
  },

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};
