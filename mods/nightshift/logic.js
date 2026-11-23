// Board rules with no Herdr calls, so they run under `node --test` too.

export const COLUMNS = [["todo", "To do"], ["running", "Running"], ["review", "Review"], ["done", "Done"]];
// "queued" is a card waiting in Running for a free slot or for the cards it waits on.
const STATUSES = new Set([...COLUMNS.map(([k]) => k), "queued"]);
export const ID = /^[a-z0-9_-]{1,24}$/; // hc --name takes 1-32 of a-z 0-9 - _, and "ns-" uses 3
export const helperName = (id) => `ns-${id}`;
export const branchName = (id) => `ns/${id}`;

const positive = (n) => (Number.isInteger(n) && n > 0 ? n : null);

// Cards and settings from the board file's text. Throws on bad JSON; drops cards with a bad
// id, task or status. Settings: `maxRunning` agents at once, `timeoutMinutes` per agent
// (null: no limit for either), and `autoMerge` finished cards.
export function parseCards(text) {
  const data = text ? JSON.parse(text) : {};
  const raw = data.cards ?? [];
  const maxRunning = positive(data.maxRunning);
  const timeoutMinutes = positive(data.timeoutMinutes);
  const autoMerge = data.autoMerge === true;
  const cards = raw.filter((c) => c && ID.test(c.id) && typeof c.task === "string" && STATUSES.has(c.status));
  for (const c of cards) {
    if (Array.isArray(c.after)) c.after = c.after.filter((a) => typeof a === "string" && a !== c.id);
    else delete c.after;
  }
  return { cards, skipped: raw.length - cards.length, maxRunning, timeoutMinutes, autoMerge };
}

// Another writer changed the file: keep their cards, ours win for ids both have,
// and cards deleted here stay deleted.
export function mergeCards(ours, theirs, removed) {
  const merged = theirs.filter((c) => !removed.has(c.id)).map((c) => ours.find((o) => o.id === c.id) ?? c);
  for (const o of ours) if (!merged.some((m) => m.id === o.id)) merged.push(o);
  return merged;
}

// The cards this one still waits for: listed in `after`, present, and not Done.
export function waitingOn(card, cards) {
  return (card.after ?? []).map((id) => cards.find((c) => c.id === id)).filter((c) => c && c.status !== "done");
}

export function isReady(card, cards) {
  return (card.status === "todo" || card.status === "queued") && waitingOn(card, cards).length === 0;
}

const running = (cards) => cards.filter((c) => c.status === "running").length;

// Queued cards to start now, in queue order: ready, and only as many as there are free slots.
export function startable(cards, maxRunning) {
  const free = maxRunning ? Math.max(0, maxRunning - running(cards)) : Infinity;
  return cards.filter((c) => c.status === "queued" && isReady(c, cards)).slice(0, free);
}

// Where a card shows, given its helper terminal (or undefined).
export function columnFor(card, helper) {
  if (card.status === "queued") return "running";
  if (card.status !== "running") return card.status;
  if (!helper) return card.terminal ? "review" : "running"; // no address yet: still launching
  return helper.status === "done" || (helper.status === "idle" && (helper.turn ?? 0) >= 1) ? "review" : "running";
}

export function nextOf(list, item) {
  return list[(list.indexOf(item) + 1) % list.length];
}

