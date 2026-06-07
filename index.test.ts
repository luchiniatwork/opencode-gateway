import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "./index.ts";

test("serve --config fails before startup when config is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-"));
  const configPath = join(dir, "config.jsonc");
  const errors: string[] = [];
  const originalError = console.error;

  await writeFile(configPath, "{}", "utf8");

  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  try {
    const exitCode = await main(["serve", "--config", configPath]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid config");
  } finally {
    console.error = originalError;
    await rm(dir, { recursive: true, force: true });
  }
});

test("serve rejects missing config path", async () => {
  const errors: string[] = [];
  const originalError = console.error;

  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  try {
    const exitCode = await main(["serve", "--config"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--config requires a path");
  } finally {
    console.error = originalError;
  }
});
