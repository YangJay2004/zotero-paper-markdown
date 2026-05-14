#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = sourceManifest.version;
const xpiPath = path.resolve(process.argv[2] || path.join(root, "dist", `paper-markdown-${version}.xpi`));
const updateLink = process.env.UPDATE_LINK || process.argv[3];
const addonID = process.env.ADDON_ID || sourceManifest.applications?.zotero?.id;
const minVersion = process.env.ZOTERO_MIN_VERSION || sourceManifest.applications?.zotero?.strict_min_version;
const maxVersion = process.env.ZOTERO_MAX_VERSION || sourceManifest.applications?.zotero?.strict_max_version;

if (!addonID) {
  throw new Error("Missing add-on id. Set ADDON_ID or applications.zotero.id in manifest.json.");
}

if (!updateLink) {
  throw new Error("Missing update link. Pass it as the second argument or set UPDATE_LINK.");
}

if (!fs.existsSync(xpiPath)) {
  throw new Error(`XPI not found: ${xpiPath}`);
}

const hash = crypto.createHash("sha256")
  .update(fs.readFileSync(xpiPath))
  .digest("hex");

const updates = {
  addons: {
    [addonID]: {
      updates: [
        {
          version,
          update_link: updateLink,
          update_hash: `sha256:${hash}`,
          applications: {
            zotero: {
              strict_min_version: minVersion,
              strict_max_version: maxVersion
            }
          }
        }
      ]
    }
  }
};

const outputPath = path.join(root, "dist", "updates.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(updates, null, 2) + "\n");
console.log(outputPath);
