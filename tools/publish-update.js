// Кладе підписаний .xpi у updates/ і оновлює updates.json — маніфест
// оновлень, за яким Firefox сам підтягує нові версії розширення.
//
//   node tools/publish-update.js <шлях до .xpi> [корінь репозиторію]
//
// Firefox читає updates.json за адресою з update_url у manifest.json
// (гілка main на raw.githubusercontent.com), бере найновішу версію й
// звіряє SHA-256 завантаженого файлу з update_hash. Тримаємо лише останню
// версію: попередні нікому не потрібні, а кожна — це 100+ КБ в історії git.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO_RAW = "https://raw.githubusercontent.com/EsekyIL/hls-grabber/main/updates";

function publish(xpiPath, root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "browser-extension", "manifest.json"), "utf8"));
  const id = manifest.browser_specific_settings?.gecko?.id;
  const version = manifest.version;
  if (!id || !version) throw new Error("у manifest.json немає id або version");
  if (!path.basename(xpiPath).endsWith(`-${version}.xpi`)) {
    throw new Error(`${path.basename(xpiPath)} не відповідає версії ${version} з manifest.json`);
  }

  const dir = path.join(root, "updates");
  fs.mkdirSync(dir, {recursive: true});
  const name = `hls-grabber-bridge-${version}.xpi`;
  const data = fs.readFileSync(xpiPath);
  fs.writeFileSync(path.join(dir, name), data);

  // Старі .xpi прибираємо: оновлення завжди йде на найновішу.
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".xpi") && file !== name) fs.rmSync(path.join(dir, file));
  }

  const updates = {
    addons: {
      [id]: {
        updates: [{
          version,
          update_link: `${REPO_RAW}/${name}`,
          update_hash: "sha256:" + crypto.createHash("sha256").update(data).digest("hex"),
          applications: {gecko: {strict_min_version: manifest.browser_specific_settings.gecko.strict_min_version || "121.0"}}
        }]
      }
    }
  };
  fs.writeFileSync(path.join(dir, "updates.json"), JSON.stringify(updates, null, 2) + "\n");
  return {version, file: path.join("updates", name)};
}

if (require.main === module) {
  const [xpi, root = path.join(__dirname, "..")] = process.argv.slice(2);
  if (!xpi) {
    console.error("використання: node tools/publish-update.js <файл.xpi> [корінь]");
    process.exit(2);
  }
  try {
    const result = publish(path.resolve(xpi), path.resolve(root));
    console.log(`updates.json → ${result.version}, файл ${result.file}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {publish, REPO_RAW};
