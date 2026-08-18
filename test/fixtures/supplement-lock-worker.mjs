import process from "node:process";
import { createInterface } from "node:readline";

import { withSupplementLock } from "../../scripts/grid-supplement-publication.mjs";

const [, , destination, mode] = process.argv;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();

process.stdout.write("ready\n");
await lines.next();
process.stdout.write("locking\n");
await withSupplementLock(destination, async () => {
  process.stdout.write("entered\n");
  if (mode === "hold") await lines.next();
});
input.close();
process.stdout.write("released\n");