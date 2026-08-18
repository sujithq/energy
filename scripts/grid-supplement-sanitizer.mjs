import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(new URL("./build-grid-supplement.mjs", import.meta.url));

export async function sanitizeGridExport(input, destination) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [generatorPath, input, destination], {
      stdio: "ignore"
    });
    child.once("error", () => reject(sanitizerError()));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(sanitizerError());
    });
  });
}

function sanitizerError() {
  const error = new Error("The Fluvius CSV could not be sanitized.");
  error.code = "SANITIZER_FAILED";
  return error;
}