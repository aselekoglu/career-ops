function canon(url) {
  try {
    const parsed = new URL(url);
    return (parsed.host + parsed.pathname).toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

/** Read only the two Neon snapshots the local Explore URL deduper already uses. */
export async function readHostedExploreKnownUrls(getDocument) {
  const [history, pipeline] = await Promise.all([
    getDocument("data/scan-history.tsv"),
    getDocument("data/pipeline.md"),
  ]);
  const urls = new Set();
  if (history?.content_encoding === "utf8") {
    for (const line of history.content.split("\n").slice(1)) {
      const url = line.split("\t")[0]?.trim();
      if (url && /^https?:\/\//i.test(url)) urls.add(canon(url));
    }
  }
  if (pipeline?.content_encoding === "utf8") {
    for (const line of pipeline.content.split("\n")) {
      const match = line.match(/^\s*-\s*\[[ xX]\]\s*(https?:\/\/\S+)/i);
      if (match) urls.add(canon(match[1]));
    }
  }
  return [...urls];
}
