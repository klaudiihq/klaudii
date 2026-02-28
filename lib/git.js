const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

function cloneRepo(sshUrl, targetDir) {
  execSync(`git clone ${JSON.stringify(sshUrl)} ${JSON.stringify(targetDir)}`, {
    stdio: "pipe",
    timeout: 120000,
  });
}

function listWorktrees(repoDir) {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const worktrees = [];
    let current = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      }
    }
    if (current.path) worktrees.push(current);

    return worktrees;
  } catch {
    return [];
  }
}

function addWorktree(repoDir, worktreePath, branch) {
  // Create a new branch at the worktree
  execSync(
    `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)}`,
    { cwd: repoDir, stdio: "pipe" }
  );
}

function removeWorktree(repoDir, worktreePath) {
  execSync(`git worktree remove ${JSON.stringify(worktreePath)} --force`, {
    cwd: repoDir,
    stdio: "pipe",
  });
}

function getCurrentBranch(dir) {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function scanRepos(reposDir) {
  if (!fs.existsSync(reposDir)) return [];

  return fs
    .readdirSync(reposDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && isGitRepo(path.join(reposDir, d.name)))
    .map((d) => {
      const fullPath = path.join(reposDir, d.name);
      // Check if this is a worktree (contains .git file, not .git directory)
      const dotGit = path.join(fullPath, ".git");
      const isWorktree = fs.existsSync(dotGit) && fs.statSync(dotGit).isFile();

      return {
        name: d.name,
        path: fullPath,
        branch: getCurrentBranch(fullPath),
        isWorktree,
      };
    });
}

module.exports = { isGitRepo, cloneRepo, listWorktrees, addWorktree, removeWorktree, getCurrentBranch, scanRepos };
