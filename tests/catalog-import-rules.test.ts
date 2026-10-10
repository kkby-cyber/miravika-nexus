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

describe("image URL validation", () => {
  it("accepts https image links and de-duplicates them", () => {
    const url = "https://cdn.example.com/products/MIR-EAR-001-1.jpg";
    const row = normalizeRow(flipkartRow({ "Image URLs": `${url}|${url}` }), 2);
    expect(row.errors).toEqual([]);
    expect(row.image_urls).toEqual([url]);
    expect(row.warnings.join(" ")).not.toMatch(/draft/);
  });

  it("rejects insecure, relative or malformed image links", () => {
    for (const bad of ["http://cdn.example.com/a.jpg", "/images/a.jpg", "not a url"]) {
      const row = normalizeRow(flipkartRow({ "Image URLs": bad }), 2);
      expect(row.errors.join(" ")).toMatch(/valid https/);
    }
  });
});

describe("catalog import template", () => {
  it("every template column maps to the intended importer field", async () => {
    const { readFileSync } = await import("node:fs");
    const header = readFileSync("docs/catalog-import-template.csv", "utf8").trim().split(",");
    const sample: Record<string, string> = {
      "Seller SKU Id": "SKU-X",
      "Product Title": "Miravika Template Check",
      Brand: "MIRAVIKA",
      Category: "earring",
      "Your Selling Price": "199",
      MRP: "499",
      "Your Stock Count": "7",
      "Image URLs": "https://cdn.example.com/a.jpg|https://cdn.example.com/b.jpg",
      Description: "Desc",
      Color: "Gold",
      Size: "Free",
      Material: "Alloy",
      HSN: "71179090",
      GST: "3",
      "Weight (g)": "20",
      Length: "8",
      Width: "8",
      Height: "3",
    };
    expect(header).toEqual(Object.keys(sample));
    const row = normalizeRow(sample, 2);
    expect(row.errors).toEqual([]);
    expect(row).toMatchObject({
      sku: "SKU-X",
      title: "Miravika Template Check",
      brand: "MIRAVIKA",
      price: 199,
      mrp: 499,
      stock: 7,
      image_urls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
      description: "Desc",
      color: "Gold",
      size: "Free",
      material: "Alloy",
      hsn_code: "71179090",
      tax_rate: 3,
      weight_grams: 20,
      length_cm: 8,
      width_cm: 8,
      height_cm: 3,
    });
    expect(row.collections).toContain("jewelry-accessories");
  });
});
