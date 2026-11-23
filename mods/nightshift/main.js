// Nightshift: a queue of coding agents with a Kanban board UI. Cards live in <repo>/.herdr/nightshift.json.
// Run: starts `hc run --bg <template> <task>` in a git worktree (ns/<id>), named ns-<id>.
// Open as a tab: herdr-app do tab.new '{"mod":"nightshift"}'  (props.folder optional)
// Agents can add cards by editing the JSON file; the board re-reads it every 3 s.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, home, props, focused, spaces, terminals, settings, run, theme, readTextFile, writeTextFile, notify, checking, nextCommand } from "herdr";
import { COLUMNS, helperName, branchName, parseCards, mergeCards, waitingOn, isReady, columnFor, nextOf, dropAction, applyDrop, mergeFailure, startable, isTimedOut, shouldAutoMerge } from "./logic.js";

export default class Kanban extends View {
  init(_props, cx) {
    this.cards = [];
    this.fileText = null;      // file text as last read/written, for writeTextFile's stale check
    this.broken = false;       // the file didn't parse: never overwrite it
    this.removed = new Set();  // ids deleted here, so a merge doesn't bring them back
    this.busy = new Set();     // ids with a git action in flight
    this.saving = false;
    this.dirty = false;
    this.templates = ["gemini"];
    this.template = "gemini";
    this.base = null;          // the branch checked out in the repo, where Merge lands
    this.maxRunning = null;    // how many agents may run at once (null: no limit), saved in the board file
    this.timeoutMinutes = null; // stop an agent after this long (null: never), saved in the board file
    this.autoMerge = false;    // merge cards whose agent finished on its own, saved in the board file
    this.press = null;         // {id, x, y}: a card pressed, not yet dragged
    this.drag = null;          // {id, x, y}: the card being dragged, pointer in board coordinates
    this.over = null;          // {col, before}: where it would drop
    this.error = null;
    this.input = InputState.new({ value: "", placeholder: "New task for a helper…" });
    this.input.on("submit", (_e, cx) => this.add(cx));
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        const folder = props()?.folder || focused()?.cwd || spaces().find((s) => s.active)?.folder || home();
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
        this.git = top?.code === 0;
        this.root = this.git ? top.stdout.trim() : folder;
        this.file = `${this.root}/.herdr/nightshift.json`;
        const t = await hc(["templates", "--json"]).catch(() => null);
        try {
          const names = JSON.parse(t.stdout).templates.map((x) => x.name);
          if (names.length) this.templates = names;
        } catch {}
        this.template = this.templates[0];
        this.apply(await readTextFile(this.file));
        await this.refreshBase();
      } catch (e) {
        this.error = `Could not open the board: ${e.message ?? e}`;
      }
      cx.notify();
    });
    // Pick up cards other agents write into the file, and move finished cards to Review.
    cx.timer.every(3000, (cx) => cx.spawn(async (cx) => {
      if (!this.file || this.saving) return;
      try {
        const text = await readTextFile(this.file);
        if (!this.saving && text !== this.fileText) this.apply(text);
        await this.refreshBase();
      } catch (e) {
        this.error = `Could not read ${this.file}: ${e.message ?? e}`;
      }
      this.promote(cx);
      this.schedule(cx);
      cx.notify();
    }));
    // `herdr-app do nightshift.run` starts the oldest To do card that waits for nothing.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const card = this.cards.find((x) => x.status === "todo" && isReady(x, this.cards));
        if (c === "run" && card) this.drop(card.id, "running", null, cx);
        cx.notify();
      }
    });
  }

  apply(text) {
    try {
      const { cards, skipped, maxRunning, timeoutMinutes, autoMerge } = parseCards(text);
      this.cards = cards;
      Object.assign(this, { maxRunning, timeoutMinutes, autoMerge });
      this.broken = false;
      if (skipped) this.error = `Skipped ${skipped} invalid card(s) in ${this.file}`;
    } catch (e) {
      this.broken = true;
      this.error = `Not saving: ${this.file} is not valid JSON (${e.message})`;
    }
    this.fileText = text;
  }

  async refreshBase() {
    if (!this.git) return;
    const r = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.root });
    this.base = r.code === 0 ? r.stdout.trim() : null;
  }

  // One write at a time. If another writer changed the file, merge theirs and try again.
  save(cx) {
    this.dirty = true;
    if (this.saving) return;
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        for (let tries = 0; this.dirty && !this.broken; tries++) {
          if (tries > 3) throw new Error("the file keeps changing");
          this.dirty = false;
          if (this.fileText === null) await exec("mkdir", ["-p", `${this.root}/.herdr`]);
          const text = JSON.stringify({ ...this.settings(), cards: this.cards }, null, 2) + "\n";
          try {
            await writeTextFile(this.file, text, this.fileText);
            this.fileText = text;
          } catch {
            const ours = this.cards;
            const oursSettings = { maxRunning: null, timeoutMinutes: null, autoMerge: false, ...this.settings() };
            this.apply(await readTextFile(this.file));
            if (!this.broken) Object.assign(this, oursSettings, { cards: mergeCards(ours, this.cards, this.removed) });
            this.dirty = true;
          }
        }
      } catch (e) {
        this.error = `Save failed: ${e.message ?? e}`;
      }
      this.saving = false;
      cx.notify();
    });
  }

  card(id) {
    return this.cards.find((c) => c.id === id);
  }

  worktreesDir() {
    const dir = settings()?.worktrees?.directory;
    return typeof dir === "string" && dir ? dir.replace(/^~(?=\/|$)/, home()) : `${home()}/.herdr/worktrees`;
  }

  add(cx) {
    const task = this.input.value().trim();
    if (!task) return;
    this.cards.push({ id: Date.now().toString(36), task, template: this.template, status: "todo" });
    this.input.set_value("");
    this.save(cx);
  }

  remove(id, cx) {
    this.stop(id);
    this.removed.add(id);
    this.cards = this.cards.filter((c) => c.id !== id);
    this.save(cx);
  }

  // Ends a card's helper, if it still runs.
  stop(id) {
    const t = this.live(this.card(id));
    if (t) run("terminal.kill", { terminal: t.address });
  }

  start(id, cx) {
    const card = this.card(id);
    if (!card || !isReady(card, this.cards)) return;
    if (!this.templates.includes(card.template)) return this.fail(id, `Unknown template "${card.template}"`, cx);
    const { task, template } = card;
    card.status = "running";
    delete card.terminal;
    this.save(cx);
    cx.spawn(async (cx) => {
      try {
        let cwd = this.root;
        if (this.git) {
          cwd = `${this.worktreesDir()}/${this.root.split("/").pop()}/${helperName(id)}`;
          // Run again after Back: reuse the card's worktree and branch.
          if ((await exec("test", ["-d", cwd])).code !== 0) {
            const has = (await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName(id)}`], { cwd: this.root })).code === 0;
            const args = has ? ["worktree", "add", cwd, branchName(id)] : ["worktree", "add", "-b", branchName(id), cwd];
            const wt = await exec("git", args, { cwd: this.root });
            if (wt.code !== 0) return this.fail(id, `git worktree: ${wt.stderr.trim()}`, cx);
          }
        }
        await hc(["kill", helperName(id)]).catch(() => null); // a stopped helper may still be closing
        const prompt = `${task}\n\nWork only in ${cwd}. Commit your changes on the current branch when done.`;
        const r = await hc(["run", "--bg", "--json", "--name", helperName(id), "--cwd", cwd, template, prompt]);
        if (r.code !== 0) return this.fail(id, `hc run: ${(r.stderr || r.stdout).trim()}`, cx);
        const c = this.card(id);
        if (!c) return; // removed while starting
        if (this.git) Object.assign(c, { branch: branchName(id), worktree: cwd });
        c.terminal = JSON.parse(r.stdout).address;
        c.startedAt = Date.now();
        for (const k of ["finished", "timedOut", "autoMergeTried"]) delete c[k];
        this.save(cx);
      } catch (e) {
        this.fail(id, `Run failed: ${e.message ?? e}`, cx);
      }
    });
  }

  fail(id, msg, cx) {
    const c = this.card(id);
    if (c?.status === "running") c.status = "todo";
    this.report(msg);
    this.save(cx);
  }

  report(msg) {
    this.error = msg;
    notify({ title: "Kanban", body: msg, level: "error" });
  }

  // Runs one git action for a card at a time; `fn` returns an error message or nothing.
  gitAction(id, cx, fn) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const msg = await fn();
        if (msg) this.report(msg);
      } catch (e) {
        this.report(`${e.message ?? e}`);
      }
      this.busy.delete(id);
      this.save(cx);
    });
  }

  // Merges ns/<id> into the checked-out branch. Never with uncommitted changes; aborts on conflict.
  merge(id, cx) {
    this.gitAction(id, cx, async () => {
      const opts = { cwd: this.root };
      const dirty = await exec("git", ["status", "--porcelain", "--untracked-files=no"], opts);
      if (dirty.stdout.trim()) return `Not merging: ${this.base} has uncommitted changes. Commit or stash them first.`;
      // --no-ff makes a merge commit, which needs a committer.
      const who = await exec("git", ["config", "user.email"], opts);
      if (!who.stdout.trim()) return `Not merging: git has no user.email in ${this.root}, and the merge commit needs one. Run: git config --global user.name "Your Name" && git config --global user.email you@example.com`;
      const m = await exec("git", ["merge", "--no-ff", "--no-edit", branchName(id)], opts);
      if (m.code !== 0) {
        await exec("git", ["merge", "--abort"], opts);
        return mergeFailure(`${m.stdout}\n${m.stderr}`, branchName(id));
      }
      this.stop(id);
      const c = this.card(id);
      if (c) Object.assign(c, { status: "done", merged: true });
    });
  }

  // Removes the card's worktree and branch. Never forced: git refuses dirty worktrees and unmerged branches.
  cleanUp(id, cx) {
    this.gitAction(id, cx, async () => {
      const c = this.card(id);
      if (!c) return;
      const opts = { cwd: this.root };
      if (c.worktree) {
        const w = await exec("git", ["worktree", "remove", c.worktree], opts);
        if (w.code !== 0) return `Worktree kept: ${w.stderr.trim()}`;
        delete c.worktree;
      }
      if (c.branch) {
        const b = await exec("git", ["branch", "-d", c.branch], opts);
        if (b.code !== 0) return `Branch ${c.branch} kept: it isn't merged into ${this.base}. Merge it or delete it yourself.`;
        delete c.branch;
      }
    });
  }

  // To do card waits for the To do card above it, or stops waiting.
  chain(id, above, cx) {
    const c = this.card(id);
    if (!c) return;
    if (c.after?.length) delete c.after;
    else if (above) c.after = [above.id];
    this.save(cx);
  }

  // The card's helper terminal while it lives.
  live(card) {
    return card && terminals().find((t) => t.name === helperName(card.id) && t.state !== "exited");
  }

  column(card) {
    return columnFor(card, this.live(card));
  }

  // The board's settings as saved in its file (defaults left out).
  settings() {
    return {
      ...(this.maxRunning ? { maxRunning: this.maxRunning } : {}),
      ...(this.timeoutMinutes ? { timeoutMinutes: this.timeoutMinutes } : {}),
      ...(this.autoMerge ? { autoMerge: true } : {}),
    };
  }

  // Moves finished agents to Review, stops agents past the timeout, and merges finished cards
  // when auto-merge is on.
  promote(cx) {
    let changed = false;
    const now = Date.now();
    for (const c of this.cards) {
      if (isTimedOut(c, now, this.timeoutMinutes)) {
        this.stop(c.id);
        Object.assign(c, { status: "review", timedOut: true, finished: false });
        changed = true;
      } else if (c.status === "running" && this.column(c) === "review") {
        Object.assign(c, { status: "review", finished: true });
        changed = true;
      }
    }
    for (const c of this.cards) {
      if (shouldAutoMerge(c, this.autoMerge)) {
        c.autoMergeTried = true;
        changed = true;
        this.merge(c.id, cx);
      }
    }
    if (changed) this.save(cx);
  }

  move(id, status, cx) {
    this.stop(id);
    const c = this.card(id);
    if (c) c.status = status;
    this.save(cx);
  }

  // Applies a drag by the confirmed rules: a refusal shows its reason, Run starts an agent.
  drop(id, to, beforeId, cx) {
    const card = this.card(id);
    if (!card) return;
    const { cards, result } = applyDrop(this.cards, id, to, beforeId, this.maxRunning);
    if (!result.ok) {
      if (result.reason) this.error = result.reason;
      return;
    }
    if (result.effect === "run") {
      if (card.status !== "todo") { this.stop(id); card.status = "todo"; }
      return this.start(id, cx);
    }
    if (card.status === "running" || card.status === "review") this.stop(id);
    this.cards = cards;
    this.save(cx);
  }

  // Starts queued cards that are ready, as slots allow.
  schedule(cx) {
    for (const c of startable(this.cards, this.maxRunning)) this.start(c.id, cx);
  }

  render() {
    const t = theme();
    const btn = (id, text, action, color) => div().id(id).px(7).py(2).rounded(5).border_1().border_color(t.input)
      .text_size(11).text_color(color ?? t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => action(cx)).child(text);

    const byCol = Object.fromEntries(COLUMNS.map(([k]) => [k, []]));
    for (const c of this.cards) byCol[this.column(c)].push(c);

    const card = (c, i, list) => {
      const col = this.column(c);
      const helper = this.live(c);
      const status = helper?.status;
      const waits = waitingOn(c, this.cards);
      const busy = this.busy.has(c.id);
      const open = () => btn(`op-${c.id}`, "Open", () => run("terminal.peek", { terminal: helper.address }));
      const actions = h_flex().gap(4).pt(6).flex_wrap();
      if (busy) actions.child(div().text_size(11).text_color(t.dim).child("working on git…"));
      else if (col === "todo") actions
        .child(btn(`tp-${c.id}`, c.template, (cx) => { c.template = nextOf(this.templates, c.template); this.save(cx); }, t.accent))
        .child(btn(`go-${c.id}`, dropAction(c, "running", this.cards, this.maxRunning).effect === "queue" ? "Queue" : "Run", (cx) => this.drop(c.id, "running", null, cx)))
        .when(i > 0 || Boolean(c.after?.length), (el) => el.child(btn(`ch-${c.id}`, c.after?.length ? "Unchain" : "Chain", (cx) => this.chain(c.id, list[i - 1], cx), t.dim)))
        .child(btn(`rm-${c.id}`, "✕", (cx) => this.remove(c.id, cx), t.dim));
      else if (c.status === "queued") actions
        .child(btn(`uq-${c.id}`, "Unqueue", (cx) => this.drop(c.id, "todo", null, cx), t.dim))
        .child(btn(`rm-${c.id}`, "✕", (cx) => this.remove(c.id, cx), t.dim));
      else if (col === "running") actions
        .when(Boolean(helper), (el) => el.child(open()))
        .child(btn(`st-${c.id}`, "Stop", (cx) => this.move(c.id, "todo", cx), t.dim));
      else if (col === "review") actions
        .when(Boolean(helper), (el) => el.child(open()))
        .when(Boolean(c.branch && this.base), (el) => el.child(btn(`mg-${c.id}`, `Merge into ${this.base}`, (cx) => this.merge(c.id, cx), t.accent)))
        .child(btn(`dn-${c.id}`, "Done", (cx) => this.move(c.id, "done", cx)))
        .child(btn(`rt-${c.id}`, "Back", (cx) => this.move(c.id, "todo", cx), t.dim));
      else if (col === "done") actions
        .when(Boolean(c.worktree || c.branch), (el) => el.child(btn(`cl-${c.id}`, "Clean up", (cx) => this.cleanUp(c.id, cx))))
        .child(btn(`rm-${c.id}`, "✕", (cx) => this.remove(c.id, cx), t.dim));
      return v_flex().id(`c-${c.id}`).p(8).rounded(7).bg(t.raised).border_1().cursor_grab()
        .border_color(status === "blocked" ? t.blocked : this.over?.before === c.id && this.drag?.id !== c.id ? t.accent : t.border)
        .when(this.drag?.id === c.id, (el) => el.opacity(0.35))
        .on_mouse_down("left", (e) => { this.press = { id: c.id, x: e.position.x, y: e.position.y }; })
        .on_mouse_move((e) => {
          if (!this.drag) return;
          const below = e.local_position.y > (e.bounds?.height ?? 0) / 2;
          this.over = { col: this.column(c), before: below ? list[i + 1]?.id ?? null : c.id };
        })
        .child(div().text_size(12.5).child(c.task))
        .child(h_flex().gap(6).pt(4).text_size(10.5).text_color(t.dim)
          .child(c.template)
          .when(Boolean(c.branch), (el) => el.child(c.branch))
          .when(Boolean(c.merged), (el) => el.child(div().text_color(t.done).child("merged")))
          .when(Boolean(c.timedOut), (el) => el.child(div().text_color(t.blocked).child("timed out")))
          .when(Boolean(status), (el) => el.child(div().text_color(t[status] ?? t.dim).child(status === "blocked" ? "needs you" : status))))
        .when(col === "todo" && waits.length > 0, (el) => el.child(div().pt(4).text_size(10.5).text_color(t.muted).truncate()
          .child(`waits for: ${waits.map((w) => w.task).join(", ")}`)))
        .when(c.status === "queued", (el) => el.child(div().pt(4).text_size(10.5).text_color(t.muted).truncate()
          .child(waits.length ? `queued · starts after: ${waits.map((w) => w.task).join(", ")}` : "queued · starts when a slot frees")))
        .child(actions);
    };

    const dragged = this.drag && this.card(this.drag.id);
    const verdict = (k) => (dragged ? dropAction(dragged, k, this.cards) : null);

    return v_flex().id("board").relative().size_full().bg(t.surface).text_color(t.foreground).p(10).gap(8)
      .on_mouse_move((e, cx) => {
        if (this.press && !this.drag && Math.hypot(e.position.x - this.press.x, e.position.y - this.press.y) > 5) {
          this.drag = { id: this.press.id };
          this.over = null;
        }
        if (!this.drag) return;
        Object.assign(this.drag, { x: e.local_position.x, y: e.local_position.y });
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const { drag, over } = this;
        this.press = this.drag = this.over = null;
        if (drag && over) this.drop(drag.id, over.col, over.before, cx);
        cx.notify();
      })
      .on_hover((hovered, cx) => { if (!hovered && this.drag) { this.press = this.drag = this.over = null; cx.notify(); } })
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(14).font_semibold().child("Nightshift"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.root ?? ""))
        .child(btn("max", `max running ${this.maxRunning ?? "∞"}`, (cx) => {
          this.maxRunning = nextOf([null, 1, 2, 3, 4], this.maxRunning);
          this.save(cx);
          this.schedule(cx);
        }, t.dim))
        .child(btn("timeout", `timeout ${this.timeoutMinutes ? `${this.timeoutMinutes}m` : "off"}`, (cx) => {
          this.timeoutMinutes = nextOf([null, 15, 30, 60], this.timeoutMinutes);
          this.save(cx);
        }, t.dim))
        .child(btn("automerge", `auto-merge ${this.autoMerge ? "on" : "off"}`, (cx) => {
          this.autoMerge = !this.autoMerge;
          this.save(cx);
        }, this.autoMerge ? t.accent : t.dim)))
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.input).flex_1().h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(btn("tpl", this.template, (cx) => { this.template = nextOf(this.templates, this.template); cx.notify(); }, t.accent))
        .child(btn("add", "Add", (cx) => this.add(cx))))
      .when(Boolean(this.error), (el) => el.child(div().id("err").text_size(11).text_color(t.blocked).cursor_pointer()
        .on_click((_e, cx) => { this.error = null; cx.notify(); }).child(`${this.error}  (click to dismiss)`)))
      .child(h_flex().flex_1().min_h(0).gap(8).items_start().children(COLUMNS.map(([k, label]) =>
        v_flex().id(`col-${k}`).flex_1().min_w(0).h_full().gap(6).p(6).rounded(8).bg(t.canvas).overflow_y_scrollbar()
          .border_1().border_color(verdict(k)?.ok ? t.accent : verdict(k)?.reason ? t.blocked : t.canvas)
          .on_mouse_move(() => { if (this.drag && this.over?.col !== k) this.over = { col: k, before: null }; })
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(`${label} · ${byCol[k].length}`))
          .when(Boolean(verdict(k)?.label || verdict(k)?.reason), (el) => el.child(div().text_size(10.5)
            .text_color(verdict(k).ok ? t.accent : t.blocked).child(verdict(k).label ?? verdict(k).reason)))
          .children(byCol[k].map((c, i, list) => card(c, i, list))))))
      .when(Boolean(dragged && this.drag.x != null), (el) => el.child(div().absolute().left(this.drag.x + 10).top(this.drag.y + 10)
        .w(240).p(8).rounded(7).bg(t.raised).border_1().border_color(t.accent).opacity(0.92).text_size(12.5).cursor_grabbing()
        .child(dragged.task)));
  }
}
