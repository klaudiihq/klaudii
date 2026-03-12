const fs = require("fs");
const path = require("path");

module.exports = function createGitWorktreeProvider({ git, github, config }) {
  return {
    name: "git-worktree",

    capabilities() {
      return { projects: true, branches: true };
    },

    getSources() {
      const repos = github.listRepos();
      const reposDir = config.reposDir;
      return repos.map((r) => ({
        ...r,
        cloned: reposDir
          ? fs.existsSync(path.join(reposDir, r.name, ".git"))
          : false,
      }));
    },

    getStatus(workspacePath) {
      const status = git.getStatus(workspacePath);
      const remoteUrl = git.getRemoteUrl(workspacePath);
      return status ? { ...status, remoteUrl } : null;
    },

    provision({ reposDir, repo, owner, branch }) {
      const repoDir = path.join(reposDir, repo);
      const branchName = branch || `claude-${Date.now()}`;
      const { projectName, workspacePath } = this.buildPath(
        reposDir,
        repo,
        branchName,
      );

      // Clone from GitHub if repo doesn't exist locally
      if (!git.isGitRepo(repoDir)) {
        const repos = github.listRepos();
        const ghRepo = owner
          ? repos.find((r) => r.name === repo && r.owner === owner)
          : repos.find((r) => r.name === repo);
        if (!ghRepo) {
          throw new Error(
            `repo "${owner ? owner + "/" : ""}${repo}" not found on GitHub`,
          );
        }
        git.cloneRepo(ghRepo.sshUrl, repoDir);
      }

      if (fs.existsSync(workspacePath)) {
        throw new Error(
          `Worktree directory already exists: ${workspacePath}`,
        );
      }

      this.create(repoDir, workspacePath, branchName);

      // Verify clean state
      const wtStatus = git.getStatus(workspacePath);
      if (wtStatus && wtStatus.dirtyFiles > 0) {
        console.warn(
          `[git-worktree] Worktree ${workspacePath} has ${wtStatus.dirtyFiles} dirty files after creation`,
        );
      }

      return { projectName, workspacePath, branch: branchName };
    },

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
};
