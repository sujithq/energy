import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DATE_PATTERN = "(\\d{1,2}\\/\\d{1,2}\\/\\d{4})";
const MONEY_PATTERN = "-?\\d[\\d.]*,\\d{2}";
const COST_CATEGORIES = {
    Administratiekosten: "fixed",
    Energiekosten: "energy",
    "Certificaatkosten hernieuwbare energie": "energy",
    "Transport en distributie": "network",
    "Heffingen en toeslagen": "taxes",
};

export class InvoiceParseError extends Error {}

function parseBelgianNumber(value) {
    const normalized = String(value)
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
        throw new InvoiceParseError(`Kon bedrag '${value}' niet lezen.`);
    }
    return parsed;
}

function parseQuantity(value) {
    const parsed = parseBelgianNumber(String(value).replace(/[^\d.,-]/g, ""));
    return Math.abs(parsed);
}

function isoDate(value) {
    const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) {
        throw new InvoiceParseError(`Kon datum '${value}' niet lezen.`);
    }
    const [, day, month, year] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function monthKeyFromDate(value) {
    return isoDate(value).slice(0, 7);
}

function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function amountsFromLine(line) {
    return [...line.matchAll(new RegExp(MONEY_PATTERN, "g"))].map((match) => match[0]);
}

function parsePeriodLine(lines, label) {
    const line = lines.find((candidate) => candidate.includes(label));
    if (!line) {
        throw new InvoiceParseError(`Veld ontbreekt: ${label}`);
    }

    const dates = line.match(new RegExp(`${DATE_PATTERN}\\s+tot\\s+${DATE_PATTERN}`, "i"));
    const amounts = amountsFromLine(line);
    if (!dates || amounts.length === 0) {
        throw new InvoiceParseError(`Kon periode of bedrag niet lezen in: ${line}`);
    }

    return {
        start: isoDate(dates[1]),
        end: isoDate(dates[2]),
        month: monthKeyFromDate(dates[1]),
        amount: parseBelgianNumber(amounts.at(-1)),
    };
}

function parseOptionalPeriodLine(lines, label) {
    return lines.some((line) => line.includes(label))
        ? parsePeriodLine(lines, label)
        : null;
}

function findRequiredMatch(text, expression, fieldName) {
    const match = text.match(expression);
    if (!match) {
        throw new InvoiceParseError(`Veld ontbreekt: ${fieldName}`);
    }
    return match;
}

function parseActualCosts(text) {
    const matches = [
        ...text.matchAll(/Totaal werkelijke kosten \(incl\. BTW\)\s+(-?\d[\d.]*,\d{2})/gi),
    ];
    if (matches.length < 2) {
        throw new InvoiceParseError("Werkelijke kosten voor elektriciteit en gas niet gevonden.");
    }
    return {
        electricity: parseBelgianNumber(matches[0][1]),
        gas: parseBelgianNumber(matches[1][1]),
    };
}

