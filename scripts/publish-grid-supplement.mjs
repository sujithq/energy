import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { publishManualSupplement } from "./grid-supplement-publication.mjs";
import { sanitizeGridExport } from "./grid-supplement-sanitizer.mjs";

const [, , inputArgument, outputArgument = "data/grid-supplement.json"] = process.argv;
if (!inputArgument) {
  console.error("Usage: node scripts/publish-grid-supplement.mjs <fluvius.csv> [output.json]");
  process.exit(1);
}

const inputPath = path.resolve(inputArgument);
const outputPath = path.resolve(outputArgument);
let temporaryDirectory;

try {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fluvius-publish-"));
  const candidatePath = path.join(temporaryDirectory, "grid-supplement.json");
  await sanitizeGridExport(inputPath, candidatePath);
  const result = await publishManualSupplement(candidatePath, outputPath);
  if (!result.published) {
    console.error(
      `Grid supplement not published: ${result.missingDays} missing and `
      + `${result.changedDays} changed published day(s).`
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Grid supplement refreshed: ${result.completeDays} complete days through ${result.through}.`
    );
  }
} catch {
  console.error("Grid supplement refresh failed; no published data was changed.");
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {
      console.error("Temporary sanitized data could not be removed.");
      process.exitCode = 1;
    });
  }
}