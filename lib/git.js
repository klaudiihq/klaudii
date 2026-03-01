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
  // Check if any existing worktree is already on this branch
  const worktrees = listWorktrees(repoDir);
  const conflict = worktrees.find((w) => w.branch === branch);
  if (conflict) {
    throw new Error(`Branch "${branch}" is already checked out at ${conflict.path}`);
  }

  // Use existing branch if it exists, otherwise create a new one
  let branchExists = false;
  try {
    execSync(`git rev-parse --verify ${JSON.stringify(branch)}`, {
      cwd: repoDir,
      stdio: "pipe",
    });
    branchExists = true;
  } catch {
    // Branch doesn't exist locally — check remote
    try {
      execSync(`git rev-parse --verify ${JSON.stringify("origin/" + branch)}`, {
        cwd: repoDir,
        stdio: "pipe",
      });
      branchExists = true;
    } catch {
      // Doesn't exist anywhere — will create new
    }
  }

  if (branchExists) {
    execSync(
      `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`,
      { cwd: repoDir, stdio: "pipe" }
    );
  } else {
    execSync(
      `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)}`,
      { cwd: repoDir, stdio: "pipe" }
    );
  }
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

function getStatus(dir) {
  try {
    const branch = getCurrentBranch(dir);

    // Count dirty files (staged + unstaged + untracked)
    const statusOut = execSync("git status --porcelain", {
      cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const dirtyFiles = statusOut ? statusOut.split("\n").length : 0;

    // Count unpushed commits (only if upstream is configured)
    let unpushed = 0;
    try {
      const ahead = execSync("git rev-list --count @{u}..HEAD", {
        cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      unpushed = parseInt(ahead) || 0;
    } catch {
      // No upstream configured — can't determine unpushed count
    }

    // Get short status lines for the detail modal
    let files = [];
    if (statusOut) {
      files = statusOut.split("\n").map((line) => ({
        status: line.slice(0, 2).trim(),
        path: line.slice(3),
      }));
    }

    return { branch, dirtyFiles, unpushed, files };
  } catch {
    return null;
  }
}

function getRemoteUrl(dir) {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // git@github.com:user/repo.git -> https://github.com/user/repo
    const sshMatch = url.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}`;
    // Already HTTPS
    const httpsMatch = url.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;
    return null;
  } catch {
    return null;
  }
}

function initRepo(repoDir, remoteUrl) {
  execSync(`git init ${JSON.stringify(repoDir)}`, { stdio: "pipe" });
  execSync('git commit --allow-empty -m "Initial commit"', {
    cwd: repoDir,
    stdio: "pipe",
  });
  if (remoteUrl) {
    execSync(`git remote add origin ${JSON.stringify(remoteUrl)}`, {
      cwd: repoDir,
      stdio: "pipe",
    });
  }
}

module.exports = { isGitRepo, cloneRepo, initRepo, listWorktrees, addWorktree, removeWorktree, getCurrentBranch, scanRepos, getStatus, getRemoteUrl };
