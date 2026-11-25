import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { InvoiceParseError, parseInvoicePdf } from "./invoice-parser.mjs";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const artifactsDirectory = join(extensionDirectory, "artifacts");
const invoicesDirectory = join(artifactsDirectory, "invoices");
const statePath = join(artifactsDirectory, "ledger.json");
const rendererPath = join(extensionDirectory, "renderer.html");
const maxUploadBytes = 30 * 1024 * 1024;
const servers = new Map();
let copilotSession;

await mkdir(invoicesDirectory, { recursive: true });
try {
    await stat(statePath);
} catch {
    await writeFile(
        statePath,
        `${JSON.stringify({ version: 1, updatedAt: null, invoices: [] }, null, 2)}\n`,
        "utf8",
    );
}

async function loadState() {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return {
        version: 1,
        updatedAt: parsed.updatedAt ?? null,
        invoices: Array.isArray(parsed.invoices) ? parsed.invoices : [],
    };
}

async function saveState(state) {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await writeFile(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(`${statePath}.tmp`, statePath);
    return next;
}

function sendJson(response, status, value) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
}

async function readBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxUploadBytes) {
            throw new Error("Upload is groter dan 30 MB.");
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function parseMultipart(body, boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    const parts = [];
    let cursor = 0;

    while (cursor < body.length) {
        const start = body.indexOf(delimiter, cursor);
        if (start < 0) break;
        let contentStart = start + delimiter.length;
        if (body.subarray(contentStart, contentStart + 2).toString() === "--") break;
        if (body.subarray(contentStart, contentStart + 2).toString() === "\r\n") {
            contentStart += 2;
        }
        const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), contentStart);
        const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4);
        if (headerEnd < 0 || nextBoundary < 0) break;

        const headers = body.subarray(contentStart, headerEnd).toString("utf8");
        const filenameMatch = headers.match(/filename="([^"]+)"/i);
        const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        if (filenameMatch) {
            parts.push({
                filename: filenameMatch[1].split(/[\\/]/).at(-1),
                contentType: contentTypeMatch?.[1]?.trim() ?? "",
                data: body.subarray(headerEnd + 4, nextBoundary),
            });
        }
        cursor = nextBoundary + 2;
    }

    return parts;
}

function safeInvoiceNumber(value) {
    return /^BE\d+$/.test(String(value));
}