function parseCostBreakdown(text, actual) {
    const breakdown = {
        electricity: { fixed: 0, energy: 0, network: 0, taxes: 0 },
        gas: { fixed: 0, energy: 0, network: 0, taxes: 0 },
    };
    let product = null;
    let category = null;

    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.replace(/\s+/g, " ").trim();
        if (/^Elektriciteit \(EAN:/.test(line)) {
            product = "electricity";
            category = null;
            continue;
        }
        if (/^Aardgas \(EAN:/.test(line)) {
            product = "gas";
            category = null;
            continue;
        }
        if (COST_CATEGORIES[line]) {
            category = COST_CATEGORIES[line];
            continue;
        }
        if (/^Totaal werkelijke kosten \(incl\. BTW\)/i.test(line)) {
            category = null;
            continue;
        }
        if (!product || !category || !/\s\d+%$/.test(line)) continue;

        const amounts = amountsFromLine(line);
        if (amounts.length > 0) {
            breakdown[product][category] += parseBelgianNumber(amounts.at(-1));
        }
    }

    for (const productName of ["electricity", "gas"]) {
        const productBreakdown = breakdown[productName];
        for (const categoryName of Object.keys(productBreakdown)) {
            productBreakdown[categoryName] = roundMoney(productBreakdown[categoryName]);
        }
        const total = roundMoney(
            Object.values(productBreakdown).reduce((sum, value) => sum + value, 0),
        );
        const expected = actual[productName];
        if (Math.abs(total - expected) > 0.01) {
            throw new InvoiceParseError(
                `Kostenopbouw voor ${productName} sluit niet aan: ${total} versus ${expected}.`,
            );
        }
    }

    return breakdown;
}

function parseUsage(text) {
    const electricity = text.match(
        /Elektriciteit alle uren\s+\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\s+(\d[\d.]*)\s*kWh/i,
    );
    const injection = text.match(
        /Injectie beperkte vermarkting Total\s+\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\s+(-?\d[\d.]*)\s*kWh\s+(-?\d[\d.]*,\d+)\s+c\/kWh\s+(-?\d[\d.]*,\d{2})\s+\d+%/i,
    );
    const gas = text.match(
        /(?:^|\n)Aardgas\s+\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\s+(\d[\d.]*)\s*kWh/i,
    );

    return {
        electricityKwh: electricity ? parseQuantity(electricity[1]) : null,
        injectionKwh: injection ? parseQuantity(injection[1]) : null,
        injectionRateEurKwh: injection
            ? Math.round((parseBelgianNumber(injection[2]) / 100) * 1_000_000) / 1_000_000
            : null,
        injectionCharge: injection ? roundMoney(parseBelgianNumber(injection[3])) : null,
        gasKwh: gas ? parseQuantity(gas[1]) : null,
    };
}

function parsePeakCapacity(text, settlementMonth) {
    const peak = String(text).match(
        /Maandpiek\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d[\d.]*,\d{2})\s+kW\s+x\s+(\d+)\s+dagen\s+(\d[\d.]*,\d{2})\s+\/kW\/jaar\s+(-?\d[\d.]*,\d{2})\s+\d+%/i,
    );
    if (!peak) {
        throw new InvoiceParseError("Maandpiek voor elektriciteit niet gevonden.");
    }

    const month = monthKeyFromDate(peak[1]);
    if (month !== settlementMonth) {
        throw new InvoiceParseError(
            `Maandpiek ${month} wijkt af van afrekeningsmaand ${settlementMonth}.`,
        );
    }

    const correction = String(text).match(
        /Toepassing maximumtarief\s+\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\s+1\s+-?\d[\d.]*,\d{2}\s+(-?\d[\d.]*,\d{2})\s+\d+%/i,
    );
    const grossCharge = parseBelgianNumber(peak[6]);
    const adjustment = correction ? parseBelgianNumber(correction[1]) : 0;

    return {
        start: isoDate(peak[1]),
        end: isoDate(peak[2]),
        month,
        peakKw: parseBelgianNumber(peak[3]),
        days: Number(peak[4]),
        annualRate: parseBelgianNumber(peak[5]),
        grossCharge: roundMoney(grossCharge),
        adjustment: roundMoney(adjustment),
        charge: roundMoney(grossCharge + adjustment),
    };
}

function parseBonuses(lines) {
    return lines
        .filter((line) => /^(Injectiebonus|Bonus)\b/i.test(line))
        .map((line) => {
            const amounts = amountsFromLine(line);
            return amounts.length > 0
                ? { label: line.replace(/\s+-?[\d.]+,\d{2}(?:\s+-?[\d.]+,\d{2}){0,3}\s*$/, "").trim(), amount: parseBelgianNumber(amounts.at(-1)) }
                : null;
        })
        .filter(Boolean);
}

function parseInvoiceTotal(firstPage, fallback) {
    const vatBlock = firstPage.match(/BTW berekening([\s\S]*?)Notabedrag/i);
    if (vatBlock) {
        const amounts = [...vatBlock[1].matchAll(new RegExp(MONEY_PATTERN, "g"))];
        if (amounts.length > 0) {
            return parseBelgianNumber(amounts.at(-1)[0]);
        }
    }
    return roundMoney(fallback);
}

