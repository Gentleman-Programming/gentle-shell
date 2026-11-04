import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { JobsView } from "../lib/jobs-view.ts";
import type { JobRecord } from "../lib/background-jobs.ts";
import { VisualCustomizeView } from "../lib/visual-customize-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
const theme = { fg: (role: string, text: string) => role === "warning" ? `\x1b[33m${text}\x1b[39m` : text };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function at(lines: string[], label: string, type: TuiMouseEvent["type"], delta = 0): TuiMouseEvent {
    const plain = lines.map(stripAnsi);
    const y = plain.findIndex(line => line.includes(label));
    assert.ok(y >= 0, label);
    const x = visibleWidth(plain[y]!.slice(0, plain[y]!.lastIndexOf(label))) + delta;
    return { type, button: type === "move" ? "none" : "left", x, y, screenX: x, screenY: y,
        width: visibleWidth(plain[0]!), height: lines.length, shift: false, alt: false, ctrl: false };
}
const record = (id: string, startedAt: number): JobRecord => ({ id, startedAt, kind: "command", label: id, command: `run ${id}`, cwd: "/repo", ownerSessionId: "session", outputPath: `/isolated/${id}.log`, status: "running", tail: [] });
// S2/S3: adversarial live identity changes, with and without intervening paint.
test("pending Stop never transfers across removal, reorder, or completion", () => {
    for (const mutation of ["remove", "reorder", "complete", "replace-record"] as const)
        for (const repaint of [false, true]) {
            let jobs = [record("first", 20), record("second", 10)];
            const stopped: JobRecord[] = [];
            const view = new JobsView({ theme, rows: () => 14, jobs: () => jobs, now: () => 100, onStop: j => stopped.push(j), onClose() { }, requestRender() { } });
            try {
                const first = jobs[0]!;
                const frame = view.render(100);
                view.handleMouse(at(frame, "s Stop", "move"));
                assert.deepEqual(stopped, []);
                view.handleMouse(at(frame, "s Stop", "press"));
                if (mutation === "remove")
                    jobs.shift();
                if (mutation === "reorder")
                    jobs.unshift(record("newest", 30));
                if (mutation === "complete")
                    first.status = "stopped";
                if (mutation === "replace-record")
                    jobs[0] = { ...first, tail: ["new live output"] };
                if (repaint)
                    view.render(100);
                view.handleMouse(at(frame, "s Stop", "click"));
                if (mutation === "replace-record")
                    assert.deepEqual(stopped, [jobs[0]], "stop must receive the live record, not rendered snapshot");
                else if (mutation === "reorder" && repaint)
                    assert.deepEqual(stopped, [first], "a repaint can preserve the same explicit job identity");
                else
                    assert.deepEqual(stopped, [], `${mutation}, repaint=${repaint}`);
                if (mutation === "remove") {
                    const fresh = view.render(100);
                    view.handleMouse(at(fresh, "s Stop", "press"));
                    view.handleMouse(at(fresh, "s Stop", "click"));
                    assert.deepEqual(stopped, [jobs[0]], "a new deliberate press can stop the remaining running job");
                }
            }
            finally {
                view.dispose();
            }
        }
});
// S1/S2: all consent cells remain explicit after orange paint and rerender.
test("hovered inline yes/cancel spans preserve exact stored bytes until deliberate consent", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "hover-consent-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const width of [36, 80, 140])
        for (const label of ["y yes", "cancel"])
            for (let delta = -1; delta <= label.length; delta++) {
                const path = join(dir, `${width}-${label.replaceAll(" ", "_")}-${delta}.json`);
                writeFileSync(path, '{"permission":"NORMAL"}\n');
                const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
                const before = hash();
                const answers: boolean[] = [];
                const view = new VisualCustomizeView({ rows: [{ label: "Permission", action: async (inline) => {
                                const yes = await inline.confirm("Go?");
                                answers.push(yes);
                                if (yes)
                                    writeFileSync(path, '{"permission":"YOLO"}\n');
                            } }], theme, rowsAvailable: () => 24, requestRender() { }, onClose() { } });
                try {
                    let frame = view.render(width);
                    view.handleMouse(at(frame, "Permission", "click"));
                    await tick();
                    frame = view.render(width);
                    view.handleMouse(at(frame, label, "move", delta));
                    frame = view.render(width);
                    assert.equal(hash(), before, "hover never writes");
                    assert.deepEqual(answers, []);
                    view.handleMouse(at(frame, label, "press", delta));
                    assert.equal(hash(), before, "press never writes");
                    frame = view.render(width);
                    view.handleMouse(at(frame, label, "click", delta));
                    await tick();
                    const inside = delta >= 0 && delta < label.length;
                    assert.deepEqual(answers, inside ? [label === "y yes"] : []);
                    if (!inside || label === "cancel")
                        assert.equal(hash(), before, "every rejected/declined action leaves exact stored bytes");
                    else
                        assert.equal(readFileSync(path, "utf8"), '{"permission":"YOLO"}\n');
                }
                finally {
                    view.dispose();
                    await tick();
                }
            }
});
// S1/S2: same-name content drift must still fail after all confirmation paints.
test("hover cannot make a changed profile fingerprint apply replace or delete", async () => {
    for (const key of ["a", "r", "d"]) {
        const profile = { name: "Desk y yes", themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } } };
        let catalog = [profile];
        const effects: string[] = [];
        const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => 12, requestRender() { }, onClose() { }, profiles: { list: () => catalog, save: () => { effects.push("replace"); }, apply: () => { effects.push("apply"); }, delete: () => { effects.push("delete"); }, reset() { } } });
        try {
            view.handleInput("p");
            view.handleInput(key);
            let frame = view.render(80);
            view.handleMouse(at(frame, "y yes", "move"));
            frame = view.render(80);
            assert.deepEqual(effects, []);
            catalog = [{ ...profile, themeName: "light" }];
            view.handleMouse(at(frame, "y yes", "press"));
            frame = view.render(80);
            view.handleMouse(at(frame, "y yes", "click"));
            await tick();
            assert.deepEqual(effects, []);
            assert.match(view.render(80).map(stripAnsi).join("\n"), /Profile changed; choose again\./);
        }
        finally {
            view.dispose();
        }
    }
});
