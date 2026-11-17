import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
export function installGitHooks(cwd: string): string {
  const path = execFileSync("git", ["-C", cwd, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
  const dir = resolve(cwd, path); mkdirSync(dir, { recursive: true });
  const scripts = ["pre-commit", "pre-push"].map(name => ({ file: join(dir, name), text: `#!/bin/sh\n# crosstalk advisory client hook\nexec xt hook git ${name} "$@"\n` }));
  for (const { file, text } of scripts) if (existsSync(file) && readFileSync(file, "utf8") !== text) throw new Error("Existing Git hook; chain xt hook git manually instead of overwriting it");
  for (const { file, text } of scripts) { writeFileSync(file, text, { mode: 0o755 }); chmodSync(file, 0o755); }
  return "Installed advisory pre-commit/pre-push hooks (bypassable with --no-verify).\nOn the bare remote, configure and trust .crosstalk.toml in the Git directory, enroll ci:remote and install its CI credential in the remote user's credential file.\nCreate executable hooks/pre-receive and hooks/post-receive containing #!/bin/sh followed by exec xt hook git pre-receive or exec xt hook git post-receive. Set relay protected-branch policy first. Seed existing reachability with xt hook git seed <ref> from a human terminal.";
}
