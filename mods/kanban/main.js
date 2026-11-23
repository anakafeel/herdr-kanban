// Kanban board for hc helpers. Cards live in <repo>/.herdr/kanban.json.
// Run: starts `hc run --bg <template> <task>` in a git worktree (kb/<id>), named kb-<id>.
// Open as a tab: herdr-app do tab.new '{"mod":"kanban"}'  (props.folder optional)
// Agents can add cards by editing the JSON file; the board re-reads it every 3 s.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, home, props, focused, spaces, terminals, settings, run, theme, readTextFile, writeTextFile, notify, checking, nextCommand } from "herdr";

const COLUMNS = [["todo", "To do"], ["running", "Running"], ["review", "Review"], ["done", "Done"]];
const STATUSES = new Set(COLUMNS.map(([k]) => k));
const ID = /^[a-z0-9_-]{1,24}$/; // hc --name takes 1-32 of a-z 0-9 - _, and "kb-" uses 3
const helperName = (id) => `kb-${id}`;
const branchName = (id) => `kb/${id}`;

export default class Kanban extends View {
  init(_props, cx) {
    this.cards = [];
    this.fileText = null;      // file text as last read/written, for writeTextFile's stale check
    this.broken = false;       // the file didn't parse: never overwrite it
    this.removed = new Set();  // ids deleted here, so a merge doesn't bring them back
    this.saving = false;
    this.dirty = false;
    this.templates = ["gemini"];
    this.template = "gemini";
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
        this.file = `${this.root}/.herdr/kanban.json`;
        const t = await hc(["templates", "--json"]).catch(() => null);
        try {
          const names = JSON.parse(t.stdout).templates.map((x) => x.name);
          if (names.length) this.templates = names;
        } catch {}
        this.template = this.templates[0];
        this.apply(await readTextFile(this.file));
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
      } catch (e) {
        this.error = `Could not read ${this.file}: ${e.message ?? e}`;
      }
      this.promote(cx);
      cx.notify();
    }));
    // `herdr-app do kanban.run` starts the oldest To do card.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const card = this.cards.find((x) => x.status === "todo");
        if (c === "run" && card) this.start(card.id, cx);
        cx.notify();
      }
    });
  }

  // Cards from file text; drops cards with a bad id, task or status.
  parse(text) {
    const cards = text ? JSON.parse(text).cards ?? [] : [];
    const ok = cards.filter((c) => c && ID.test(c.id) && typeof c.task === "string" && STATUSES.has(c.status));
    if (ok.length < cards.length) this.error = `Skipped ${cards.length - ok.length} invalid card(s) in ${this.file}`;
    return ok;
  }

  apply(text) {
    try {
      this.cards = this.parse(text);
      this.broken = false;
    } catch (e) {
      this.broken = true;
      this.error = `Not saving: ${this.file} is not valid JSON (${e.message})`;
    }
    this.fileText = text;
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
          const text = JSON.stringify({ cards: this.cards }, null, 2) + "\n";
          try {
            await writeTextFile(this.file, text, this.fileText);
            this.fileText = text;
          } catch {
            await this.merge();
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

  // Keep the other writer's cards; ours win for ids both have.
  async merge() {
    const text = await readTextFile(this.file);
    const ours = this.cards;
    this.apply(text);
    if (this.broken) return;
    const theirs = this.cards.filter((c) => !this.removed.has(c.id));
    const merged = theirs.map((c) => ours.find((o) => o.id === c.id) ?? c);
    for (const o of ours) if (!merged.some((m) => m.id === o.id)) merged.push(o);
    this.cards = merged;
  }

  card(id) {
    return this.cards.find((c) => c.id === id);
  }

  nextTemplate(name) {
    return this.templates[(this.templates.indexOf(name) + 1) % this.templates.length];
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
    if (!card || card.status !== "todo") return;
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
        const prompt = `${task}\n\nWork only in ${cwd}. Commit your changes on the current branch when done.`;
        const r = await hc(["run", "--bg", "--json", "--name", helperName(id), "--cwd", cwd, template, prompt]);
        if (r.code !== 0) return this.fail(id, `hc run: ${(r.stderr || r.stdout).trim()}`, cx);
        const c = this.card(id);
        if (!c) return; // removed while starting
        if (this.git) Object.assign(c, { branch: branchName(id), worktree: cwd });
        c.terminal = JSON.parse(r.stdout).address;
        this.save(cx);
      } catch (e) {
        this.fail(id, `Run failed: ${e.message ?? e}`, cx);
      }
    });
  }

  fail(id, msg, cx) {
    const c = this.card(id);
    if (c) c.status = "todo";
    this.error = msg;
    notify({ title: "Kanban", body: msg, level: "error" });
    this.save(cx);
  }

  // The card's helper terminal while it lives.
  live(card) {
    return card && terminals().find((t) => t.name === helperName(card.id) && t.state !== "exited");
  }

  column(card) {
    if (card.status !== "running") return card.status;
    const t = this.live(card);
    if (!t) return card.terminal ? "review" : "running"; // no address yet: still launching
    return t.status === "done" || (t.status === "idle" && (t.turn ?? 0) >= 1) ? "review" : "running";
  }

  // Saves cards whose helper finished as Review.
  promote(cx) {
    let changed = false;
    for (const c of this.cards) {
      if (c.status === "running" && this.column(c) === "review") { c.status = "review"; changed = true; }
    }
    if (changed) this.save(cx);
  }

  move(id, status, cx) {
    this.stop(id);
    const c = this.card(id);
    if (c) c.status = status;
    this.save(cx);
  }

  render() {
    const t = theme();
    const btn = (id, text, action, color) => div().id(id).px(7).py(2).rounded(5).border_1().border_color(t.input)
      .text_size(11).text_color(color ?? t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => action(cx)).child(text);

    const card = (c) => {
      const col = this.column(c);
      const helper = this.live(c);
      const status = helper?.status;
      const open = () => btn(`op-${c.id}`, "Open", () => run("terminal.peek", { terminal: helper.address }));
      const actions = h_flex().gap(4).pt(6).flex_wrap();
      if (col === "todo") actions
        .child(btn(`tp-${c.id}`, c.template, (cx) => { c.template = this.nextTemplate(c.template); this.save(cx); }, t.accent))
        .child(btn(`go-${c.id}`, "Run", (cx) => this.start(c.id, cx)))
        .child(btn(`rm-${c.id}`, "✕", (cx) => this.remove(c.id, cx), t.dim));
      if (col === "running") actions
        .when(Boolean(helper), (el) => el.child(open()))
        .child(btn(`st-${c.id}`, "Stop", (cx) => this.move(c.id, "todo", cx), t.dim));
      if (col === "review") actions
        .when(Boolean(helper), (el) => el.child(open()))
        .child(btn(`dn-${c.id}`, "Done", (cx) => this.move(c.id, "done", cx)))
        .child(btn(`rt-${c.id}`, "Back", (cx) => this.move(c.id, "todo", cx), t.dim));
      if (col === "done") actions.child(btn(`rm-${c.id}`, "✕", (cx) => this.remove(c.id, cx), t.dim));
      return v_flex().id(`c-${c.id}`).p(8).rounded(7).bg(t.raised).border_1()
        .border_color(status === "blocked" ? t.blocked : t.border)
        .child(div().text_size(12.5).child(c.task))
        .child(h_flex().gap(6).pt(4).text_size(10.5).text_color(t.dim)
          .child(c.template)
          .when(Boolean(c.branch), (el) => el.child(c.branch))
          .when(Boolean(status), (el) => el.child(div().text_color(t[status] ?? t.dim).child(status === "blocked" ? "needs you" : status))))
        .child(actions);
    };

    const byCol = Object.fromEntries(COLUMNS.map(([k]) => [k, []]));
    for (const c of this.cards) byCol[this.column(c)].push(c);

    return v_flex().size_full().bg(t.surface).text_color(t.foreground).p(10).gap(8)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(14).font_semibold().child("Kanban"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.root ?? "")))
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.input).flex_1().h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(btn("tpl", this.template, (cx) => { this.template = this.nextTemplate(this.template); cx.notify(); }, t.accent))
        .child(btn("add", "Add", (cx) => this.add(cx))))
      .when(Boolean(this.error), (el) => el.child(div().id("err").text_size(11).text_color(t.blocked).cursor_pointer()
        .on_click((_e, cx) => { this.error = null; cx.notify(); }).child(`${this.error}  (click to dismiss)`)))
      .child(h_flex().flex_1().min_h(0).gap(8).items_start().children(COLUMNS.map(([k, label]) =>
        v_flex().id(`col-${k}`).flex_1().min_w(0).h_full().gap(6).p(6).rounded(8).bg(t.canvas).overflow_y_scrollbar()
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(`${label} · ${byCol[k].length}`))
          .children(byCol[k].map(card)))));
  }
}
