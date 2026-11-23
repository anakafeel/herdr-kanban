# herdr-nightshift

**Your coding agents work the night shift.** Line up a batch of cards in
[Herdr](https://herdr.dev), walk away, and come back to a Review column: herdr-nightshift runs
them N at a time, in order, each in its own git worktree, on the agent you pick per card. A local
model takes the easy ones, Claude the hard ones. You drive it from a drag-and-drop Kanban board.

![herdr-nightshift: queue the cards, your agents work the night shift](launch.gif)

**A real run**, recorded in Herdr: three cards, Gemini and Copilot agents, a queued card that
starts by itself, merged into `main`.

![A real run: cards dragged to Running, a queued card, Merge into main](demo.gif)

## Built for unattended batches

- **Running is a queue.** Drop cards on Running; they start as slots free up. **max running**
  caps how many agents work at once: 1 for a single local model, 2 or 3 to spread quota.
- **Chains.** A card can wait for another; it starts by itself once that one is Done.
- **Any agent, per card.** Every card picks one of your `hc` templates: Claude Code, Gemini,
  Copilot, OpenCode on a local model.
- **Timeout.** An agent that runs too long is stopped and its card goes to Review, marked
  "timed out", so one stuck card can't hold the queue.
- **Auto-merge** (off by default). A card whose agent finished on its own merges into your
  branch; a conflict aborts cleanly and leaves the card in Review for you.
- **Isolated.** Each card works in its own worktree on `ns/<id>`, never in your checkout.
- **Watchable.** Agents are ordinary herdr-core terminals: open one mid-task, steer it, take over.

Inspired by [Vibe Kanban](https://github.com/BloopAI/vibe-kanban), but native to Herdr and
built around running a queue of work, not one card at a time.

## Install

Ask your agent in Herdr: *"add the herdr-mod from github.com/anakafeel/herdr-nightshift"*.

Or by hand:

```sh
git clone https://github.com/anakafeel/herdr-nightshift
cp -r herdr-nightshift/mods/nightshift ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/nightshift
```

Then add the shortcut from [`keys.json`](keys.json) to your `~/.config/herdr-app/keys.json`
(`alt-shift-b` opens a board), and `.herdr/` to the `.gitignore` of repos you use it in.

## Use

Press `alt-shift-b`, or open a board for the repo of the focused terminal:

```sh
herdr-app do tab.new '{"mod":"nightshift"}'
# or a specific repo:
herdr-app do tab.new '{"mod":"nightshift","props":{"folder":"/path/to/repo"}}'
```

**Drag cards between columns.** While you drag, each column says what dropping there
does, or why it can't:

| From → To | To do | Running | Review | Done |
|---|---|---|---|---|
| **To do** | reorder (the run order) | start an agent, or queue it | refused: run it first | done without an agent |
| **Running** | stop the agent | | stop it and review its work | refused: still working |
| **Review** | back (same branch next time) | run again (or queue) on the same branch | | done |
| **Done** | reopen | refused: reopen first | reopen for review | |
| **Queued** (in Running) | take it out of the queue | reorder the queue | refused: it hasn't run yet | done without an agent |

Every move also has a button on the card:

| Column | Buttons |
|---|---|
| **To do** | template (cycles through `hc templates`), **Run** (or **Queue**), **Chain** (wait for the card above), **✕** |
| **Running** | **Open** (peek at the agent's terminal), **Stop**; queued cards: **Unqueue**, **✕** |
| **Review** | **Open**, **Merge into `<branch>`**, **Done**, **Back** |
| **Done** | **Clean up** (remove the worktree and branch), **✕** |

- **Running is a queue.** A card dropped on Running starts at once, unless it waits for
  other cards or every slot is taken: then it's queued ("queued · starts after …") and
  starts by itself as soon as it can, in queue order. **max running** in the header sets
  the slots (∞, 1 to 4), handy for a single local model or to cap parallel quota use.
- **timeout** (off, 15, 30, 60 min) and **auto-merge** (off, on) sit beside it.
- **Chained cards** show "waits for …" and start only once those cards are Done.
- **Merge** runs `git merge --no-ff` into the branch checked out in your repo. It refuses
  when that checkout has uncommitted changes, and on a conflict it aborts, so nothing is
  left half-merged.
- **Clean up** never forces: git keeps a worktree with uncommitted work and a branch that
  isn't merged, and the board tells you which.
- A card border in your theme's "blocked" color means its agent needs you.

Agents work in `<worktrees>/<repo>/ns-<id>` on branch `ns/<id>`. `<worktrees>` is Herdr's
`worktrees.directory` setting, `~/.herdr/worktrees` by default. The worktree branches from
your current commit, so commit first: the agent does not see uncommitted changes.

Cards live in `<repo>/.herdr/nightshift.json` (`{"maxRunning"?: n, "timeoutMinutes"?: n, "autoMerge"?: true, "cards": [{id, task, template, status, after?}]}`).
The board re-reads it every 3 s, so an orchestrating agent can plan work by writing cards
into it, with `after` for order. `herdr-app do nightshift.run` starts (or queues) the first ready To-do card
on every open board, so keep one board per repo.

## What it runs

This mod runs programs on your machine: `git` (worktrees, `ns/<id>` branches, merges into
your checked-out branch), `mkdir`, `test` and `hc` (to start agents with your templates).
It writes `<repo>/.herdr/nightshift.json` and worktrees under `<worktrees>`. It never reaches
the network itself.

**Anything that can write `.herdr/nightshift.json` can queue tasks for your agents**, and a
card runs with whatever permissions its template has. If a template lets an agent run
commands without asking, a card in that file is a command on your machine once someone
starts it. Only start cards you read, and keep `.herdr/` out of shared or untrusted
checkouts. Card ids must match `[a-z0-9_-]{1,24}` and templates must exist in
`hc templates`; other cards are skipped.

## Develop

The board rules (parsing, merging, dependencies, columns, drag rules) live in
[`mods/nightshift/logic.js`](mods/nightshift/logic.js) with no Herdr calls, so they run under Node:

```sh
npm test
herdr-app check mods/nightshift
```

## License

MIT
