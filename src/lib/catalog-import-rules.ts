/**
 * Pure, side-effect-free validation rules for the Amazon / Flipkart catalogue importer.
 * Kept separate from the server module so they can be unit-tested without a database.
 */

/** Bump when validation changes so stale previews must be regenerated before commit. */
export const CATALOG_IMPORT_RULES_VERSION = 2;

export const STORE_BRAND = "MIRAVIKA";

/**
 * Marketplace category codes → canonical Nexus collection slugs. Only categories the owner
 * actually sells are listed; anything else is left uncollected and flagged in the preview.
 */
export const MARKETPLACE_CATEGORY_COLLECTIONS: Record<string, string> = {
  earring: "jewelry-accessories",
  earrings: "jewelry-accessories",
  necklace_chain: "jewelry-accessories",
  necklace: "jewelry-accessories",
  hair_accessory: "womens-fashion",
  hair_accessories: "womens-fashion",
  rakhi_set: "gifts",
  rakhi: "gifts",
  puff_sponge: "beauty-personal-care",
  makeup_sponge: "beauty-personal-care",
};

function categoryKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function mapMarketplaceCollections(values: string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const slug = MARKETPLACE_CATEGORY_COLLECTIONS[categoryKey(value)];
    if (slug) out.add(slug);
  }
  return [...out];
}

