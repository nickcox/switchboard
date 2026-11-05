import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { cliInProcess } from "./cli-in-process.ts";

// Read the actual acceptance table, not another hand-maintained command list.
// Fail explicitly if its shape changes rather than silently testing an empty set.
async function acceptanceTable(group: string): Promise<ts.ObjectLiteralExpression> {
  const path = `src/${group}s/cli.ts`;
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  const tables: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "allowed") {
      assert.ok(node.initializer && ts.isObjectLiteralExpression(node.initializer), `${path}: expected an allowed object`);
      tables.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(tables.length, 1, `${path}: expected one acceptance table`);
  assert.ok(tables[0]!.properties.length > 0);
  return tables[0]!;
}

function commandName(property: ts.ObjectLiteralElementLike): string {
  assert.ok(ts.isPropertyAssignment(property));
  assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name));
  return property.name.text;
}

function listedCommands(help: string, group: string): string[] {
  const match = help.match(new RegExp(`switchboard ${group} <([^>]+)>`));
  assert.ok(match, `Missing ${group} command list`);
  return match[1]!.split("|").sort();
}

function options(text: string): string[] {
  return [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])].sort();
}

async function help(...args: string[]): Promise<string> {
  // Help must work without reading configuration or opening storage.
  const result = await cliInProcess([...args, "--help", "--config", "missing-help-config.json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage:/);
  return result.stderr;
}

test("top-level and group help list every accepted task and objective subcommand", async () => {
  const topLevel = await help();
  for (const group of ["task", "objective"]) {
    const accepted = (await acceptanceTable(group)).properties.map(commandName).sort();
    assert.deepEqual(listedCommands(topLevel, group), accepted, `${group}: top-level help must match the acceptance table`);
    assert.deepEqual(listedCommands(await help(group), group), accepted, `${group}: group help must match the acceptance table`);
  }
});

test("task and task add help detail every accepted subcommand and its existing options", async () => {
  const taskHelp = await help("task");
  assert.equal(await help("task", "add"), taskHelp);
  assert.deepEqual(options(taskHelp.split("\n")[0]!), ["--config", "--help", "--json"]);

  for (const property of (await acceptanceTable("task")).properties) {
    const command = commandName(property);
    assert.ok(ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer));
    const accepted = property.initializer.elements.map(element => {
      assert.ok(ts.isStringLiteral(element), "Update this extractor if the acceptance table gains shared option arrays");
      return `--${element.text}`;
    }).sort();
    const lines = taskHelp.split("\n").filter(line => line.split(":")[0]!.split("/").includes(command));
    assert.ok(lines.some(line => line.startsWith(`${command}:`)), `Missing detailed help for ${command}`);
    assert.deepEqual(options(lines.join("\n")), accepted, `${command}: detailed help must match accepted options`);
  }

  for (const detail of [
    "add: <id> <title> (or --title <text>)",
    "--body <text> or --body-file <path>",
    "--criterion <text> (repeatable) or --criteria-file <path>",
    "--objective <id> or --clear-objective",
    "list: [--state queued|in_flight|done] [--repo <repo>]",
    "ready: [--repo <repo>]",
    "update: <id>", "show: <id>", "hold: <id> --reason <text>", "release: <id>",
    "block: <id> --by <task-id>", "unblock: <id> --by <task-id>",
    "done: <id> [--note <text>]", "reopen: <id>",
    "convert-criteria: convert legacy body criteria in the configured repo",
  ]) assert.ok(taskHelp.includes(detail), `Missing help detail: ${detail}`);
});
