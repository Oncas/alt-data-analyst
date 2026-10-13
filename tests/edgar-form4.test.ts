import { describe, expect, it } from "vitest";
import {
  archiveUrlFor,
  mapForm4,
  type EftsHit,
} from "../src/fetchers/edgarForm4.js";

const form4Xml = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>aapl</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>Chief Financial Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-07-15</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>212.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-07-15</value></transactionDate>
      <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

describe("mapForm4", () => {
  it("extracts P/S transactions with issuer, insider, and computed value", () => {
    const rows = mapForm4(form4Xml, "0001-26-000001", "2026-07-16");
    expect(rows).toHaveLength(1); // the A-code grant is filtered out
    expect(rows[0]).toMatchObject({
      accession: "0001-26-000001",
      ticker: "AAPL",
      issuerName: "Apple Inc.",
      insiderName: "DOE JANE",
      insiderRole: "Chief Financial Officer, Director",
      transactionCode: "P",
      shares: 1000,
      price: 212.5,
      value: 212_500,
      filedAt: "2026-07-16",
    });
  });

  it("keeps txnIndex stable relative to the filing, not the kept subset", () => {
    const swapped = form4Xml
      .replace("<transactionCode>P</transactionCode>", "<transactionCode>X</transactionCode>")
      .replace("<transactionCode>A</transactionCode>", "<transactionCode>S</transactionCode>");
    const rows = mapForm4(swapped, "acc", null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transactionCode).toBe("S");
    expect(rows[0]?.txnIndex).toBe(1);
  });

  it("returns [] for junk or transaction-free XML", () => {
    expect(mapForm4("not xml at all <<<", "acc", null)).toEqual([]);
    expect(mapForm4("<ownershipDocument><issuer/></ownershipDocument>", "acc", null)).toEqual([]);
  });

  it("handles missing price (value stays null)", () => {
    const noPrice = form4Xml.replace(
      "<transactionPricePerShare><value>212.50</value></transactionPricePerShare>",
      "",
    );
    const rows = mapForm4(noPrice, "acc", null);
    expect(rows[0]?.price).toBeNull();
    expect(rows[0]?.value).toBeNull();
  });
});

describe("archiveUrlFor", () => {
  it("builds the Archives URL from accession, cik, and filename", () => {
    const hit: EftsHit = {
      _id: "0001234567-26-000123:form4.xml",
      _source: { ciks: ["0000320193"], file_date: "2026-07-16" },
    };
    expect(archiveUrlFor(hit)).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000123456726000123/form4.xml",
    );
  });

  it("returns null when parts are missing", () => {
    expect(archiveUrlFor({ _id: "no-filename", _source: { ciks: ["1"] } })).toBeNull();
    expect(archiveUrlFor({ _id: "a:b.xml", _source: {} })).toBeNull();
  });
});
