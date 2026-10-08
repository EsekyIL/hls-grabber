const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {publish, REPO_RAW} = require("./publish-update.js");

function fakeRepo(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
  fs.mkdirSync(path.join(root, "browser-extension"));
  fs.writeFileSync(path.join(root, "browser-extension", "manifest.json"), JSON.stringify({
    version, browser_specific_settings: {gecko: {id: "hls-grabber-bridge@local", strict_min_version: "121.0"}}
  }));
  return root;
}

test("кладе .xpi, рахує sha256 і лишає лише останню версію", () => {
  const root = fakeRepo("1.13.0");
  fs.mkdirSync(path.join(root, "updates"));
  fs.writeFileSync(path.join(root, "updates", "hls-grabber-bridge-1.12.2.xpi"), "old");
  const xpi = path.join(root, "cd52-1.13.0.xpi");
  fs.writeFileSync(xpi, "signed-bytes");

  publish(xpi, root);

  assert.deepStrictEqual(fs.readdirSync(path.join(root, "updates")).sort(), ["hls-grabber-bridge-1.13.0.xpi", "updates.json"]);
  const updates = JSON.parse(fs.readFileSync(path.join(root, "updates", "updates.json"), "utf8"));
  const entry = updates.addons["hls-grabber-bridge@local"].updates[0];
  assert.strictEqual(entry.version, "1.13.0");
  assert.strictEqual(entry.update_link, `${REPO_RAW}/hls-grabber-bridge-1.13.0.xpi`);
  assert.strictEqual(entry.update_hash, "sha256:" + crypto.createHash("sha256").update("signed-bytes").digest("hex"));
});

test("відмовляє, якщо .xpi не тієї версії, що в маніфесті", () => {
  const root = fakeRepo("1.13.0");
  const xpi = path.join(root, "cd52-1.12.2.xpi");
  fs.writeFileSync(xpi, "x");
  assert.throws(() => publish(xpi, root), /не відповідає версії 1\.13\.0/);
});
