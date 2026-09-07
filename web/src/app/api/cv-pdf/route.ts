import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { cloudDataEnabled, getCloudDocument, listCloudDocumentPaths } from "@/lib/cloud-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serve the tailored CV PDF the pdf mode wrote to output/cv-…-{company}-…pdf for
// a given offer (matched by company slug, newest first). Inline so it opens in
// the browser. Local-first: reads the user's own output/ dir; cloud deployments
// serve the imported, immutable Neon snapshot instead.
export async function GET(req: NextRequest) {
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  if (!company) return new Response("company required", { status: 400 });

  // Token extraction keeps the lookup bounded and produces only [a-z0-9-].
  const slug = (company.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
  if (!slug) return new Response("company required", { status: 400 });

  // Match the slug at a token boundary (delimited by non-alphanumerics) so
  // "Meta" does not serve "Metabase"'s tailored CV.
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

    let row;
    try {
      row = await getCloudDocument(documentRef.path);
    } catch {
      return new Response("cloud document store unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (!row) return new Response("no tailored CV found for this offer", { status: 404 });

    if (row.content_encoding !== "base64") {
      return new Response("stored PDF encoding is unsupported", { status: 500, headers: { "Cache-Control": "no-store" } });
    }

    const buf = Buffer.from(row.content, "base64");
    if (Number.isFinite(row.byte_size) && row.byte_size > 0 && buf.byteLength !== row.byte_size) {
      return new Response("stored PDF is incomplete", { status: 500, headers: { "Cache-Control": "no-store" } });
    }

    const filename = path.basename(row.path).replace(/["\r\n]/g, "_");
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"" + filename + "\"",
        "Cache-Control": "no-store",
        "X-Career-Ops-Source": "neon",
      },
    });
  }

  const dir = path.join(careerOpsRoot(), "output");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .filter((f) => re.test(f.toLowerCase()));
  } catch {
    return new Response("no output directory", { status: 404 });
  }
  if (!files.length) return new Response("no tailored CV found for this offer", { status: 404 });

  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  const file = path.join(dir, files[0]);
  try {
    const buf = fs.readFileSync(file);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"" + files[0].replace(/["\r\n]/g, "_") + "\"",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