/**
 * Returns the canonical brand when the row is a MIRAVIKA product, else null.
 * An explicit brand column must say MIRAVIKA; without one, the listing title must.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname.includes("."));
  } catch {
    return false;
  }
}

export function resolveBrand(brand: string, title: string): string | null {
  if (brand) return brand.trim().toUpperCase() === STORE_BRAND ? STORE_BRAND : null;
  return /\bmiravika\b/i.test(title) ? STORE_BRAND : null;
}

export type RawRow = Record<string, unknown>;

export type ImportRow = {
  sku: string;
  title: string;
  description: string | null;
  short_description: string | null;
  brand: string;
  product_type: string | null;
  material: string | null;
  size: string | null;
  color: string | null;
  mrp: number | null;
  price: number;
  compare_at_price: number | null;
  tax_rate: number | null;
  tax_inclusive: boolean;
  hsn_code: string | null;
  weight_grams: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  stock: number | null;
  image_urls: string[];
  collections: string[];
  seo_title: string | null;
  seo_description: string | null;
  seo_keywords: string | null;
  is_featured: boolean;
  is_bestseller: boolean;
  is_trending: boolean;
  is_visible: boolean;
};

export type NormalizedRow = ImportRow & {
  rowNumber: number;
  /** Rule set the row was validated with; commit refuses rows from older rule sets. */
  rules_version: number;
  errors: string[];
  warnings: string[];
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nullable(value: unknown): string | null {
  const valueText = text(value);
  return valueText ? valueText : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function kilogramsToGrams(value: unknown): number | null {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;

  return parsed * 1000;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value === "boolean") return value;

  const normalized = text(value).toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  return fallback;
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean);
  }

  const valueText = text(value);
  if (!valueText) return [];

  return valueText
    .split(/[|,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "product";
}

function normalizeHeaderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function firstValue(raw: RawRow, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  const normalizedRaw = new Map<string, unknown>();

  for (const [rawKey, value] of Object.entries(raw)) {
    const normalizedKey = normalizeHeaderKey(rawKey);

    if (normalizedKey && value !== undefined && value !== null && String(value).trim() !== "") {
      normalizedRaw.set(normalizedKey, value);
    }
  }

  for (const key of keys) {
    const value = normalizedRaw.get(normalizeHeaderKey(key));

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return undefined;
}

export function normalizeRow(raw: RawRow, rowNumber: number): NormalizedRow {
  const sku = text(
    firstValue(raw, [
      "sku",
      "SKU",
      "Seller SKU",
      "SellerSKU",
      "Seller SKU Id",
      "SellerSKUId",
      "Style Code",
      "StyleCode",
    ]),
  );

  const title = text(
    firstValue(raw, [
      "title",
      "Title",
      "Product Name",
      "ProductName",
      "Product Title",
      "name",
      "Name",
    ]),
  );

  const price = numberOrNull(
    firstValue(raw, [
      "price",
      "Price",
      "Selling Price",
      "SellingPrice",
      "Meesho Price",
      "Flipkart Selling Price",
      "Your Selling Price",
      "YourSellingPrice",
    ]),
  );

  const row: ImportRow = {
    sku,
    title,
    description: nullable(firstValue(raw, ["description", "Description", "Product Description"])),
    short_description: nullable(firstValue(raw, ["short_description", "Short Description"])),
    // Never assume the brand: a missing brand column is resolved from the listing title below.
    brand: nullable(firstValue(raw, ["brand", "Brand"])) ?? "",
    product_type: nullable(
      firstValue(raw, [
        "product_type",
        "Product Type",
        "Type",
        "Category",
        "Sub-category",
        "Sub Category",
      ]),
    ),
    material: nullable(firstValue(raw, ["material", "Material"])),
    size: nullable(firstValue(raw, ["size", "Size"])),
    color: nullable(firstValue(raw, ["color", "Color"])),
    mrp: numberOrNull(firstValue(raw, ["mrp", "MRP", "MRP Price", "MRP Price in INR"])),
    price: price ?? 0,
    compare_at_price: numberOrNull(
      firstValue(raw, ["compare_at_price", "Compare At Price", "Compare Price"]),
    ),
    tax_rate: numberOrNull(firstValue(raw, ["tax_rate", "Tax Rate", "GST", "gst", "GST Rate"])),
    tax_inclusive: booleanOrDefault(firstValue(raw, ["tax_inclusive", "Tax Inclusive"]), true),
    hsn_code: nullable(
      firstValue(raw, ["hsn_code", "HSN", "HSN Code", "Harmonized System Nomenclature - HSN"]),
    ),
    weight_grams: (() => {
      const explicitGrams = firstValue(raw, [
        "weight_grams",
        "Weight Grams",
        "Weight (g)",
        "Net Weight (g)",
      ]);

      if (
        explicitGrams !== undefined &&
        explicitGrams !== null &&
        String(explicitGrams).trim() !== ""
      ) {
        return numberOrNull(explicitGrams);
      }

      return kilogramsToGrams(
        firstValue(raw, [
          "Package Weight",
          "Package Weight - Weight of the package in Kgs",
          "Weight (Kg)",
          "Weight (Kgs)",
        ]),
      );
    })(),
    length_cm: numberOrNull(
      firstValue(raw, [
        "length_cm",
        "Length",
        "Package Length",
        "Package Length - Length of the package in cms",
      ]),
    ),
    width_cm: numberOrNull(
      firstValue(raw, [
        "width_cm",
        "Width",
        "Package Breadth",
        "Package Breadth - Breadth of the package in cms",
      ]),
    ),
    height_cm: numberOrNull(
      firstValue(raw, [
        "height_cm",
        "Height",
        "Package Height",
        "Package Height - Height of the package in cms",
      ]),
    ),
    stock: numberOrNull(
      firstValue(raw, [
        "stock",
        "Stock",
        "Inventory",
        "Available Quantity",
        "Quantity",
        "Your Stock Count",
        "YourStockCount",
      ]),
    ),
    image_urls: parseList(
      firstValue(raw, ["image_urls", "Images", "Image URLs", "Image URL", "Images URLs"]),
    ),
    collections: parseList(
      firstValue(raw, ["collections", "Collections", "Category", "Sub-category", "Sub Category"]),
    ),
    seo_title: nullable(firstValue(raw, ["seo_title", "SEO Title"])),
    seo_description: nullable(firstValue(raw, ["seo_description", "SEO Description"])),
    seo_keywords: nullable(firstValue(raw, ["seo_keywords", "SEO Keywords"])),
    is_featured: booleanOrDefault(firstValue(raw, ["is_featured", "Featured"]), false),
    is_bestseller: booleanOrDefault(
      firstValue(raw, ["is_bestseller", "Bestseller", "Best Seller"]),
      false,
    ),
    is_trending: booleanOrDefault(firstValue(raw, ["is_trending", "Trending"]), false),
    is_visible: booleanOrDefault(firstValue(raw, ["is_visible", "Visible"]), true),
  };

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!row.sku) errors.push("SKU is required");
  if (!row.title) errors.push("Product title is required");
  if (row.price <= 0) errors.push("Selling price must be greater than 0");

  if (row.mrp !== null && row.mrp < 0) {
    errors.push("MRP cannot be negative");
  }

  if (row.mrp !== null && row.price > row.mrp) {
    errors.push("Selling price cannot be greater than MRP");
  }

  if (row.tax_rate !== null && (row.tax_rate < 0 || row.tax_rate > 100)) {
    errors.push("GST/tax rate must be between 0 and 100");
  }

  if (row.stock !== null && (!Number.isInteger(row.stock) || row.stock < 0)) {
    errors.push("Stock must be a non-negative integer");
  }

  if (row.weight_grams !== null && row.weight_grams < 0) {
    errors.push("Weight cannot be negative");
  }

  // Marketplace-only catalogue: only the owner's MIRAVIKA listings may enter the store.
  // Seller accounts can also carry third-party listings (other brands, CJ/dropship items);
  // those are rejected rather than silently relabelled as MIRAVIKA.
  if (row.title) {
    const resolvedBrand = resolveBrand(row.brand, row.title);
    if (resolvedBrand) {
      row.brand = resolvedBrand;
    } else {
      errors.push(
        row.brand
          ? `Brand "${row.brand}" is not MIRAVIKA; only MIRAVIKA products can be imported`
          : "Listing title does not name MIRAVIKA; third-party products cannot be imported",
      );
    }
  }

  // Map marketplace category codes (e.g. Flipkart "earring") onto storefront collections.
  const mapped = mapMarketplaceCollections([...row.collections, row.product_type ?? ""]);
  row.collections = [...new Set([...mapped, ...row.collections])];
  if (!mapped.length && row.sku) {
    warnings.push("Category does not map to a storefront collection");
  }

  // Images are shown to shoppers as-is: reject anything that is not a well-formed https URL
  // rather than storing a link that renders as a broken image.
  row.image_urls = [...new Set(row.image_urls)];
  for (const url of row.image_urls) {
    if (!isHttpsUrl(url))
      errors.push(`Image URL must be a valid https:// link: ${url.slice(0, 80)}`);
  }
  if (!row.image_urls.length) {
    warnings.push("No product images supplied — the product will be imported as a draft");
  }
  if (row.stock === null) {
    warnings.push("No stock quantity supplied — the product cannot be sold until stock is set");
  }

  return {
    ...row,
    rowNumber,
    rules_version: CATALOG_IMPORT_RULES_VERSION,
    errors,
    warnings,
  };
}
