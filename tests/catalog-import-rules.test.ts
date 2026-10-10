import { describe, expect, it } from "vitest";
import {
  CATALOG_IMPORT_RULES_VERSION,
  mapMarketplaceCollections,
  normalizeRow,
  resolveBrand,
} from "@/lib/catalog-import-rules";

const flipkartRow = (overrides: Record<string, unknown> = {}) => ({
  "Seller SKU Id": "MIR-EAR-001",
  "Product Title": "Miravika Silver Huggie Hoop Earrings",
  "Your Selling Price": "230",
  MRP: "999",
  Category: "earring",
  ...overrides,
});

describe("catalog import brand gate", () => {
  it("accepts listings whose title names MIRAVIKA when no brand column exists", () => {
    const row = normalizeRow(flipkartRow(), 2);
    expect(row.errors).toEqual([]);
    expect(row.brand).toBe("MIRAVIKA");
  });

  it("rejects third-party listings instead of relabelling them as MIRAVIKA", () => {
    const row = normalizeRow(
      flipkartRow({ "Product Title": "Dazzle Beauty Makeup Superblender Sponge" }),
      3,
    );
    expect(row.errors.join(" ")).toMatch(/third-party/i);
  });

  it("rejects an explicit non-MIRAVIKA brand even if the title mentions MIRAVIKA", () => {
    const row = normalizeRow(flipkartRow({ Brand: "Shree Ju" }), 4);
    expect(row.errors.join(" ")).toMatch(/not MIRAVIKA/);
  });

  it("does not treat look-alike spellings as the brand", () => {
    expect(resolveBrand("", "Miravica Silver Multi Layer Hoop")).toBeNull();
    expect(resolveBrand("miravika", "Anything")).toBe("MIRAVIKA");
  });
});

describe("marketplace category mapping", () => {
  it("maps Flipkart category codes onto storefront collections", () => {
    expect(mapMarketplaceCollections(["earring"])).toEqual(["jewelry-accessories"]);
    expect(mapMarketplaceCollections(["hair_accessory"])).toEqual(["womens-fashion"]);
    expect(mapMarketplaceCollections(["rakhi_set"])).toEqual(["gifts"]);
    expect(mapMarketplaceCollections(["puff_sponge"])).toEqual(["beauty-personal-care"]);
    expect(mapMarketplaceCollections(["Necklace Chain"])).toEqual(["jewelry-accessories"]);
  });

  it("leaves unknown categories unmapped and warns", () => {
    const row = normalizeRow(flipkartRow({ Category: "kitchen_tool" }), 5);
    expect(row.collections).not.toContain("jewelry-accessories");
    expect(row.warnings.join(" ")).toMatch(/does not map/);
  });

  it("adds the mapped collection to the row", () => {
    expect(normalizeRow(flipkartRow(), 2).collections).toContain("jewelry-accessories");
  });
});

describe("incomplete listings", () => {
  it("warns that imageless products import as drafts and stockless ones cannot sell", () => {
    const row = normalizeRow(flipkartRow(), 2);
    expect(row.warnings.join(" ")).toMatch(/draft/);
    expect(row.warnings.join(" ")).toMatch(/cannot be sold/);
  });

  it("stamps rows with the current rules version for the commit-time check", () => {
    expect(normalizeRow(flipkartRow(), 2).rules_version).toBe(CATALOG_IMPORT_RULES_VERSION);
    expect(CATALOG_IMPORT_RULES_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("still rejects zero prices and prices above MRP", () => {
    expect(normalizeRow(flipkartRow({ "Your Selling Price": "0" }), 2).errors).toContain(
      "Selling price must be greater than 0",
    );
    expect(normalizeRow(flipkartRow({ "Your Selling Price": "1200" }), 2).errors).toContain(
      "Selling price cannot be greater than MRP",
    );
  });
});
