const { execSync } = require("child_process");

function listRepos(limit = 100) {
  const output = execSync(
    `gh repo list --json name,url,sshUrl,description,isPrivate,isFork --limit ${limit}`,
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
  );
  return JSON.parse(output);
}

function getGitHubUser() {
  try {
    const output = execSync("gh api user --jq .login", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim();
  } catch {
    return null;
  }
}

module.exports = { listRepos, getGitHubUser };
