import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const markup = readFileSync(path.join(publicDirectory, "index.html"), "utf8");
const script = readFileSync(path.join(publicDirectory, "app.js"), "utf8");

/** A button inside a form defaults to type="submit", so a bare Cancel silently starts the run. */
test("dialog forms contain no implicit submit buttons", () => {
  for (const form of markup.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)) {
    for (const button of form[1]!.matchAll(/<button[^>]*>/g)) {
      assert.match(button[0], /\stype="(?:button|submit)"/, `button without an explicit type: ${button[0]}`);
    }
  }
});

test("dismiss controls close their dialog instead of submitting", () => {
  const dismissals = [...markup.matchAll(/<button[^>]*data-close-dialog="([^"]+)"[^>]*>/g)];
  assert.equal(dismissals.length, 4, "each dialog form needs a cancel and a close control");
  for (const dismissal of dismissals) {
    assert.match(dismissal[0], /type="button"/, `dismiss control must not submit: ${dismissal[0]}`);
    assert.ok(markup.includes(`id="${dismissal[1]}"`), `unknown dialog target: ${dismissal[1]}`);
  }
  assert.match(script, /\[data-close-dialog\][\s\S]*?\.close\(\)/, "close controls must be wired to dialog.close()");
});

test("replay can redefine every run input slot the API accepts", () => {
  for (const id of ["replay-csv-file", "replay-folder-id", "replay-user-id"]) {
    assert.ok(markup.includes(`id="${id}"`), `replay dialog is missing the ${id} field`);
  }
  assert.match(script, /body\.userId = userId/, "replay must send the redefined user ID");
  assert.match(script, /body\.folderId = folderId/, "replay must send the redefined folder ID");
});

/** A historical run's mode must never be used to promise what the next run will write. */
test("pre-run write warnings come from the server driver", () => {
  assert.match(script, /health: "\/api\/health"/, "the UI must know the health route");
  assert.match(script, /loadDriverMode\(\)/, "the UI must read the server driver mode at startup");
  assert.match(script, /modeCopy\(state\.driverMode\)/, "replay copy must describe the server driver");
  assert.doesNotMatch(script, /modeCopy\(state\.selectedRun\?\.mode\)/, "mode copy must not come from a run record");
  assert.doesNotMatch(script, /modeCopy\(run\.mode\)/, "mode copy must not come from a run record");
});

test("non-verified runs surface their recorded error", () => {
  assert.ok(markup.includes(`id="run-error-message"`), "detail view needs an error message element");
  assert.match(script, /run-error-message.*\n?.*run\.error\.message|run\.error\.message/, "the recorded error message must be rendered");
});
