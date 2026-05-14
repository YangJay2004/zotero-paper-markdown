var PaperMarkdown;

function log(message) {
  Zotero.debug("Paper Markdown: " + message);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  log(`Starting ${version}`);

  Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "preferences.xhtml",
    scripts: [rootURI + "preferences.js"],
    stylesheets: [rootURI + "preferences.css"]
  });

  Services.scriptloader.loadSubScript(rootURI + "src/paper-markdown.js");
  PaperMarkdown.init({ id, version, rootURI });
  await PaperMarkdown.start();
}

function shutdown() {
  log("Shutting down");
  PaperMarkdown?.shutdown();
  PaperMarkdown = undefined;
}

function uninstall() {
  log("Uninstalled");
}

