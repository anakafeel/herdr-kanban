import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCards, mergeCards, waitingOn, isReady, columnFor, nextOf, dropAction, applyDrop } from "../mods/kanban/logic.js";

const card = (id, status = "todo", extra = {}) => ({ id, task: `t ${id}`, template: "gemini", status, ...extra });

test("parseCards keeps valid cards and counts the rest", () => {
  const text = JSON.stringify({ cards: [card("a1"), card("../evil"), { id: "b", status: "todo" }, card("c", "nope"), null] });
  const { cards, skipped } = parseCards(text);
  assert.deepEqual(cards.map((c) => c.id), ["a1"]);
  assert.equal(skipped, 4);
});

test("parseCards treats a missing file as empty and throws on bad JSON", () => {
  assert.deepEqual(parseCards(null), { cards: [], skipped: 0 });
  assert.throws(() => parseCards("{ broken"));
});

test("parseCards drops self and non-string dependencies", () => {
  const { cards } = parseCards(JSON.stringify({ cards: [card("a", "todo", { after: ["a", 5, "b"] }), card("c", "todo", { after: "b" })] }));
  assert.deepEqual(cards[0].after, ["b"]);
  assert.equal("after" in cards[1], false);
});

test("mergeCards: ours win, theirs are kept, removed stay removed", () => {
  const ours = [card("a", "running"), card("new")];
  const theirs = [card("a", "todo"), card("x"), card("gone")];
  const merged = mergeCards(ours, theirs, new Set(["gone"]));
  assert.deepEqual(merged.map((c) => [c.id, c.status]), [["a", "running"], ["x", "todo"], ["new", "todo"]]);
});

test("a card waits until every card in `after` is done", () => {
  const cards = [card("a", "review"), card("b", "done"), card("c", "todo", { after: ["a", "b", "missing"] })];
  assert.deepEqual(waitingOn(cards[2], cards).map((c) => c.id), ["a"]);
  assert.equal(isReady(cards[2], cards), false);
  cards[0].status = "done";
  assert.equal(isReady(cards[2], cards), true);
});

test("a dependency cycle never becomes ready", () => {
  const cards = [card("a", "todo", { after: ["b"] }), card("b", "todo", { after: ["a"] })];
  assert.equal(isReady(cards[0], cards), false);
  assert.equal(isReady(cards[1], cards), false);
});

test("columnFor follows the helper's status", () => {
  assert.equal(columnFor(card("a", "running"), undefined), "running"); // still launching
  assert.equal(columnFor(card("a", "running", { terminal: "t1" }), undefined), "review"); // helper gone
  assert.equal(columnFor(card("a", "running"), { status: "working", turn: 0 }), "running");
  assert.equal(columnFor(card("a", "running"), { status: "idle", turn: 0 }), "running"); // not started yet
  assert.equal(columnFor(card("a", "running"), { status: "idle", turn: 1 }), "review");
  assert.equal(columnFor(card("a", "running"), { status: "done" }), "review");
  assert.equal(columnFor(card("a", "done"), undefined), "done");
});

test("nextOf wraps around", () => {
  assert.equal(nextOf(["a", "b"], "b"), "a");
  assert.equal(nextOf(["a", "b"], "zzz"), "a");
});

test("dropAction follows the confirmed rules table", () => {
  const cards = [];
  const expect = {
    todo: { todo: "reorder", running: "run", review: null, done: "done" },
    running: { todo: "stop", running: undefined, review: "stop-review", done: null },
    review: { todo: "back", running: "run", review: undefined, done: "done" },
    done: { todo: "reopen", running: null, review: "reopen-review", done: undefined },
  };
  for (const [from, row] of Object.entries(expect)) {
    for (const [to, effect] of Object.entries(row)) {
      const r = dropAction(card("x", from), to, cards);
      if (effect) assert.equal(r.effect, effect, `${from} -> ${to}`);
      else if (effect === null) assert.ok(!r.ok && r.reason, `${from} -> ${to} refused with a reason`);
      else assert.ok(!r.ok && r.reason === "", `${from} -> ${to} is a silent no-op`);
    }
  }
});

test("a waiting card can't be dragged to Running", () => {
  const cards = [card("a", "review"), card("b", "todo", { after: ["a"] })];
  const r = dropAction(cards[1], "running", cards);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Waits for "t a"/);
});

test("applyDrop reorders To do and leaves running to the caller", () => {
  const cards = [card("a"), card("b"), card("c")];
  assert.deepEqual(applyDrop(cards, "c", "todo", "a").cards.map((c) => c.id), ["c", "a", "b"]);
  assert.deepEqual(applyDrop(cards, "a", "todo", null).cards.map((c) => c.id), ["b", "c", "a"]);
  const run = applyDrop(cards, "a", "running", null);
  assert.equal(run.result.effect, "run");
  assert.equal(run.cards, cards); // unchanged: the caller starts the agent
});

test("applyDrop moves Review back to To do at the drop point, and refuses Running to Done", () => {
  const cards = [card("a"), card("r", "review"), card("w", "running")];
  assert.deepEqual(applyDrop(cards, "r", "todo", "a").cards.map((c) => [c.id, c.status]), [["r", "todo"], ["a", "todo"], ["w", "running"]]);
  const refused = applyDrop(cards, "w", "done", null);
  assert.equal(refused.cards, cards);
  assert.equal(refused.result.ok, false);
});