export function parseInvoiceText(text, originalFilename = "") {
    const normalized = String(text).replace(/\f/g, "\n");
    const firstPage = normalized.split(/Pagina 1\s*\/\s*\d+/i)[0];
    const lines = firstPage
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);

    const invoiceType = /Afrekeningsfactuur/i.test(normalized)
        ? "settlement"
        : /Voorschotfactuur/i.test(normalized)
          ? "advance"
          : null;
    if (!/Frank Energie/i.test(normalized) || !invoiceType) {
        throw new InvoiceParseError(
            "Dit lijkt geen Frank Energie-afrekenings- of voorschotfactuur.",
        );
    }

    const header = findRequiredMatch(
        normalized,
        /Factuurnummer:\s*Datum:\s*Klantnummer:\s*(BE\d+)\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
        "Factuurnummer en factuurdatum",
    );
    const invoiceNumber = header[1];
    const invoiceDateText = header[2];

    const electricityIndex = lines.findIndex((line) => /^Elektriciteit \(EAN:/i.test(line));
    const gasIndex = lines.findIndex((line) => /^Aardgas \(EAN:/i.test(line));
    if (electricityIndex < 0 || gasIndex <= electricityIndex) {
        throw new InvoiceParseError("Overzicht voor elektriciteit en gas niet gevonden.");
    }

    const electricityLines = lines.slice(electricityIndex, gasIndex);
    const gasLines = lines.slice(gasIndex);
    const electricitySettlement = parseOptionalPeriodLine(
        electricityLines,
        "Afrekening voor de periode van",
    );
    const electricityAdvance = parsePeriodLine(
        electricityLines,
        "Voorschot voor de periode van",
    );
    const gasSettlement = parseOptionalPeriodLine(
        gasLines,
        "Afrekening voor de periode van",
    );
    const gasAdvance = parsePeriodLine(gasLines, "Voorschot voor de periode van");

    if ((electricitySettlement == null) !== (gasSettlement == null)) {
        throw new InvoiceParseError(
            "Afrekeningsperiode ontbreekt voor elektriciteit of gas.",
        );
    }
    if (invoiceType === "settlement" && !electricitySettlement) {
        throw new InvoiceParseError("Afrekeningsperiode ontbreekt op de factuur.");
    }
    if (invoiceType === "advance" && electricitySettlement) {
        throw new InvoiceParseError(
            "Voorschotfactuur bevat onverwacht een afrekeningsperiode.",
        );
    }
    if (
        (electricitySettlement &&
            electricitySettlement.month !== gasSettlement.month) ||
        electricityAdvance.month !== gasAdvance.month
    ) {
        throw new InvoiceParseError("Elektriciteit en gas hebben verschillende factuurperiodes.");
    }

    const actual = electricitySettlement ? parseActualCosts(normalized) : null;
    const costBreakdown = electricitySettlement
        ? parseCostBreakdown(normalized, actual)
        : null;
    const peakCapacity = electricitySettlement
        ? parsePeakCapacity(normalized, electricitySettlement.month)
        : null;
    const usage = electricitySettlement
        ? parseUsage(normalized)
        : {
              electricityKwh: null,
              injectionKwh: null,
              injectionRateEurKwh: null,
              injectionCharge: null,
              gasKwh: null,
          };
    const bonuses = parseBonuses(lines);
    const fallbackTotal =
        (electricitySettlement?.amount ?? 0) +
        electricityAdvance.amount +
        (gasSettlement?.amount ?? 0) +
        gasAdvance.amount +
        bonuses.reduce((sum, bonus) => sum + bonus.amount, 0);

    return {
        invoiceNumber,
        invoiceType,
        invoiceDate: isoDate(invoiceDateText),
        invoiceMonth: monthKeyFromDate(invoiceDateText),
        originalFilename,
        invoiceTotal: roundMoney(parseInvoiceTotal(firstPage, fallbackTotal)),
        settlement: electricitySettlement
            ? {
                  start: electricitySettlement.start,
                  end: electricitySettlement.end,
                  month: electricitySettlement.month,
                  electricity: {
                      amount: roundMoney(electricitySettlement.amount),
                      actual: roundMoney(actual.electricity),
                      kwh: usage.electricityKwh,
                      injectionKwh: usage.injectionKwh,
                      injectionRateEurKwh: usage.injectionRateEurKwh,
                      injectionCharge: usage.injectionCharge,
                      breakdown: costBreakdown.electricity,
                      capacity: peakCapacity,
                  },
                  gas: {
                      amount: roundMoney(gasSettlement.amount),
                      actual: roundMoney(actual.gas),
                      kwh: usage.gasKwh,
                      breakdown: costBreakdown.gas,
                  },
              }
            : null,
        advance: {
            start: electricityAdvance.start,
            end: electricityAdvance.end,
            month: electricityAdvance.month,
            electricity: roundMoney(electricityAdvance.amount),
            gas: roundMoney(gasAdvance.amount),
        },
        bonuses: bonuses.map((bonus) => ({ ...bonus, amount: roundMoney(bonus.amount) })),
    };
}

export async function parseInvoicePdf(pdfPath, originalFilename = "") {
    let stdout;
    try {
        const result = await execFileAsync("pdftotext", ["-raw", pdfPath, "-"], {
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
        });
        stdout = result.stdout;
    } catch (error) {
        const missing = error?.code === "ENOENT";
        throw new InvoiceParseError(
            missing
                ? "PDF-lezer 'pdftotext' is niet beschikbaar op deze computer."
                : `PDF kon niet worden gelezen: ${error?.stderr || error?.message || String(error)}`,
        );
    }
    return parseInvoiceText(stdout, originalFilename);
}