// What dropping `card` on column `to` does: { ok: true, effect, label } or { ok: false, reason }.
// A refusal with an empty reason is a no-op (dropped back where it was). Dropping on Running
// starts the card, or queues it when it waits for other cards or every slot is taken.
export function dropAction(card, to, cards, maxRunning = null) {
  const from = card.status;
  if (from === to) return from === "todo" ? { ok: true, effect: "reorder", label: "Change the run order" } : { ok: false, reason: "" };
  const run = (label) => {
    const w = waitingOn(card, cards);
    if (w.length) return { ok: true, effect: "queue", label: `Queue it: starts after "${w[0].task}" is done` };
    if (maxRunning && running(cards) >= maxRunning) return { ok: true, effect: "queue", label: `Queue it: starts when one of ${maxRunning} slots frees` };
    return { ok: true, effect: "run", label };
  };
  const rules = {
    queued: {
      running: () => ({ ok: true, effect: "reorder", label: "Change the queue order" }),
      todo: () => ({ ok: true, effect: "unqueue", label: "Take it out of the queue" }),
      review: () => ({ ok: false, reason: "It hasn't run yet" }),
      done: () => ({ ok: true, effect: "done", label: "Mark done without an agent" }),
    },
    todo: {
      running: () => run("Start an agent on it"),
      review: () => ({ ok: false, reason: "Nothing to review yet: run it first" }),
      done: () => ({ ok: true, effect: "done", label: "Mark done without an agent" }),
    },
    running: {
      todo: () => ({ ok: true, effect: "stop", label: "Stop the agent, back to To do" }),
      review: () => ({ ok: true, effect: "stop-review", label: "Stop the agent and review what it did" }),
      done: () => ({ ok: false, reason: "The agent is still working: stop it, or wait for Review" }),
    },
    review: {
      todo: () => ({ ok: true, effect: "back", label: "Back to To do (same branch next time)" }),
      running: () => run("Run again on the same branch"),
      done: () => ({ ok: true, effect: "done", label: "Done (branch kept until you clean up)" }),
    },
    done: {
      todo: () => ({ ok: true, effect: "reopen", label: "Reopen" }),
      review: () => ({ ok: true, effect: "reopen-review", label: "Reopen for review" }),
      running: () => ({ ok: false, reason: "Reopen it first, then run" }),
    },
  };
  return rules[from]?.[to]?.() ?? { ok: false, reason: "" };
}

const STATUS_AFTER = { done: "done", stop: "todo", "stop-review": "review", back: "todo", reopen: "todo", "reopen-review": "review", queue: "queued", unqueue: "todo" };

// The board after a drop, except "run", which the caller starts. A card dropped in To do or
// queued in Running lands before `beforeId` (or last): that order is the run order.
export function applyDrop(cards, id, to, beforeId, maxRunning = null) {
  const card = cards.find((c) => c.id === id);
  const result = card ? dropAction(card, to, cards, maxRunning) : { ok: false, reason: "" };
  if (!result.ok || result.effect === "run") return { cards, result };
  let next = cards.map((c) => (c.id === id ? { ...c, status: STATUS_AFTER[result.effect] ?? c.status } : c));
  if (to === "todo" || next.find((c) => c.id === id).status === "queued") {
    const moved = next.find((c) => c.id === id);
    next = next.filter((c) => c.id !== id);
    const at = beforeId && beforeId !== id ? next.findIndex((c) => c.id === beforeId) : -1;
    next.splice(at < 0 ? next.length : at, 0, moved);
  }
  return { cards: next, result };
}

// A person-readable reason from a failed `git merge` (after it was aborted).
export function mergeFailure(output, branch) {
  if (/CONFLICT/.test(output)) return `${branch} conflicts with your branch, so the merge was aborted and nothing changed. Merge it by hand to resolve.`;
  const lines = output.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const why = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1) ?? "git gave no reason";
  return `Merge of ${branch} failed, nothing changed: ${why.replace(/^(fatal|error):\s*/, "")}`;
}

// A running card whose agent has worked longer than the board's timeout.
export function isTimedOut(card, now, timeoutMinutes) {
  return Boolean(timeoutMinutes) && card.status === "running" && typeof card.startedAt === "number"
    && now - card.startedAt > timeoutMinutes * 60_000;
}

// A card that just finished on its own and should merge by itself: never after a timeout or a
// manual stop (partial work), and only one try.
export function shouldAutoMerge(card, autoMerge) {
  return autoMerge && card.status === "review" && Boolean(card.branch) && card.finished === true
    && !card.merged && !card.autoMergeTried;
}
