import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { cloudDataEnabled, getCloudDocument, listCloudDocumentPaths } from "@/lib/cloud-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validArtifact(value: string): boolean {
  return /^output\/[A-Za-z0-9._-]+\.pdf$/.test(value);
}

function pdfResponse(buf: Buffer, filename: string, source?: string) {
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="' + filename.replace(/["\r\n]/g, "_") + '"',
      "Cache-Control": "no-store",
      ...(source ? { "X-Career-Ops-Source": source } : {}),
    },
  });
}

async function cloudPdf(documentPath: string) {
  let row;
  try {
    row = await getCloudDocument(documentPath);
  } catch {
    return new Response("cloud document store unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!row) return new Response("no tailored CV found", { status: 404 });
  if (row.content_encoding !== "base64") {
    return new Response("stored PDF encoding is unsupported", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  const buf = Buffer.from(row.content, "base64");
  if (Number.isFinite(row.byte_size) && row.byte_size > 0 && buf.byteLength !== row.byte_size) {
    return new Response("stored PDF is incomplete", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  if (buf.byteLength < 4 || buf.subarray(0, 4).toString("ascii") !== "%PDF") {
    return new Response("stored PDF is invalid", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return pdfResponse(buf, path.basename(row.path), "neon");
}

// Serve either one exact durable CV artifact (preferred for MCP/worker runs) or,
// for backwards compatibility, the newest CV whose filename matches a company.
export async function GET(req: NextRequest) {
  const artifact = (req.nextUrl.searchParams.get("artifact") ?? "").trim();
  if (artifact) {
    if (!validArtifact(artifact)) return new Response("invalid artifact", { status: 400 });
    if (cloudDataEnabled()) return cloudPdf(artifact);

    const root = careerOpsRoot();
    const file = path.resolve(root, artifact);
    const outputRoot = path.resolve(root, "output") + path.sep;
    if (!file.startsWith(outputRoot)) return new Response("invalid artifact", { status: 400 });
    try {
      return pdfResponse(fs.readFileSync(file), path.basename(file));
    } catch {
      return new Response("no tailored CV found", { status: 404 });
    }
  }

  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  if (!company) return new Response("company or artifact required", { status: 400 });

  const slug = (company.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
  if (!slug) return new Response("company required", { status: 400 });
  const re = new RegExp("(^|[^a-z0-9])" + slug + "([^a-z0-9]|$)", "i");

  if (cloudDataEnabled()) {
    let documentRef;
    try {
      const documentRefs = await listCloudDocumentPaths("output/");
      documentRef = documentRefs.find((document) => {
        const filename = path.basename(document.path);
        return filename.toLowerCase().endsWith(".pdf") && re.test(filename.toLowerCase());
      });
    } catch {
      return new Response("cloud document store unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (!documentRef) return new Response("no tailored CV found for this offer", { status: 404 });
    return cloudPdf(documentRef.path);
  }

  const dir = path.join(careerOpsRoot(), "output");
  let files: string[];
  try {
    files = fs.readdirSync(dir)
      .filter((file) => file.toLowerCase().endsWith(".pdf"))
      .filter((file) => re.test(file.toLowerCase()));
  } catch {
    return new Response("no output directory", { status: 404 });
  }
  if (!files.length) return new Response("no tailored CV found for this offer", { status: 404 });

  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  const file = path.join(dir, files[0]);
  try {
    return pdfResponse(fs.readFileSync(file), files[0]);
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
