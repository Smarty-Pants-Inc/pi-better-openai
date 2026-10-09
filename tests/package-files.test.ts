import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

// Typed decisions are disabled in this fork (smarty-dev#7484): the unregistered module must not
// ship in the package, so no consumer can import it and re-register the tool or command.
describe("published package", () => {
  test("does not ship the disabled decisions module", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files).toContain("index.ts");
    expect(files.some((path) => path.startsWith("src/"))).toBe(true);
    expect(files.filter((path) => /decisions/i.test(path))).toEqual([]);
  }, 60_000);
});
