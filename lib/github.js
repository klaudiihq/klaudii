const { execSync } = require("child_process");

function listRepos(limit = 100) {
  const fields = "name,url,sshUrl,description,isPrivate,isFork,owner";
  const jq = `.[:${limit}] | [.[] | {name, url, sshUrl: .ssh_url, description, isPrivate: .private, isFork: .fork, owner: .owner.login}]`;
  const output = execSync(
    `gh api "/user/repos?affiliation=owner,organization_member&sort=updated&per_page=${limit}" --jq '${jq}'`,
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
