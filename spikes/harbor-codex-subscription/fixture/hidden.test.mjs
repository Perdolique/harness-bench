import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = process.env.SPIKE_WORKSPACE;
if (!workspace) {
  throw new Error("SPIKE_WORKSPACE is required");
}

const moduleUrl = pathToFileURL(
  `${workspace}/src/normalize-room-label.mjs`,
).href;
const { normalizeRoomLabel } = await import(moduleUrl);

test("collapses internal ECMAScript whitespace", () => {
  const whitespaceCharacters = [
    "\u0009",
    "\u000a",
    "\u000b",
    "\u000c",
    "\u000d",
    "\u0020",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u2001",
    "\u2002",
    "\u2003",
    "\u2004",
    "\u2005",
    "\u2006",
    "\u2007",
    "\u2008",
    "\u2009",
    "\u200a",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
    "\ufeff",
  ];

  for (const whitespace of whitespaceCharacters) {
    assert.equal(normalizeRoomLabel(`A${whitespace}${whitespace}B`), "a-b");
  }
  assert.equal(normalizeRoomLabel(whitespaceCharacters.join("")), "");
  assert.equal(normalizeRoomLabel("  A_./🍎B  "), "a_./🍎b");
});
