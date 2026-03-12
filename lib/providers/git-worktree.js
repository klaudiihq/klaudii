const git = require("../git");
const fs = require("fs");
const path = require("path");

module.exports = {
  create(repoDir, workspacePath, branch) {
    git.addWorktree(repoDir, workspacePath, branch);
  },

  remove(repoDir, workspacePath) {
    git.removeWorktree(repoDir, workspacePath);
  },

  list(repoDir) {
    return git.listWorktrees(repoDir);
  },

  clean(workspacePath, baseBranch) {
    git.cleanWorktree(workspacePath, baseBranch);
  },

  isWorkspace(dirPath) {
    const dotGit = path.join(dirPath, ".git");
    return fs.existsSync(dotGit) && fs.statSync(dotGit).isFile();
  },

  parseName(projectName) {
    const idx = projectName.indexOf("--");
    if (idx === -1) return { repo: projectName, identifier: "" };
    return {
      repo: projectName.slice(0, idx),
      identifier: projectName.slice(idx + 2),
    };
  },

  buildPath(reposDir, repo, identifier) {
    const projectName = `${repo}--${identifier}`;
    return {
      projectName,
      workspacePath: path.join(reposDir, projectName),
    };
  },
};
