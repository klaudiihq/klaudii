const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function getProjects() {
  return loadConfig().projects || [];
}

function addProject(name, projectPath) {
  const config = loadConfig();
  if (config.projects.some((p) => p.name === name)) {
    throw new Error(`Project "${name}" already exists`);
  }
  if (!fs.existsSync(projectPath)) {
    throw new Error(`Path does not exist: ${projectPath}`);
  }
  config.projects.push({ name, path: projectPath });
  saveConfig(config);
  return config.projects;
}

function removeProject(name) {
  const config = loadConfig();
  config.projects = config.projects.filter((p) => p.name !== name);
  saveConfig(config);
  return config.projects;
}

function getProject(name) {
  return getProjects().find((p) => p.name === name) || null;
}

module.exports = { loadConfig, getProjects, addProject, removeProject, getProject };
