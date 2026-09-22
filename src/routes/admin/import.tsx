import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileUp,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  commitCatalogImport,
  previewCatalogImport,
} from "@/lib/catalog-import.functions";

export const Route = createFileRoute("/admin/import")({
  component: Page,
});

type CsvRow = Record<string, unknown>;

type PreviewRow = CsvRow & {
  rowNumber: number;
  sku: string;
  title: string;
  errors: string[];
  warnings: string[];
};

type PreviewResult = {
  importBatchId: string;
  filename: string;
  total: number;
  newCount: number;
  updateCount: number;
  duplicateCount: number;
  invalidCount: number;
  rows: PreviewRow[];
};

type CommitResult = {
  success: boolean;
  filename: string;
  total: number;
  created: number;
  updated: number;
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(text: string): CsvRow[] {
  const normalizedText = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const lines: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < normalizedText.length; i += 1) {
    const char = normalizedText[i];

    if (char === '"') {
      if (quoted && normalizedText[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }

      quoted = !quoted;
      current += char;
      continue;
    }

    if (char === "\n" && !quoted) {
      lines.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) lines.push(current);

  if (lines.length < 2) {
    throw new Error("CSV must contain a header row and at least one product row.");
  }

  const headerLine = lines[0];

  if (headerLine === undefined) {
    throw new Error("CSV header row is missing.");
  }

  const headers = parseCsvLine(headerLine).map((header) =>
    header.trim().replace(/^"|"$/g, ""),
  );

  if (!headers.some(Boolean)) {
    throw new Error("CSV header row is empty.");
  }

  return lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const values = parseCsvLine(line);

      return headers.reduce<Record<string, unknown>>((row, header, index) => {
        if (header) {
          row[header] = values[index] ?? "";
        }
        return row;
      }, {});
    });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message);
  }

  return "Something went wrong.";
}

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-emerald-600",
    warning: "text-amber-600",
    danger: "text-destructive",
  }[tone];

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </p>
        <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function Page() {
  const inputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);

  const [isParsing, setIsParsing] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);

  const [error, setError] = useState("");

  const hasValidRows = useMemo(
    () => Boolean(preview && preview.invalidCount === 0 && preview.total > 0),
    [preview],
  );

  function reset() {
    setFileName("");
    setRows([]);
    setPreview(null);
    setCommitResult(null);
    setError("");

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  async function handleFile(file: File) {
    reset();
    setIsParsing(true);

    try {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        throw new Error("Please upload a CSV file.");
      }

      if (file.size === 0) {
        throw new Error("The CSV file is empty.");
      }

      const text = await file.text();
      const parsed = parseCsv(text);

      setFileName(file.name);
      setRows(parsed);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setIsParsing(false);
    }
  }

  async function runPreview() {
    if (!rows.length || !fileName) return;

    setError("");
    setCommitResult(null);
    setIsPreviewing(true);

    try {
      const result = await previewCatalogImport({
        data: {
          filename: fileName,
          rows,
        },
      });

      setPreview(result as PreviewResult);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setIsPreviewing(false);
    }
  }

  async function runCommit() {
    if (!preview || preview.invalidCount > 0) return;

    setError("");
    setIsCommitting(true);

    try {
      const result = await commitCatalogImport({
        data: {
          filename: fileName,
          rows,
          importBatchId: preview.importBatchId,
        },
      });

      setCommitResult(result as CommitResult);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setIsCommitting(false);
    }
  }

  const invalidRows =
    preview?.rows.filter((row) => row.errors.length > 0) ?? [];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            <h1 className="text-2xl font-semibold tracking-tight">
              Catalog Import
            </h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Import Amazon and Flipkart catalog data into Nexus using SKU as the
            primary product identity.
          </p>
        </div>

        {(fileName || preview || commitResult) && (
          <Button variant="outline" onClick={reset} disabled={isPreviewing || isCommitting}>
            Start over
          </Button>
        )}
      </header>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">Import error</p>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {commitResult && (
        <Card className="border-emerald-500/30">
          <CardContent className="flex items-start gap-3 p-5">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <p className="font-medium">Catalog import completed</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {commitResult.total} rows processed — {commitResult.created} new
                products and {commitResult.updated} updated products.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Upload CSV</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-dashed border-border bg-secondary/30 p-8 text-center">
            <FileUp className="mx-auto h-8 w-8 text-muted-foreground" />

            <p className="mt-3 font-medium">
              {fileName || "Choose an Amazon / Flipkart CSV"}
            </p>

            <p className="mt-1 text-sm text-muted-foreground">
              SKU, product title and selling price are required.
            </p>

            <Input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="mx-auto mt-5 max-w-md cursor-pointer bg-background"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
              disabled={isParsing || isPreviewing || isCommitting}
            />
          </div>

          {rows.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border bg-background p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium">{fileName}</p>
                <p className="text-sm text-muted-foreground">
                  {rows.length} data row{rows.length === 1 ? "" : "s"} loaded.
                </p>
              </div>

              <Button
                onClick={() => void runPreview()}
                disabled={isParsing || isPreviewing || isCommitting}
              >
                {isPreviewing && <Loader2 className="animate-spin" />}
                {isPreviewing ? "Running preview…" : "Preview Import"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {preview && (
        <>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">2. Preview / Dry Run</h2>
                <p className="text-sm text-muted-foreground">
                  No products or inventory are changed during preview.
                </p>
              </div>

              <Badge variant={preview.invalidCount === 0 ? "default" : "destructive"}>
                {preview.invalidCount === 0 ? "Ready to commit" : "Fix errors first"}
              </Badge>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="Total rows" value={preview.total} />
              <StatCard label="New" value={preview.newCount} tone="success" />
              <StatCard label="Updates" value={preview.updateCount} />
              <StatCard
                label="Duplicates"
                value={preview.duplicateCount}
                tone={preview.duplicateCount ? "warning" : "default"}
              />
              <StatCard
                label="Invalid"
                value={preview.invalidCount}
                tone={preview.invalidCount ? "danger" : "default"}
              />
            </div>
          </div>

          {invalidRows.length > 0 && (
            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <XCircle className="h-4 w-4 text-destructive" />
                  Validation errors
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {invalidRows.slice(0, 100).map((row) => (
                  <div
                    key={`${row.rowNumber}-${row.sku}`}
                    className="rounded-md border border-destructive/20 bg-destructive/5 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">Row {row.rowNumber}</Badge>
                      {row.sku && <Badge variant="outline">{row.sku}</Badge>}
                      {row.title && (
                        <span className="text-sm font-medium">{row.title}</span>
                      )}
                    </div>

                    <ul className="mt-2 space-y-1 text-sm text-destructive">
                      {row.errors.map((message) => (
                        <li key={message}>• {message}</li>
                      ))}
                    </ul>
                  </div>
                ))}

                {invalidRows.length > 100 && (
                  <p className="text-xs text-muted-foreground">
                    Showing the first 100 invalid rows.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Preview rows</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="whitespace-nowrap p-3">Row</th>
                      <th className="whitespace-nowrap p-3">SKU</th>
                      <th className="whitespace-nowrap p-3">Title</th>
                      <th className="whitespace-nowrap p-3">Status</th>
                      <th className="whitespace-nowrap p-3">Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((row) => (
                      <tr
                        key={`${row.rowNumber}-${row.sku}`}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="whitespace-nowrap p-3">{row.rowNumber}</td>
                        <td className="whitespace-nowrap p-3 font-mono text-xs">
                          {row.sku || "—"}
                        </td>
                        <td className="min-w-[260px] p-3">{row.title || "—"}</td>
                        <td className="whitespace-nowrap p-3">
                          {row.errors.length > 0 ? (
                            <Badge variant="destructive">Invalid</Badge>
                          ) : (
                            <Badge variant="default">Valid</Badge>
                          )}
                        </td>
                        <td className="max-w-[420px] p-3">
                          {row.errors.length > 0 ? (
                            <span className="text-destructive">
                              {row.errors.join(" · ")}
                            </span>
                          ) : row.warnings.length > 0 ? (
                            <span className="text-amber-600">
                              {row.warnings.join(" · ")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.rows.length > 200 && (
                <p className="border-t border-border p-3 text-xs text-muted-foreground">
                  Showing the first 200 preview rows.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">3. Commit to Nexus</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium">
                  {hasValidRows
                    ? "Preview passed. The catalog is ready to import."
                    : "Commit is locked until all rows pass validation."}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Existing products are matched by SKU. Inventory reserved/sold
                  quantities are preserved during updates.
                </p>
              </div>

              <Button
                onClick={() => void runCommit()}
                disabled={!hasValidRows || isCommitting || isPreviewing}
                size="lg"
              >
                {isCommitting && <Loader2 className="animate-spin" />}
                {isCommitting ? "Committing…" : "Commit Import"}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
