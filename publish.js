// Builds the mod and uploads it to GitHub. Run through "Upload to GitHub.cmd".
// The first run asks for the repository address and connects this folder to it.
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync, spawnSync } = require("child_process");

const root = __dirname;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitShown = (...args) => spawnSync("git", args, { cwd: root, stdio: "inherit" }).status === 0;
const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
});

(async () => {
  if (!fs.existsSync(path.join(root, ".git"))) {
    console.log("First upload from this folder.\n");
    const url = await ask("Paste the address of your GitHub repository (https://github.com/<you>/<name>): ");
    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(url.replace(/\.git$/, ""))) throw new Error("That does not look like a GitHub repository address.");
    git("init", "-b", "main");
    git("remote", "add", "origin", url);
    // Continue from what is already in the repository instead of replacing its history.
    if (gitShown("fetch", "origin", "main")) git("reset", "--mixed", "origin/main");
  }
  try { git("config", "user.name"); } catch { git("config", "user.name", "Hiksi"); }
  try { git("config", "user.email"); } catch { git("config", "user.email", "hiksi@users.noreply.github.com"); }

  // The loader keeps a copy of each version, so changed code needs a new number.
  const buildFile = path.join(root, "build.js");
  const build = fs.readFileSync(buildFile, "utf8");
  const version = build.match(/const VERSION = "(\d+)\.(\d+)\.(\d+)";/);
  let changed = true, published = null;
  try { published = JSON.parse(git("show", "HEAD:dist/manifest.json")).latest["0.6.3"]; } catch {}
  try { changed = git("status", "--porcelain", "--", "src").length > 0; } catch {}
  let current = `${version[1]}.${version[2]}.${version[3]}`;
  if (changed && published === current) {
    current = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
    fs.writeFileSync(buildFile, build.replace(version[0], `const VERSION = "${current}";`));
    console.log(`The code changed since version ${published}: this upload is version ${current}.`);
  }
  for (const entry of fs.readdirSync(path.join(root, "dist"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== current) fs.rmSync(path.join(root, "dist", entry.name), { recursive: true });
  }
  execFileSync(process.execPath, [buildFile], { cwd: root, stdio: "inherit" });

  git("add", "-A");
  if (!git("status", "--porcelain")) {
    console.log("\nNothing has changed since the last upload.");
  } else {
    git("commit", "-m", `Car Collisions ${current}`);
    console.log("\nUploading (a GitHub sign-in window may open the first time)...");
  }
  if (!gitShown("push", "-u", "origin", "main")) throw new Error("The upload failed. See the message above.");

  const remote = git("remote", "get-url", "origin").replace(/\.git$/, "").match(/github\.com\/([^/]+)\/([^/]+)$/);
  console.log(`\nDone: version ${current} is uploaded. GitHub Pages needs a minute or two to show it.`);
  console.log(`Link for the mod loader: https://${remote[1].toLowerCase()}.github.io/${remote[2]}/dist`);
})().catch((error) => {
  console.error("\n" + (error.stderr || error.message || error));
  process.exitCode = 1;
});
