import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nginx = readFileSync("deploy/nginx-qvaapply.conf", "utf8");
const tlsScript = readFileSync("scripts/enable-vps-tls.sh", "utf8");
const provisionScript = readFileSync("scripts/provision-vps.sh", "utf8");
const tlsWorkflow = readFileSync(".github/workflows/enable-production-tls.yml", "utf8");

test("producción publica QvaApply solo en qvapply.honux.tech", () => {
  assert.match(nginx, /listen 80 default_server;[\s\S]*server_name _;[\s\S]*return 404;/);
  assert.match(nginx, /server_name qvapply\.honux\.tech;/);
  assert.doesNotMatch(nginx, /server_name honux\.tech/);
  assert.match(tlsScript, /domain=\$\{1:-qvapply\.honux\.tech\}/);
  assert.match(provisionScript, /domain=\$\{1:-qvapply\.honux\.tech\}/);
  assert.match(tlsWorkflow, /https:\/\/qvapply\.honux\.tech\/api\/session/);
  assert.match(tlsWorkflow, /https:\/\/honux\.tech\/api\/session/);
});
