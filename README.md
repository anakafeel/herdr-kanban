# herdr-kanban

A Kanban board for [Herdr](https://herdr.dev) that hands each card to a coding agent.

![herdr-kanban](preview.png)

Write a task, pick an agent, press **Run**. The board makes a git worktree on its own
branch, starts the agent there with `hc run`, and moves the card along as the agent works:
**To do → Running → Review → Done**. Any `hc` template works: Claude Code, Gemini,
Copilot, OpenCode on a local model, whatever you have set up.

Inspired by [Vibe Kanban](https://github.com/BloopAI/vibe-kanban), but native to Herdr:
the agents are ordinary herdr-core terminals, so you can watch, steer or take over any of
them, and they follow your own `hc` templates instead of a separate agent setup.

## Install

Ask your agent in Herdr: *"add the herdr-mod from github.com/anakafeel/herdr-kanban"*.

Or by hand:

```sh
git clone https://github.com/anakafeel/herdr-kanban
cp -r herdr-kanban/mods/kanban ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/kanban
```

Add `.herdr/` to the `.gitignore` of repos you use it in.

## Use

Open a board for the repo of the focused terminal:

```sh
herdr-app do tab.new '{"mod":"kanban"}'
# or a specific repo:
herdr-app do tab.new '{"mod":"kanban","props":{"folder":"/path/to/repo"}}'
```

| Column | What happens |
|---|---|
| **To do** | Type a task, pick a template (the button cycles through `hc templates`), **Add**. **Run** starts it. |
| **Running** | The agent works in `<worktrees>/<repo>/kb-<id>` on branch `kb/<id>`. A border in your theme's "blocked" color means it needs you; **Open** peeks at its terminal, **Stop** ends it and puts the card back in To do. |
| **Review** | The agent stopped. Check its branch, then **Done** (closes its terminal) or **Back** (to To do; Run again reuses the same branch and worktree). |
| **Done** | Finished. Merge `kb/<id>` yourself. |

`<worktrees>` is Herdr's `worktrees.directory` setting, `~/.herdr/worktrees` by default.
The worktree branches from your current commit, so commit first: the agent does not see
uncommitted changes.

Cards live in `<repo>/.herdr/kanban.json`. The board re-reads it every 3 s, so an
orchestrating agent can plan work by writing cards into it. `herdr-app do kanban.run`
starts the oldest To-do card on every open board, so keep one board per repo.

## What it runs

This mod runs programs on your machine: `git` (worktrees and `kb/<id>` branches in your
repo), `mkdir`, `test` and `hc` (to start agents with your templates). It writes
`<repo>/.herdr/kanban.json` and worktrees under `<worktrees>`. It never reaches the
network itself.

**Anything that can write `.herdr/kanban.json` can queue tasks for your agents**, and a
card runs with whatever permissions its template has. If a template lets an agent run
commands without asking, a card in that file is a command on your machine once someone
presses Run. Only press Run on cards you read, and keep `.herdr/` out of shared or
untrusted checkouts. Card ids must match `[a-z0-9_-]{1,24}` and templates must exist in
`hc templates`; other cards are skipped.

## Not yet

- Cards that wait on other cards.
- Merging branches or removing worktrees for you.
- A default key to open the board.

## License

MIT
