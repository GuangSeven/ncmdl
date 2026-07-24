const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CONFIG_DIR = path.join(os.homedir(), ".ncmdl");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG = {
  cookie: "",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  downloadDir: path.join(os.homedir(), "Downloads", "ncmdl"),
  quality: "jymaster",
  filenamePattern: "artist-title"
};

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Object.assign({}, DEFAULT_CONFIG, parsed);
  } catch (error) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

async function saveConfig(nextConfig) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const merged = Object.assign({}, DEFAULT_CONFIG, nextConfig);
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 12) {
    return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
  }
  return `${secret.slice(0, 6)}***${secret.slice(-4)}`;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  maskSecret
};