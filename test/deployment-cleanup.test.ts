import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve("scripts/cleanup-vps.sh");
const active = "a".repeat(40), previous = "b".repeat(40), old = "c".repeat(40), orphan = "d".repeat(40), used = "e".repeat(40);

function fixture() {
  const taskRoot = mkdtempSync(join(tmpdir(), "qva-release-cleanup-"));
  const app = join(taskRoot, "app");
  const bin = join(taskRoot, "bin");
  mkdirSync(bin);
  for (const revision of [active, previous, old, used, "not-a-release"])
    mkdirSync(join(app, "releases", revision), { recursive: true });
  mkdirSync(join(app, "data", "backups"), { recursive: true });
  symlinkSync(join(app, "releases", active), join(app, "current"));
  // A directory symlink must not cause traversal outside the release tree.
  const outside = join(taskRoot, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(app, "releases", "f".repeat(40)));
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$1 $2" in
  'image ls') printf '%s\\n' "$MOCK_IMAGES" ;;
  'ps -a') printf '%s\\n' "$MOCK_CONTAINERS" ;;
  'image rm'|'image prune'|'buildx prune') ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
  const log = join(taskRoot, "docker.log");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log,
    MOCK_IMAGES: [active, previous, old, orphan, used].map(sha => `qvaapply:${sha}`).concat(["friend:latest", "qvaapply:manual"]).join("\n"),
    MOCK_CONTAINERS: `qvaapply:${active}\nqvaapply:${used}\nfriend:latest` };
  return { app, outside, log, env };
}

test("limpia releases e imágenes huérfanas conservando actual, anterior y contenedores", () => {
  const state = fixture();
  const result = spawnSync("bash", [script, state.app, active, previous], { env: state.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const sha of [active, previous, used, "not-a-release"])
    assert.equal(existsSync(join(state.app, "releases", sha)), true);
  assert.equal(existsSync(join(state.app, "releases", old)), false);
  assert.equal(existsSync(state.outside), true);
  assert.equal(existsSync(join(state.app, "data", "backups")), true);
  const commands = readFileSync(state.log, "utf8");
  assert.match(commands, new RegExp(`image rm qvaapply:${old}`));
  assert.match(commands, new RegExp(`image rm qvaapply:${orphan}`));
  for (const protectedImage of [active, previous, used])
    assert.doesNotMatch(commands, new RegExp(`image rm qvaapply:${protectedImage}`));
  assert.doesNotMatch(commands, /image rm (friend:latest|qvaapply:manual)|system prune|volume prune|image prune.*--all/);
  assert.match(commands, /image prune -f --filter label=qvaapply.release=true/);
  assert.match(commands, /buildx prune -f --filter inuse=false --filter shared=false --filter description~=qvaapply-runtime/);
});

test("no elimina nada si la revisión activa no coincide o tiene un nombre inválido", () => {
  for (const revision of [previous, "../../data"]) {
    const state = fixture();
    const result = spawnSync("bash", [script, state.app, revision], { env: state.env, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(existsSync(state.log), false);
    assert.equal(existsSync(join(state.app, "releases", old)), true);
  }
});

test("el despliegue ejecuta el script recibido y limpia solo después del healthcheck", () => {
  const workflow = readFileSync(".github/workflows/ci-deploy.yml", "utf8");
  const deploy = readFileSync("scripts/deploy-vps.sh", "utf8");
  assert.match(workflow, /scripts\/cleanup-vps\.sh/);
  assert.match(workflow, /mktemp -d/);
  assert.match(workflow, /tar -xzf[^\n]*scripts\/deploy-vps\.sh/);
  assert.doesNotMatch(workflow, /bash.*current\/scripts\/deploy-vps\.sh/);
  assert.ok(deploy.indexOf('if [[ $healthy != true ]]') < deploy.indexOf('bash "$release_dir/scripts/cleanup-vps.sh"'));
  assert.match(deploy, /Se restauró la versión anterior/);
});