async function importUploads(request) {
    const contentType = request.headers["content-type"] ?? "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
        throw new Error("Upload gebruikt geen multipart/form-data.");
    }

    const files = parseMultipart(
        await readBody(request),
        boundaryMatch[1] ?? boundaryMatch[2],
    ).filter((part) => part.filename);
    if (files.length === 0) {
        throw new Error("Geen PDF-bestanden ontvangen.");
    }

    const state = await loadState();
    const imported = [];
    const errors = [];

    for (const [index, file] of files.entries()) {
        const temporaryPath = join(
            invoicesDirectory,
            `.upload-${Date.now()}-${index}-${process.pid}.pdf`,
        );
        try {
            if (!/\.pdf$/i.test(file.filename)) {
                throw new InvoiceParseError("Alleen PDF-bestanden worden ondersteund.");
            }
            if (!file.data.subarray(0, 4).equals(Buffer.from("%PDF"))) {
                throw new InvoiceParseError("Bestand heeft geen geldige PDF-header.");
            }
            await writeFile(temporaryPath, file.data);
            const parsed = await parseInvoicePdf(temporaryPath, file.filename);
            const existingIndex = state.invoices.findIndex(
                (invoice) => invoice.invoiceNumber === parsed.invoiceNumber,
            );
            const finalPath = join(invoicesDirectory, `${parsed.invoiceNumber}.pdf`);
            await rm(finalPath, { force: true });
            await rename(temporaryPath, finalPath);

            const record = {
                ...parsed,
                storedFilename: `${parsed.invoiceNumber}.pdf`,
                uploadedAt: new Date().toISOString(),
            };
            if (existingIndex >= 0) {
                state.invoices[existingIndex] = record;
            } else {
                state.invoices.push(record);
            }
            imported.push({
                invoiceNumber: record.invoiceNumber,
                action: existingIndex >= 0 ? "updated" : "added",
            });
        } catch (error) {
            await rm(temporaryPath, { force: true });
            errors.push({
                filename: file.filename,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    state.invoices.sort((left, right) =>
        left.invoiceDate.localeCompare(right.invoiceDate),
    );
    const saved = imported.length > 0 ? await saveState(state) : state;
    return { imported, errors, state: saved };
}

async function handleRequest(request, response) {
    try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/") {
            const html = await readFile(rendererPath, "utf8");
            response.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            });
            response.end(html);
            return;
        }
        if (request.method === "GET" && url.pathname === "/api/state") {
            sendJson(response, 200, await loadState());
            return;
        }
        if (request.method === "POST" && url.pathname === "/api/invoices") {
            sendJson(response, 200, await importUploads(request));
            return;
        }
        if (request.method === "POST" && url.pathname === "/api/delete") {
            const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
            if (!safeInvoiceNumber(body.invoiceNumber)) {
                sendJson(response, 400, { error: "Ongeldig factuurnummer." });
                return;
            }
            const state = await loadState();
            state.invoices = state.invoices.filter(
                (invoice) => invoice.invoiceNumber !== body.invoiceNumber,
            );
            await rm(join(invoicesDirectory, `${body.invoiceNumber}.pdf`), { force: true });
            sendJson(response, 200, { state: await saveState(state) });
            return;
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/invoices/")) {
            const invoiceNumber = decodeURIComponent(
                url.pathname.slice("/api/invoices/".length).replace(/\/pdf$/, ""),
            );
            if (!safeInvoiceNumber(invoiceNumber)) {
                sendJson(response, 400, { error: "Ongeldig factuurnummer." });
                return;
            }
            const pdf = await readFile(join(invoicesDirectory, `${invoiceNumber}.pdf`));
            response.writeHead(200, {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${invoiceNumber}.pdf"`,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            });
            response.end(pdf);
            return;
        }
        sendJson(response, 404, { error: "Niet gevonden." });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 500, { error: message });
        if (copilotSession) {
            await copilotSession.log(message, { level: "error", ephemeral: true });
        }
    }
}

async function startServer(instanceId) {
    const server = createServer((request, response) => {
        void handleRequest(request, response);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

copilotSession = await joinSession({
    canvases: [
        createCanvas({
            id: "energy-invoice-dashboard",
            displayName: "Energy invoice dashboard",
            description:
                "Upload Frank Energie invoices and explore electricity and gas by year or compare months.",
            actions: [
                {
                    name: "get_summary",
                    description: "Return the current invoice ledger summary.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            year: { type: "integer", description: "Optional calendar year." },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const state = await loadState();
                        const invoices = ctx.input?.year
                            ? state.invoices.filter(
                                  (invoice) =>
                                      invoice.invoiceDate.startsWith(`${ctx.input.year}-`) ||
                                      invoice.settlement?.month.startsWith(
                                          `${ctx.input.year}-`,
                                      ) ||
                                      invoice.advance?.month.startsWith(`${ctx.input.year}-`),
                              )
                            : state.invoices;
                        return {
                            invoiceCount: invoices.length,
                            invoiceYears: [
                                ...new Set(
                                    state.invoices
                                        .flatMap((invoice) => [
                                            invoice.invoiceDate.slice(0, 4),
                                            invoice.settlement?.month.slice(0, 4),
                                            invoice.advance?.month.slice(0, 4),
                                        ])
                                        .filter(Boolean),
                                ),
                            ].sort(),
                            updatedAt: state.updatedAt,
                            totalInvoiceAmount: roundSummary(
                                invoices.reduce(
                                    (sum, invoice) => sum + invoice.invoiceTotal,
                                    0,
                                ),
                            ),
                            totalElectricityKwh: roundSummary(
                                invoices.reduce(
                                    (sum, invoice) =>
                                        sum + (invoice.settlement?.electricity.kwh ?? 0),
                                    0,
                                ),
                            ),
                            totalGasKwh: roundSummary(
                                invoices.reduce(
                                    (sum, invoice) =>
                                        sum + (invoice.settlement?.gas.kwh ?? 0),
                                    0,
                                ),
                            ),
                        };
                    },
                },
                {
                    name: "list_invoices",
                    description: "List imported invoice metadata without exposing PDF contents.",
                    handler: async () => (await loadState()).invoices,
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: "Energy invoice dashboard",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

function roundSummary(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}
