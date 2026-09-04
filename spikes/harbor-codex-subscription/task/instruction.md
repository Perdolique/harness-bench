Use `$spike-canary` before making changes.

Update `normalizeRoomLabel(value)` so it still trims leading and trailing
whitespace and lowercases the result, and also replaces every internal run of
ECMAScript whitespace with one hyphen. Whitespace-only input must still return an
empty string, and all non-whitespace characters must otherwise be preserved.

Run the existing tests before and after the change. Modify only
`src/normalize-room-label.mjs` and, if useful, `test/regression.test.mjs`.
