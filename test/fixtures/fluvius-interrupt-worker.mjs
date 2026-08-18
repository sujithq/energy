import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createFluviusRuntimeCleanup,
  installFluviusInterruptHandlers
} from "../../scripts/fluvius-runtime-cleanup.mjs";

const [, , temporaryRoot] = process.argv;
const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, "fluvius-sync-"));
const browserClosedPath = path.join(temporaryRoot, "browser-closed");
await writeFile(path.join(temporaryDirectory, "raw-export.csv"), "private interval data");

let keepAlive;
const runtimeCleanup = createFluviusRuntimeCleanup();
runtimeCleanup.setTemporaryDirectory(temporaryDirectory);
runtimeCleanup.setBrowser({
  close: () => writeFile(browserClosedPath, "closed")
});
installFluviusInterruptHandlers(runtimeCleanup, {
  onCleanupComplete: () => clearInterval(keepAlive)
});

keepAlive = setInterval(() => {}, 1_000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split(/\r?\n/)) {
    if (line === "interrupt") process.emit("SIGTERM");
  }
});
process.stdin.resume();
console.log("ready");