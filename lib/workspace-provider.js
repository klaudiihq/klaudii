const createGitWorktreeProvider = require("./providers/git-worktree");

const factories = {
  "git-worktree": createGitWorktreeProvider,
};

let activeProvider = null;

function initProvider(name, deps) {
  const factory = factories[name];
  if (!factory) throw new Error(`Unknown workspace provider: "${name}"`);
  activeProvider = factory(deps);
}

function setProvider(name, deps) {
  initProvider(name, deps);
}

function registerProvider(name, factoryOrInstance) {
  factories[name] = factoryOrInstance;
}

function getProvider() {
  return activeProvider;
}

module.exports = { getProvider, setProvider, registerProvider, initProvider };
