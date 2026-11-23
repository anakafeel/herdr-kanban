// Kanban board for hc helpers. Cards live in <repo>/.herdr/kanban.json.
// Run: starts `hc run --bg <template> <task>` in a git worktree (kb/<id>), named kb-<id>.
// Open as a tab: herdr-app do tab.new '{"mod":"kanban"}'  (props.folder optional)
// Agents can add cards by editing the JSON file; the board re-reads it every 3 s.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, home, props, focused, spaces, terminals, run, theme, readTextFile, writeTextFile, notify, checking, nextCommand } from "herdr";

const COLUMNS = [["todo", "To do"], ["running", "Running"], ["review", "Review"], ["done", "Done"]];

export default class Kanban extends View {
  init(_props, cx) {
    this.cards = [];
    this.raw = null;       // file text as last read/written, for writeTextFile's stale check
    this.templates = ["gemini"];
    this.template = "gemini";
    this.error = null;
    this.input = InputState.new({ value: "", placeholder: "New task for a helper…" });
    this.input.on("submit", (_e, cx) => this.add(cx));
    if (checking()) return;
    cx.spawn(async (cx) => {
      const folder = props()?.folder ?? focused()?.cwd ?? spaces().find((s) => s.active)?.folder ?? home();
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
      this.git = top?.code === 0;
      this.root = this.git ? top.stdout.trim() : folder;
      this.file = `${this.root}/.herdr/kanban.json`;
      const t = await hc(["templates", "--json"]).catch(() => null);
      try { this.templates = JSON.parse(t.stdout).templates.map((x) => x.name); } catch {}
      this.template = this.templates[0] ?? "gemini";
      await this.load();
      cx.notify();
    });
    // Pick up cards other agents write into the file.
    cx.timer.every(3000, (cx) => cx.spawn(async (cx) => {
      if (!this.file) return;
      const text = await readTextFile(this.file);
      if (text !== this.raw) { await this.load(); cx.notify(); }
    }));
    // `herdr-app do kanban.run` starts the oldest To do card.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const card = this.cards.find((x) => x.status === "todo");
        if (c === "run" && card) this.start(card, cx);
        cx.notify();
      }
    });
  }

  async load() {
    this.raw = await readTextFile(this.file);
    try { this.cards = this.raw ? JSON.parse(this.raw).cards ?? [] : []; } catch (e) { this.error = `Bad ${this.file}: ${e.message}`; }
  }

  save(cx) {
    cx.spawn(async (cx) => {
      const text = JSON.stringify({ cards: this.cards }, null, 2) + "\n";
      try {
        if (this.raw === null) await exec("mkdir", ["-p", `${this.root}/.herdr`]);
        await writeTextFile(this.file, text, this.raw);
        this.raw = text;
      } catch (e) {
        // Someone else edited the file: reload theirs rather than overwrite it.
        this.error = `Board changed on disk, reloaded (${e.message ?? e})`;
        await this.load();
      }
      cx.notify();
    });
  }

  add(cx) {
    const task = this.input.value().trim();
    if (!task) return;
    const id = Date.now().toString(36);
    this.cards.push({ id, task, template: this.template, status: "todo" });
    this.input.set_value("");
    this.save(cx);
  }

  start(card, cx) {
    card.status = "running";
    this.save(cx);
    cx.spawn(async (cx) => {
      let cwd = this.root;
      if (this.git) {
        const repo = this.root.split("/").pop();
        cwd = `${home()}/.herdr/worktrees/${repo}/kb-${card.id}`;
        const wt = await exec("git", ["worktree", "add", "-b", `kb/${card.id}`, cwd], { cwd: this.root });
        if (wt.code !== 0) return this.fail(card, `git worktree: ${wt.stderr.trim()}`, cx);
        card.branch = `kb/${card.id}`;
        card.worktree = cwd;
      }
      const task = `${card.task}\n\nWork only in ${cwd}. Commit your changes on the current branch when done.`;
      const r = await hc(["run", "--bg", "--name", `kb-${card.id}`, "--cwd", cwd, card.template, task]);
      if (r.code !== 0) return this.fail(card, `hc run: ${(r.stderr || r.stdout).trim()}`, cx);
      try { card.terminal = JSON.parse(r.stdout).address; } catch {}
      this.save(cx);
    });
  }

  fail(card, msg, cx) {
    card.status = "todo";
    this.error = msg;
    notify({ title: "Kanban", body: msg, level: "error" });
    this.save(cx);
  }

  // A running card's helper, matched by name; promotes to review once it stops working.
  live(card) {
    return terminals().find((t) => t.name === `kb-${card.id}` && t.state !== "exited");
  }

  column(card) {
    if (card.status !== "running") return card.status;
    const t = this.live(card);
    if (!t) return card.terminal ? "review" : "running"; // no address yet: still launching
    return t.status === "done" || (t.status === "idle" && (t.turn ?? 0) >= 1) ? "review" : "running";
  }

  move(card, status, cx) {
    if (status === "done" && card.terminal) run("terminal.kill", { terminal: card.terminal });
    card.status = status;
    this.save(cx);
  }

  render() {
    const t = theme();
    const btn = (id, text, action, color) => div().id(id).px(7).py(2).rounded(5).border_1().border_color(t.input)
      .text_size(11).text_color(color ?? t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => action(cx)).child(text);

    const card = (c) => {
      const col = this.column(c);
      if (col === "review" && c.status === "running") c.status = "review"; // persisted on next save
      const tm = this.live(c);
      const st = tm?.status;
      const actions = h_flex().gap(4).pt(6).flex_wrap();
      if (col === "todo") actions
        .child(btn(`tp-${c.id}`, c.template, (cx) => { const i = this.templates.indexOf(c.template); c.template = this.templates[(i + 1) % this.templates.length]; this.save(cx); }, t.accent))
        .child(btn(`go-${c.id}`, "Run", (cx) => this.start(c, cx)))
        .child(btn(`rm-${c.id}`, "✕", (cx) => { this.cards = this.cards.filter((x) => x !== c); this.save(cx); }, t.dim));
      if ((col === "running" || col === "review") && tm) actions.child(btn(`op-${c.id}`, "Open", () => run("terminal.peek", { terminal: tm.address })));
      if (col === "review") actions
        .child(btn(`dn-${c.id}`, "Done", (cx) => this.move(c, "done", cx)))
        .child(btn(`rt-${c.id}`, "Back", (cx) => this.move(c, "todo", cx), t.dim));
      if (col === "done") actions.child(btn(`rm-${c.id}`, "✕", (cx) => { this.cards = this.cards.filter((x) => x !== c); this.save(cx); }, t.dim));
      return v_flex().id(`c-${c.id}`).p(8).rounded(7).bg(t.raised).border_1()
        .border_color(st === "blocked" ? t.blocked : t.border)
        .child(div().text_size(12.5).child(c.task))
        .child(h_flex().gap(6).pt(4).text_size(10.5).text_color(t.dim)
          .child(c.template)
          .when(Boolean(c.branch), (el) => el.child(c.branch))
          .when(Boolean(st), (el) => el.child(div().text_color(t[st] ?? t.dim).child(st === "blocked" ? "needs you" : st))))
        .child(actions);
    };

    const byCol = Object.fromEntries(COLUMNS.map(([k]) => [k, []]));
    for (const c of this.cards) byCol[this.column(c)]?.push(c);

    return v_flex().size_full().bg(t.surface).text_color(t.foreground).p(10).gap(8)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(14).font_semibold().child("Kanban"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.root ?? "")))
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.input).flex_1().h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(btn("tpl", this.template, (cx) => { const i = this.templates.indexOf(this.template); this.template = this.templates[(i + 1) % this.templates.length]; cx.notify(); }, t.accent))
        .child(btn("add", "Add", (cx) => this.add(cx))))
      .when(Boolean(this.error), (el) => el.child(div().id("err").text_size(11).text_color(t.blocked).cursor_pointer()
        .on_click((_e, cx) => { this.error = null; cx.notify(); }).child(`${this.error}  (click to dismiss)`)))
      .child(h_flex().flex_1().min_h(0).gap(8).items_start().children(COLUMNS.map(([k, label]) =>
        v_flex().id(`col-${k}`).flex_1().min_w(0).h_full().gap(6).p(6).rounded(8).bg(t.canvas).overflow_y_scrollbar()
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(`${label} · ${byCol[k].length}`))
          .children(byCol[k].map(card)))));
  }
}
