// Board rules with no Herdr calls, so they run under `node --test` too.

export const COLUMNS = [["todo", "To do"], ["running", "Running"], ["review", "Review"], ["done", "Done"]];
const STATUSES = new Set(COLUMNS.map(([k]) => k));
export const ID = /^[a-z0-9_-]{1,24}$/; // hc --name takes 1-32 of a-z 0-9 - _, and "kb-" uses 3
export const helperName = (id) => `kb-${id}`;
export const branchName = (id) => `kb/${id}`;

// Cards from the board file's text. Throws on bad JSON; drops cards with a bad id, task or status.
export function parseCards(text) {
  const raw = text ? JSON.parse(text).cards ?? [] : [];
  const cards = raw.filter((c) => c && ID.test(c.id) && typeof c.task === "string" && STATUSES.has(c.status));
  for (const c of cards) {
    if (Array.isArray(c.after)) c.after = c.after.filter((a) => typeof a === "string" && a !== c.id);
    else delete c.after;
  }
  return { cards, skipped: raw.length - cards.length };
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
  return card.status === "todo" && waitingOn(card, cards).length === 0;
}

// Where a card shows, given its helper terminal (or undefined).
export function columnFor(card, helper) {
  if (card.status !== "running") return card.status;
  if (!helper) return card.terminal ? "review" : "running"; // no address yet: still launching
  return helper.status === "done" || (helper.status === "idle" && (helper.turn ?? 0) >= 1) ? "review" : "running";
}

export function nextOf(list, item) {
  return list[(list.indexOf(item) + 1) % list.length];
}

// What dropping `card` on column `to` does: { ok: true, effect, label } or { ok: false, reason }.
// A refusal with an empty reason is a no-op (dropped back where it was).
export function dropAction(card, to, cards) {
  const from = card.status;
  if (from === to) return from === "todo" ? { ok: true, effect: "reorder", label: "Change the run order" } : { ok: false, reason: "" };
  const run = (label) => {
    const w = waitingOn(card, cards);
    return w.length ? { ok: false, reason: `Waits for "${w[0].task}" to be done` } : { ok: true, effect: "run", label };
  };
  const rules = {
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

const STATUS_AFTER = { done: "done", stop: "todo", "stop-review": "review", back: "todo", reopen: "todo", "reopen-review": "review" };

// The board after a drop, except "run", which the caller starts. A card dropped in To do lands
// before `beforeId` (or last), since To do order is the run order.
export function applyDrop(cards, id, to, beforeId) {
  const card = cards.find((c) => c.id === id);
  const result = card ? dropAction(card, to, cards) : { ok: false, reason: "" };
  if (!result.ok || result.effect === "run") return { cards, result };
  let next = cards.map((c) => (c.id === id ? { ...c, status: STATUS_AFTER[result.effect] ?? c.status } : c));
  if (to === "todo") {
    const moved = next.find((c) => c.id === id);
    next = next.filter((c) => c.id !== id);
    const at = beforeId && beforeId !== id ? next.findIndex((c) => c.id === beforeId) : -1;
    next.splice(at < 0 ? next.length : at, 0, moved);
  }
  return { cards: next, result };
}
