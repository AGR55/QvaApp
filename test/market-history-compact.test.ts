import assert from "node:assert/strict";
import test from "node:test";
import { compactMarketHistory } from "../src/dashboard.js";

test("el histórico enviado al navegador conserva límites, orden y últimas medianas", () => {
  const history = Array.from({ length: 300 }, (_, index) => ({
    coin: index % 2 ? "BANK_CUP" : "CLASICA",
    createdAt: index,
    medianBuy: index,
  }));
  const compact = compactMarketHistory(history, 12);
  assert.equal(compact.length, 24);
  assert.deepEqual(compact.map((point) => point.createdAt),
    [...compact.map((point) => point.createdAt)].sort((a, b) => a - b));
  for (const coin of ["BANK_CUP", "CLASICA"]) {
    const original = history.filter((point) => point.coin === coin);
    const points = compact.filter((point) => point.coin === coin);
    assert.equal(points[0], original[0]);
    assert.equal(points.at(-1), original.at(-1));
    assert.equal(points.length, 12);
  }
});
