/**
 * FAULT INJECTION — deliberately red (issue #27, step 5).
 *
 * A gate nobody has watched fail is a gate nobody should trust. This file
 * exists for exactly one push: verify.yml must go red on it, the run URL is
 * recorded on the issue, and the file is removed in the next commit.
 *
 * If you are reading this on main, the restore commit was lost. Delete it.
 */

import { expect, test } from "bun:test";

test("FAULT INJECTION: verify.yml must report this run as red", () => {
  expect(1).toBe(2);
});
