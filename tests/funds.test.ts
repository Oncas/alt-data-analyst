import { describe, expect, it } from "vitest";
import { mapInfoTable, pickRecent13F } from "../src/fetchers/edgar13f.js";
import {
  bigNewPositionSignals,
  crossSourcePositionSignals,
  diffPositions,
  type HoldingLike,
} from "../src/screen/funds.js";

const infoTableXml = `<?xml version="1.0"?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>NVIDIA CORP</nameOfIssuer>
    <cusip>67066G104</cusip>
    <value>500000000</value>
    <shrsOrPrnAmt><sshPrnamt>4000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
  </infoTable>
  <infoTable>
    <nameOfIssuer>NVIDIA CORP</nameOfIssuer>
    <cusip>67066G104</cusip>
    <value>100000000</value>
    <shrsOrPrnAmt><sshPrnamt>800000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
  </infoTable>
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <cusip>037833100</cusip>
    <value>250000000</value>
    <shrsOrPrnAmt><sshPrnamt>1200000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
  </infoTable>
</informationTable>`;

const fund = { name: "Test Fund", cik: "123" };

describe("mapInfoTable", () => {
  it("parses holdings and aggregates duplicate CUSIPs", () => {
    const rows = mapInfoTable(infoTableXml, fund, "2026-03-31");
    expect(rows).toHaveLength(2);
    const nvda = rows.find((row) => row.cusip === "67066G104");
    expect(nvda).toMatchObject({ issuer: "NVIDIA CORP", valueUsd: 600_000_000, shares: 4_800_000 });
  });

  it("returns [] for junk XML", () => {
    expect(mapInfoTable("<<<not xml", fund, "2026-03-31")).toEqual([]);
  });

  it("scales thousands-filed values to dollars (implied-price heuristic)", () => {
    const entry = (cusip: string, valueThousands: number, shares: number) => `
      <infoTable>
        <nameOfIssuer>ISSUER ${cusip}</nameOfIssuer>
        <cusip>${cusip}</cusip>
        <value>${valueThousands}</value>
        <shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt></shrsOrPrnAmt>
      </infoTable>`;
    // Values in thousands: implied prices are pennies across the book.
    const thousandsXml = `<informationTable>${entry("AAA111", 157_150, 13_397_247)}${entry("BBB222", 136_305, 9_259_844)}${entry("CCC333", 597_208, 8_080_112)}</informationTable>`;
    const rows = mapInfoTable(thousandsXml, fund, "2026-03-31");
    expect(rows.find((row) => row.cusip === "AAA111")?.valueUsd).toBe(157_150_000);
    // Dollar-filed values (implied price ~$125-208/share) stay untouched.
    const dollarRows = mapInfoTable(infoTableXml, fund, "2026-03-31");
    expect(dollarRows.find((row) => row.cusip === "67066G104")?.valueUsd).toBe(600_000_000);
  });
});

describe("pickRecent13F", () => {
  it("takes the most recent 13F-HR filings only", () => {
    const filings = pickRecent13F(
      {
        form: ["4", "13F-HR", "13F-HR/A", "13F-HR", "13F-HR"],
        accessionNumber: ["a", "b", "c", "d", "e"],
        reportDate: ["x", "2026-03-31", "2025-12-31", "2025-12-31", "2025-09-30"],
      },
      2,
    );
    expect(filings).toEqual([
      { accession: "b", period: "2026-03-31" },
      { accession: "d", period: "2025-12-31" },
    ]);
  });
});

function holding(overrides: Partial<HoldingLike>): HoldingLike {
  return {
    fund: "Test Fund",
    cik: "123",
    period: "2026-03-31",
    issuer: "NVIDIA CORP",
    cusip: "67066G104",
    valueUsd: 600_000_000,
    shares: 4_800_000,
    ...overrides,
  };
}

describe("diffPositions", () => {
  it("detects new positions and >=1.5x increases, ignores steady holds", () => {
    const latest = [
      holding({}),
      holding({ cusip: "NEW111", issuer: "FRESH CO", valueUsd: 300_000_000, shares: 1000 }),
      holding({ cusip: "FLAT22", issuer: "FLAT CO", shares: 1000 }),
    ];
    const prior = [
      holding({ period: "2025-12-31", shares: 3_000_000 }),
      holding({ period: "2025-12-31", cusip: "FLAT22", issuer: "FLAT CO", shares: 900 }),
    ];
    const changes = diffPositions(latest, prior);
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.cusip === "NEW111")?.change).toBe("new");
    const grown = changes.find((c) => c.cusip === "67066G104");
    expect(grown?.change).toBe("increase");
    expect(grown?.ratio).toBe(1.6);
  });
});

describe("signal rules", () => {
  const newBig = {
    fund: "Test Fund", cik: "123", period: "2026-03-31", issuer: "FRESH CO",
    cusip: "NEW111", valueUsd: 300_000_000, change: "new" as const, ratio: null,
  };

  it("bigNewPositionSignals: floor and $1B severity tier", () => {
    const signals = bigNewPositionSignals(
      [newBig, { ...newBig, cusip: "SMALL1", valueUsd: 50_000_000 },
        { ...newBig, cusip: "HUGE01", valueUsd: 1_500_000_000 }],
      250_000_000,
    );
    expect(signals).toHaveLength(2);
    expect(signals[1]?.severity).toBe(3);
  });

  it("crossSourcePositionSignals joins on normalized issuer name", () => {
    const signals = crossSourcePositionSignals(
      [newBig],
      [{ source: "usaspending", rule: "contracts.mega-award", company: "FRESH CO INC", ticker: null }],
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.evidence).toMatchObject({ otherRule: "contracts.mega-award", change: "new" });
  });
});
