/**
 * The deploy controller's GitHub access (release.sh), run in bash against a fake curl.
 *
 * Constructs covered:
 * - Without OSINARA_GITHUB_TOKEN the controller reads GitHub anonymously, as for a public repository.
 * - With it, the token reaches curl only through a 0600 header file, never on the command line.
 * - Release assets are fetched through the API by asset id with Accept: application/octet-stream;
 *   an asset URL outside this repository's API is refused before anything is downloaded.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RELEASE_SH = join(import.meta.dirname, "release.sh");

function run(options: { assetUrl?: string; token?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "osinara-release-github-"));
  const env = join(dir, "server.env");
  writeFileSync(env, `TELEGRAM_BOT_TOKEN=x\n${options.token ? `OSINARA_GITHUB_TOKEN=${options.token}\n` : ""}`);
  const release = join(dir, "release.json");
  writeFileSync(release, JSON.stringify({ assets: [{ name: "compose.production.yaml", url: options.assetUrl ?? "https://api.github.com/repos/ilkruglov/osinara/releases/assets/123" }] }));
  const script = `
    set -euo pipefail
    SERVER_ENV=${JSON.stringify(env)}; WORK_DIR=${JSON.stringify(dir)}
    # As common.sh: fail logs and returns 1; set -e stops the run.
    fail() { echo "FAIL $1"; return 1; }
    curl() { printf '%s\\n' "$@" > "$WORK_DIR/curl.args"; }
    source ${JSON.stringify(RELEASE_SH)}
    trap 'cat "$WORK_DIR/curl.args" 2>/dev/null || true; if [[ -f "$WORK_DIR/github-auth.header" ]]; then echo "HEADER $(stat -c %a "$WORK_DIR/github-auth.header") $(cat "$WORK_DIR/github-auth.header")"; fi' EXIT
    prepare_github_auth
    download_release_asset "$WORK_DIR/release.json" compose.production.yaml "$WORK_DIR/out"
    echo DOWNLOADED
  `;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return `${result.stdout}EXIT ${result.status}`;
}

describe("release.sh GitHub access", () => {
  it("reads anonymously without a token and fetches the asset through the API", () => {
    const out = run({});
    expect(out).toContain("Accept: application/octet-stream");
    expect(out).toContain("https://api.github.com/repos/ilkruglov/osinara/releases/assets/123");
    expect(out).not.toContain("Authorization");
    expect(out).not.toContain("HEADER");
    expect(out).toContain("DOWNLOADED");
  });

  it("passes a token only through a 0600 header file", () => {
    const token = "github_pat_0123456789abcdefghijABCDEFGHIJ";
    const out = run({ token });
    const args = out.split("HEADER")[0]!;
    expect(args).not.toContain(token);
    expect(args).toMatch(/^@.*github-auth\.header$/mu);
    expect(out).toContain(`HEADER 600 Authorization: Bearer ${token}`);
  });

  it("reads a token quoted the way the server .env writes its values", () => {
    const token = "github_pat_0123456789abcdefghijABCDEFGHIJ";
    for (const quoted of [`'${token}'`, `"${token}"`]) {
      const out = run({ token: quoted });
      expect(out).toContain(`HEADER 600 Authorization: Bearer ${token}`);
      expect(out).toContain("DOWNLOADED");
    }
  });

  it("refuses an asset URL outside this repository's API", () => {
    for (const assetUrl of ["https://evil.example/releases/assets/1", "https://api.github.com/repos/someone/else/releases/assets/1"]) {
      const out = run({ assetUrl });
      expect(out).toContain("FAIL DEPLOY_RELEASE_METADATA_INVALID");
      expect(out).not.toContain("DOWNLOADED");
      expect(out).not.toContain("api.github.com/repos/ilkruglov");
      expect(out).toMatch(/EXIT [1-9]/u);
    }
  });

  it("refuses a token of an unexpected shape", () => {
    const out = run({ token: "bad token with spaces" });
    expect(out).toContain("FAIL DEPLOY_GITHUB_TOKEN_INVALID");
    expect(out).not.toContain("DOWNLOADED");
    expect(out).toMatch(/EXIT [1-9]/u);
  });
});
