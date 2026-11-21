// server.json (MCP Registry metadata) must stay in step with package.json: the registry checks that the npm package's
// mcpName equals server.json's name, and every publish needs a new, exact version. `npm version` keeps the versions in
// step through the "version" script; this test catches a hand edit that forgets one of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const server = read("server.json");

test("server.json name is package.json mcpName under the GitHub owner's namespace", () => {
  assert.equal(server.name, pkg.mcpName);
  const owner = new URL(server.repository.url).pathname.split("/")[1];
  assert.ok(server.name.startsWith(`io.github.${owner}/`), `${server.name} must start with io.github.${owner}/ (case-sensitive)`);
  assert.ok(pkg.repository.url.includes(server.repository.url.replace(/^https:\/\//, "")));
});

test("server.json versions and npm package match package.json", () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  const [npm] = server.packages;
  assert.equal(npm.registryType, "npm");
  assert.equal(npm.registryBaseUrl, "https://registry.npmjs.org");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.deepEqual(npm.transport, { type: "stdio" });
  assert.deepEqual(npm.packageArguments, [{ type: "positional", value: "serve" }]);
});

test("server.json text fits the registry limits", () => {
  assert.ok(server.description.length >= 1 && server.description.length <= 100, `description is ${server.description.length} chars`);
  assert.ok(server.title.length <= 100);
  for (const v of server.packages[0].environmentVariables) assert.equal(v.isRequired, false, `${v.name} must stay optional`);
});
