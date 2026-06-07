import { chmod, rm } from "node:fs/promises";

const distDir = "dist";
const packageEntrypoint = `${distDir}/index.js`;
const binaryEntrypoint = `${distDir}/opencode-gateway`;
const shebang = "#!/usr/bin/env bun";

type BuildMode = "package" | "binary" | "all";

const mode = parseMode(Bun.argv.slice(2));

await rm(distDir, { force: true, recursive: true });

if (mode === "package" || mode === "all") {
  await buildPackageEntrypoint();
}

if (mode === "binary" || mode === "all") {
  await buildStandaloneBinary();
}

function parseMode(args: string[]): BuildMode {
  if (args.length === 0) {
    return "package";
  }

  if (args.length === 1 && args[0] === "--binary") {
    return "binary";
  }

  if (args.length === 1 && args[0] === "--all") {
    return "all";
  }

  console.error("Usage: bun run scripts/build.ts [--binary | --all]");
  process.exit(1);
}

async function buildPackageEntrypoint(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./index.ts"],
    format: "esm",
    outdir: distDir,
    target: "bun",
  });

  assertBuildSuccess(result, "package CLI");

  const output = await Bun.file(packageEntrypoint).text();
  const executableOutput = output.startsWith(shebang) ? output : `${shebang}\n${output}`;

  await Bun.write(packageEntrypoint, executableOutput);
  await chmod(packageEntrypoint, 0o755);

  console.log(`Built package CLI: ${packageEntrypoint}`);
}

async function buildStandaloneBinary(): Promise<void> {
  const process = Bun.spawn({
    cmd: ["bun", "build", "--compile", "./index.ts", "--outfile", binaryEntrypoint],
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (stdout.trim()) {
    console.log(stdout.trim());
  }

  if (exitCode !== 0) {
    if (stderr.trim()) {
      console.error(stderr.trim());
    }

    throw new Error(`Failed to build standalone binary: bun build exited with ${exitCode}`);
  }

  if (stderr.trim()) {
    console.error(stderr.trim());
  }

  await chmod(binaryEntrypoint, 0o755);

  console.log(`Built standalone binary: ${binaryEntrypoint}`);
}

function assertBuildSuccess(result: Bun.BuildOutput, label: string): void {
  if (result.success) {
    return;
  }

  for (const log of result.logs) {
    console.error(log.message);
  }

  throw new Error(`Failed to build ${label}`);
}
