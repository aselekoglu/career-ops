import { neon } from "@neondatabase/serverless";

type DocumentRow = { path: string; content: string; content_encoding: string; byte_size: number; sha256: string };

let client: ReturnType<typeof neon> | null | undefined;
const cache = new Map<string, DocumentRow | null>();

export function cloudDataEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function getClient() {
  if (client !== undefined) return client;
  const url = process.env.DATABASE_URL?.trim();
  client = url ? neon(url) : null;
  return client;
}

export async function getCloudDocument(relativePath: string): Promise<DocumentRow | null> {
  const key = relativePath.replaceAll("\\", "/");
  if (cache.has(key)) return cache.get(key) ?? null;
  const sql = getClient();
  if (!sql) return null;
  const rows = await sql`
    SELECT path, content, content_encoding, byte_size, sha256
    FROM career_ops_documents
    WHERE path = ${key}
    LIMIT 1
  `;
  const row = (Array.from(rows as unknown as Array<unknown>)[0] as DocumentRow | undefined) ?? null;
  cache.set(key, row);
  return row;
}

export function clearCloudDocumentCache() {
  cache.clear();
}
