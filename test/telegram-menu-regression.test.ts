import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("el arranque instala el menú para el chat administrador sin bloquear el bot", () => {
  assert.match(source, /setMyCommands\(TELEGRAM_COMMANDS/);
  assert.match(source, /scope:\s*\{\s*type:\s*"chat",\s*chat_id:/);
  assert.match(source, /setChatMenuButton/);
  assert.match(source, /telegram_menu_error/);
});

test("los accesos principales conservan comandos y navegación por botones", () => {
  for (const command of [
    "hunting",
    "markets",
    "operations",
    "strategy",
    "automation",
  ])
    assert.match(source, new RegExp(`bot\\.command\\("${command}"`));
  assert.match(source, /case "hunt":/);
  assert.match(source, /updateHunting/);
  assert.match(source, /force_reply:\s*true/);
});
