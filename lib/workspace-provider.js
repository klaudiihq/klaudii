const gitWorktreeProvider = require("./providers/git-worktree");

const providers = {
  "git-worktree": gitWorktreeProvider,
};

let activeProvider = gitWorktreeProvider;

function setProvider(name) {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown workspace provider: "${name}"`);
  activeProvider = provider;
}

function registerProvider(name, impl) {
  providers[name] = impl;
}

function getProvider() {
  return activeProvider;
}

module.exports = { getProvider, setProvider, registerProvider };
