import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const TRANSIENT_REMOVAL_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const TEMPORARY_DATA_REMOVAL_RETRIES = 20;
const TEMPORARY_DATA_REMOVAL_RETRY_MS = 100;
const CHILD_STOP_GRACE_MS = 5_000;
const CHILD_FORCE_STOP_TIMEOUT_MS = 5_000;

export function createFluviusRuntimeCleanup({
  beforeTemporaryDataRemoval = async () => {},
  removeTemporaryDirectory = (directory) => rm(directory, { recursive: true, force: true }),
  temporaryDataRemovalRetries = TEMPORARY_DATA_REMOVAL_RETRIES,
  temporaryDataRemovalRetryMs = TEMPORARY_DATA_REMOVAL_RETRY_MS,
  onTemporaryProcessStopFailure = () => {},
  onBrowserCloseFailure = () => {},
  onTemporaryDataRemovalFailure = () => {}
} = {}) {
  let browser;
  let temporaryDirectory;
  let cleanupPromise;

  return {
    setBrowser(nextBrowser) {
      browser = nextBrowser;
    },
    setTemporaryDirectory(nextTemporaryDirectory) {
      temporaryDirectory = nextTemporaryDirectory;
    },
    async cleanup() {
      if (cleanupPromise) return cleanupPromise;

      const currentCleanup = cleanupRuntimeResources();
      cleanupPromise = currentCleanup;
      try {
        await currentCleanup;
      } finally {
        if (cleanupPromise === currentCleanup) cleanupPromise = undefined;
      }
    }
  };

  async function cleanupRuntimeResources() {
    try {
      await beforeTemporaryDataRemoval();
    } catch {
      onTemporaryProcessStopFailure();
    }

    const browserToClose = browser;
    if (browserToClose) {
      try {
        await browserToClose.close();
        if (browser === browserToClose) browser = undefined;
      } catch {
        try {
          if (typeof browserToClose.forceClose !== "function") {
            throw new Error("No browser force-close handler.");
          }
          await browserToClose.forceClose();
          if (browser === browserToClose) browser = undefined;
        } catch {
          onBrowserCloseFailure();
        }
      }
    }

    const directoryToRemove = temporaryDirectory;
    if (directoryToRemove) {
      try {
        await retryTransientRemoval(
          () => removeTemporaryDirectory(directoryToRemove),
          temporaryDataRemovalRetries,
          temporaryDataRemovalRetryMs
        );
        if (temporaryDirectory === directoryToRemove) temporaryDirectory = undefined;
      } catch {
        onTemporaryDataRemovalFailure();
      }
    }
  }
}

export async function stopChildProcess(child, {
  graceMs = CHILD_STOP_GRACE_MS,
  forceStopTimeoutMs = CHILD_FORCE_STOP_TIMEOUT_MS,
  signalProcessTree = signalChildProcessTree,
  forceTerminateProcessTree = forceTerminateChildProcessTree,
  waitForExit = waitForChildExit
} = {}) {
  if (!isChildRunning(child)) return;

  if (process.platform === "win32") {
    await forceTerminateProcessTree(child, forceStopTimeoutMs);
    if (!await waitForExit(child, forceStopTimeoutMs)) {
      throw new Error("Temporary Fluvius export process could not be stopped.");
    }
    return;
  }

  await signalProcessTree(child, "SIGTERM");
  if (await waitForExit(child, graceMs)) return;

  await forceTerminateProcessTree(child, forceStopTimeoutMs);
  if (!await waitForExit(child, forceStopTimeoutMs)) {
    throw new Error("Temporary Fluvius export process could not be stopped.");
  }
}

export function installFluviusInterruptHandlers(runtimeCleanup, { onCleanupComplete = () => {} } = {}) {
  let interruptionSignal;
  const abortController = new AbortController();
  const handlers = new Map();

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (interruptionSignal) return;

      interruptionSignal = signal;
      abortController.abort(new Error("Fluvius refresh was interrupted."));
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      void runtimeCleanup.cleanup().finally(() => {
        try {
          onCleanupComplete();
        } catch {
          // Signal handlers must not turn a cleanup failure into an unhandled rejection.
        }
      });
    };
    process.on(signal, handler);
    handlers.set(signal, handler);
  }

  return {
    get signal() {
      return abortController.signal;
    },
    get interrupted() {
      return Boolean(interruptionSignal);
    },
    throwIfInterrupted() {
      if (interruptionSignal) throw new Error("Fluvius refresh was interrupted.");
    },
    dispose() {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  };
}

async function retryTransientRemoval(operation, retries, retryMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_REMOVAL_ERRORS.has(error?.code) || attempt >= retries) throw error;
      await delay(retryMs);
    }
  }
}

async function signalChildProcessTree(child, signal) {
  if (!child?.pid) return;

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function forceTerminateChildProcessTree(child, timeoutMs) {
  if (!child?.pid) return;

  if (process.platform !== "win32") {
    await signalChildProcessTree(child, "SIGKILL");
    return;
  }

  await runTaskKill(child.pid, timeoutMs);
}

async function runTaskKill(pid, timeoutMs) {
  await new Promise((resolve) => {
    const taskKill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      taskKill.kill();
      finish();
    }, timeoutMs);
    taskKill.once("error", finish);
    taskKill.once("exit", () => {
      finish();
    });
  });
}

async function waitForChildExit(child, timeoutMs) {
  if (!isChildRunning(child)) return true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onExit);
    if (!isChildRunning(child)) finish(true);
  });
}

function isChildRunning(child) {
  return Boolean(child) && child.exitCode == null && child.signalCode == null;
}