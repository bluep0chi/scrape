const https = require("node:https");
const zlib = require("node:zlib");
const { writeFile, readFile, unlink } = require("node:fs/promises");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 6,
});

function decompress(buffer, encoding) {
  switch (String(encoding ?? "").toLowerCase()) {
    case "gzip":
      return zlib.gunzipSync(buffer);
    case "deflate":
      return zlib.inflateSync(buffer);
    case "br":
      return zlib.brotliDecompressSync(buffer);
    default:
      return buffer;
  }
}

const DNS_SERVERS = [
  { host: "1.1.1.1", path: "/dns-query" },
  { host: "8.8.8.8", path: "/resolve" },
];
const dnsCache = new Map();
let useDoh = false;

function resolveDoh(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.address);
  const tryServer = (index) => {
    if (index >= DNS_SERVERS.length) {
      return Promise.reject(new Error(`gagal resolve ${hostname}`));
    }
    const server = DNS_SERVERS[index];
    const options = {
      host: server.host,
      path: `${server.path}?name=${encodeURIComponent(hostname)}&type=A`,
      headers: { accept: "application/dns-json" },
      timeout: 5000,
    };
    return new Promise((resolve, reject) => {
      const req = https.get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const body = JSON.parse(data);
            const answer = (body.Answer || []).find((r) => r.type === 1);
            if (!answer) return reject(new Error("no A record"));
            dnsCache.set(hostname, { address: answer.data, expiresAt: Date.now() + 60_000 });
            resolve(answer.data);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", () => tryServer(index + 1).then(resolve, reject));
      req.on("timeout", () => {
        req.destroy();
        tryServer(index + 1).then(resolve, reject);
      });
    });
  };
  return tryServer(0);
}

function certError(err) {
  const msg = String(err?.message || err?.code || "");
  return /CERT|TLS|SSL/i.test(msg) || err?.code === "ERR_TLS_CERT_ALTNAME_INVALID" || err?.cause?.code === "CERT_HAS_EXPIRED";
}

function requestOnce(target, { method, headers, body, timeoutMs }) {
  const doRequest = (ip) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: ip || target.hostname,
          port: target.port ? Number(target.port) : 443,
          path: `${target.pathname}${target.search}`,
          method,
          headers: { ...headers, host: target.hostname },
          agent,
          servername: target.hostname,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            try {
              const raw = decompress(
                Buffer.concat(chunks),
                res.headers["content-encoding"],
              );
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body: raw.toString("utf8"),
              });
            } catch (err) {
              reject(err);
            }
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout ${timeoutMs}ms: ${target.href}`));
      });
      req.on("error", reject);
      if (body != null) req.write(body);
      req.end();
    });
  return doRequest().catch((err) => {
    if (certError(err)) {
      useDoh = true;
      return resolveDoh(target.hostname).then(doRequest);
    }
    throw err;
  });
}

async function request(url, options = {}) {
  const {
    method = "GET",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 3,
    backoffMs = 2_000,
    headers: extraHeaders = {},
    body,
  } = options;

  const headers = {
    "user-agent": USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "br, gzip, deflate",
    ...extraHeaders,
  };
  if (body != null && !("content-length" in headers) && !("Content-Length" in headers)) {
    headers["content-length"] = Buffer.byteLength(body);
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let target = new URL(url);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await requestOnce(target, {
          method,
          headers,
          body: hop === 0 ? body : undefined,
          timeoutMs,
        });

        if (REDIRECT_CODES.has(res.statusCode) && res.headers.location) {
          target = new URL(res.headers.location, target);
          continue;
        }
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode} untuk ${target.href}`);
          err.statusCode = res.statusCode;
          err.body = res.body;
          throw err;
        }
        return res;
      }
      throw new Error(`terlalu banyak redirect untuk ${url}`);
    } catch (err) {
      lastError = err;
      if (attempt < retries && err.statusCode !== 404) {
        await new Promise((res) => setTimeout(res, backoffMs * (attempt + 1)));
      } else if (err.statusCode === 404) {
        throw err;
      }
    }
  }

  throw lastError;
}

async function getHTML(url, options = {}) {
  const res = await request(url, options);
  return res.body;
}

async function getJSON(url, options = {}) {
  const res = await request(url, {
    ...options,
    headers: { accept: "application/json", ...(options.headers ?? {}) },
  });
  return JSON.parse(res.body);
}

async function postJSON(url, payload, options = {}) {
  const body = JSON.stringify(payload);
  const res = await request(url, {
    ...options,
    method: "POST",
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  return JSON.parse(res.body);
}

const BASE = "https://nekopoi.care";
const WP = `${BASE}/wp-json/wp/v2`;
const COMMENTS_API = "https://cms.jejakpoi.top/api/embed/comments";
const COMMENTS_HOST = "nekopoi.care";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "\u2026",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
  bull: "\u2022",
  deg: "\u00b0",
  times: "\u00d7",
  divide: "\u00f7",
};

function decodeEntities(value) {
  if (typeof value !== "string" || value.indexOf("&") === -1) return value;
  return value.replace(
    /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, body) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? whole;
    },
  );
}

function stripTags(value) {
  if (!value) return value;
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function cleanText(value) {
  return decodeEntities(stripTags(value ?? ""));
}

function parseFields(html) {
  const pick = (label) => {
    const match = html.match(
      new RegExp(`<strong>${label}\\s*:?\\s*</strong>([^<]*)`),
    );
    return match ? decodeEntities(match[1]).trim() : "";
  };

  const sizeMatch = html.match(
    /<strong>Size[^<]*<\/strong>([^<]*(?:<strong>[^<]*<\/strong>[^<]*)*)/,
  );
  const size = sizeMatch ? cleanText(sizeMatch[1]) : "";

  return {
    originalTitle: pick("Original Title"),
    code: pick("Nuclear Code"),
    actress: pick("Actress"),
    producers: pick("Producers"),
    duration: pick("Duration"),
    genre: pick("Genre"),
    size,
  };
}

function mapPost(post) {
  return {
    id: post.id,
    title: decodeEntities(stripTags(post.title?.rendered ?? "")),
    slug: post.slug,
    url: post.link,
    date: post.date,
    excerpt: decodeEntities(stripTags(post.excerpt?.rendered ?? "")),
    categories: post.categories ?? [],
    tags: post.tags ?? [],
    fields: parseFields(post.content?.rendered ?? ""),
  };
}

async function listPosts(page = 1, perPage = 20) {
  const posts = await getJSON(`${WP}/posts?per_page=${perPage}&page=${page}`);
  return posts.map(mapPost);
}

async function search(query, page = 1, perPage = 20) {
  const posts = await getJSON(
    `${WP}/posts?per_page=${perPage}&page=${page}&search=${encodeURIComponent(query)}`,
  );
  return posts.map(mapPost);
}

async function byCategory(categoryId, page = 1, perPage = 20) {
  const posts = await getJSON(
    `${WP}/posts?per_page=${perPage}&page=${page}&categories=${categoryId}`,
  );
  return posts.map(mapPost);
}

function extractStreams(html) {
  const urls = [
    ...html.matchAll(/<iframe[^>]+src="(https:\/\/playmogo\.com\/e\/[^"]+)"/g),
  ].map((match) => decodeEntities(match[1]));
  return [...new Set(urls)];
}

function extractDownloads(html) {
  const downloads = [];
  for (const row of html.match(/<div class="nk-download-row">[\s\S]*?<\/div><\/div>/g) ?? []) {
    const quality = row.match(/nk-download-name">([^<]+)<\/div>/)?.[1]?.trim();
    if (!quality) continue;
    const links = [
      ...row.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g),
    ].map((match) => ({
      host: cleanText(match[2]),
      url: decodeEntities(match[1]),
    }));
    downloads.push({ quality: cleanText(quality), links });
  }
  return downloads;
}

function extractRelated(html, selfUrl) {
  const index = html.indexOf("nk-related-list");
  if (index === -1) return [];

  let region = html.slice(index, index + 20_000);
  for (const stop of ["</ul>", "<footer", 'id="nk-sidebar"', "nk-comments"]) {
    const at = region.indexOf(stop);
    if (at > 0) region = region.slice(0, at);
  }

  const seen = new Set();
  const related = [];
  for (const match of region.matchAll(/<a[^>]*href="(https:\/\/nekopoi\.care\/[^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/g)) {
    const url = decodeEntities(match[1]);
    if (url === selfUrl || seen.has(url)) continue;
    seen.add(url);
    related.push({ title: cleanText(match[2]), url });
  }
  return related;
}

async function getDetail(url) {
  const html = await getHTML(url);
  const title = html.match(/property="og:title" content="([^"]+)"/)?.[1] ?? "";
  const synopsis = html.match(/property="og:description" content="([^"]+)"/)?.[1] ?? "";
  const thumbnail = html.match(/property="og:image" content="([^"]+)"/)?.[1] ?? "";

  return {
    url,
    title: cleanText(title),
    synopsis: cleanText(synopsis).replace(/^Sinopsis\s*:\s*/, ""),
    thumbnail: decodeEntities(thumbnail),
    streams: extractStreams(html),
    downloads: extractDownloads(html),
    related: extractRelated(html, url),
    prevEpisode:
      html.match(/<a href="([^"]+)"[^>]*class="nk-episode-prev"/)?.[1] ??
      html.match(/class="nk-episode-prev"[^>]*href="([^"]+)"/)?.[1] ??
      null,
    nextEpisode:
      html.match(/<a href="([^"]+)"[^>]*class="nk-episode-next"/)?.[1] ??
      html.match(/class="nk-episode-next"[^>]*href="([^"]+)"/)?.[1] ??
      null,
    fields: parseFields(html),
  };
}

async function getSeries(url) {
  const html = await getHTML(url);
  const episodes = [
    ...new Set(
      [
        ...html.matchAll(
          /href="(https:\/\/nekopoi\.care\/[^"]*episode[^"]+\/)"/g,
        ),
      ].map((match) => match[1]),
    ),
  ];
  return {
    url,
    title: cleanText(html.match(/<title>([^<]+)<\/title>/)?.[1]),
    thumbnail: decodeEntities(
      html.match(/property="og:image" content="([^"]+)"/)?.[1] ?? "",
    ),
    synopsis: cleanText(
      html.match(/property="og:description" content="([^"]+)"/)?.[1] ?? "",
    ).replace(/^Sinopsis\s*:\s*/, ""),
    episodes,
  };
}

async function getGenres() {
  const html = await getHTML(`${BASE}/genre-list/`);
  return [
    ...new Set(
      [
        ...html.matchAll(
          /href="https:\/\/nekopoi\.care\/genres\/([a-z0-9-]+)\/"/g,
        ),
      ].map((match) => match[1]),
    ),
  ].sort();
}

function parseGenreResults(html) {
  const items = [];
  const seen = new Set();

  for (const match of html.matchAll(
    /<a href="(https:\/\/nekopoi\.care\/[^"]+)" class="nk-search-item">([\s\S]*?)<\/a>/g,
  )) {
    const url = decodeEntities(match[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    const block = match[2];

    items.push({
      url,
      title: cleanText(block.match(/<h2>([\s\S]*?)<\/h2>/)?.[1]),
      thumb: decodeEntities(
        block.match(/background-image:\s*url\('([^']+)'\)/)?.[1] ?? "",
      ),
      genres: cleanText(
        block.match(/<span class="nk-search-genres">([\s\S]*?)<\/span>/)?.[1],
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      description: cleanText(
        block.match(/<p class="nk-search-desc">([\s\S]*?)<\/p>/)?.[1],
      ),
    });
  }

  const nextUrl =
    html.match(/<a class="next page-numbers" href="([^"]+)"/)?.[1] ?? null;

  return { items, hasNext: Boolean(nextUrl), nextUrl: nextUrl && decodeEntities(nextUrl) };
}

async function getGenrePosts(genre, page = 1) {
  const url =
    page > 1
      ? `${BASE}/genres/${genre}/page/${page}/`
      : `${BASE}/genres/${genre}/`;
  const html = await getHTML(url);
  return { genre, page, ...parseGenreResults(html) };
}

function normalizeComments(payload) {
  const commenters = payload?.commenters ?? {};
  const raw = payload?.comments;
  const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});

  return list.map((comment) => {
    const authorId = comment.authorId ?? comment.commenterId ?? null;
    const profile = authorId != null ? commenters[authorId] : null;
    return {
      id: comment.id,
      parentId: comment.parentId ?? null,
      author: profile?.name ?? comment.author?.name ?? comment.authorName ?? null,
      markdown: comment.markdown ?? comment.html ?? "",
      score: comment.score,
      createdAt: comment.createdAt,
      isDeleted: comment.isDeleted ?? false,
    };
  });
}

async function fetchComments(path, options = {}) {
  const body = { domainId: null, host: COMMENTS_HOST, path };
  if (options.after) body.after = options.after;
  if (options.limit) body.limit = options.limit;
  return postJSON(COMMENTS_API, body, {
    headers: { origin: BASE, referer: `${BASE}/` },
  });
}

async function getComments(path, options = {}) {
  const { limit = 100, maxPages = 20 } = options;
  const collected = new Map();
  let cursor;

  for (let round = 0; round < maxPages; round++) {
    const payload = await fetchComments(path, { after: cursor, limit });
    const batch = normalizeComments(payload);
    let added = 0;
    for (const comment of batch) {
      if (collected.has(comment.id)) continue;
      collected.set(comment.id, comment);
      added++;
    }
    if (!added || batch.length === 0) break;
    const last = batch[batch.length - 1];
    if (!last?.createdAt || last.createdAt === cursor) break;
    cursor = last.createdAt;
  }

  const comments = [...collected.values()].sort((a, b) =>
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  );
  return { path, count: comments.length, comments };
}

const CATEGORIES = {
  "2d-animation": 682,
  "3d-hentai": 81,
  hentai: 2,
  info: 3,
  jav: 4,
  "jav-cosplay": 1,
  "jav-subtitle-indonesia": 597,
};

async function readProgress(progressPath) {
  try {
    return JSON.parse(await readFile(progressPath, "utf8"));
  } catch {
    return null;
  }
}

async function scrapeAll(options = {}) {
  const {
    startPage = 1,
    pages = 1,
    perPage = 100,
    concurrency = 3,
    outPath = null,
    resume = true,
    onPage,
  } = options;

  const progressPath = outPath ? `${outPath}.progress.json` : null;
  const state =
    (resume && progressPath ? await readProgress(progressPath) : null) ?? {
      perPage,
      pages: {},
      done: [],
      startedAt: new Date().toISOString(),
    };

  if (state.perPage !== perPage) {
    throw new Error(
      `progres lama memakai per_page=${state.perPage}, sekarang ${perPage}; hapus ${progressPath} dulu`,
    );
  }

  const done = new Set(state.done);
  const queue = [];
  for (let page = startPage; page < startPage + pages; page++) {
    if (!done.has(page)) queue.push(page);
  }

  if (done.size) {
    console.error(`resume: ${done.size} halaman sudah ada, ${queue.length} tersisa`);
  }

  let cursor = 0;
  let consecutiveEmpty = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      const page = queue[cursor++];
      let batch;
      try {
        batch = await listPosts(page, perPage);
      } catch (err) {
        if (err.statusCode === 400) batch = [];
        else throw err;
      }

      state.pages[page] = batch;
      state.done.push(page);
      state.updatedAt = new Date().toISOString();

      if (progressPath) {
        await writeFile(progressPath, `${JSON.stringify(state)}\n`, "utf8");
      }

      onPage?.(page, batch.length, state.done.length);
      if (batch.length === 0) consecutiveEmpty++;

      if (consecutiveEmpty >= 2) cursor = queue.length;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker),
  );

  const orderedPages = [...new Set(state.done)].sort((a, b) => a - b);
  const emptyPage = orderedPages.find((page) => (state.pages[page]?.length ?? 0) === 0);
  const kept = orderedPages.filter((page) => emptyPage == null || page < emptyPage);

  const posts = kept.flatMap((page) => state.pages[page] ?? []);

  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(posts, null, 2)}\n`, "utf8");
    console.error(`disimpan ke ${outPath} (${posts.length} post)`);
    if (progressPath) {
      try {
        await unlink(progressPath);
      } catch {
      }
    }
  }

  return posts;
}

function printUsage() {
  console.error(
    [
      "scraper by potato",
      "  node nekopoi.js list [halaman] [per_page]",
      "  node nekopoi.js detail <url>",
      "  node nekopoi.js search <query> [halaman]",
      "  node nekopoi.js category <nama|id> [halaman]",
      "  node nekopoi.js genres",
      "  node nekopoi.js genre <slug> [halaman]",
      "  node nekopoi.js series <url>",
      "  node nekopoi.js comments <path>",
      "  node nekopoi.js all <jumlah-halaman> <file.json> [halaman-awal] [paralel] [--no-resume]",
    ].join("\n"),
  );
}

async function writeJson(jsonPath, payload) {
  if (!jsonPath) return;
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\nJSON tersimpan di ${jsonPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const takeFlag = (flag) => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };

  const jsonPath = takeFlag("--json");
  const noResume = args.includes("--no-resume");
  const filtered = args.filter((value) => value !== "--no-resume");
  const [cmd, a, b, c, d] = filtered;

  if (!cmd) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  switch (cmd) {
    case "list": {
      const posts = await listPosts(Number(a) || 1, Number(b) || 20);
      console.log(JSON.stringify(posts, null, 2));
      return;
    }
    case "detail": {
      const detail = await getDetail(a);
      console.log(JSON.stringify(detail, null, 2));
      await writeJson(jsonPath, detail);
      return;
    }
    case "search": {
      const posts = await search(a, Number(b) || 1);
      console.log(JSON.stringify(posts, null, 2));
      await writeJson(jsonPath, posts);
      return;
    }
    case "category": {
      const categoryId = CATEGORIES[a] ?? Number(a);
      const posts = await byCategory(categoryId, Number(b) || 1);
      console.log(JSON.stringify(posts, null, 2));
      await writeJson(jsonPath, posts);
      return;
    }
    case "genres": {
      const genres = await getGenres();
      console.log(JSON.stringify(genres, null, 2));
      return;
    }
    case "genre": {
      const result = await getGenrePosts(a, Number(b) || 1);
      console.log(JSON.stringify(result, null, 2));
      await writeJson(jsonPath, result);
      return;
    }
    case "series": {
      const series = await getSeries(a);
      console.log(JSON.stringify(series, null, 2));
      await writeJson(jsonPath, series);
      return;
    }
    case "comments": {
      const comments = await getComments(a);
      console.log(JSON.stringify(comments, null, 2));
      return;
    }
    case "all": {
      const posts = await scrapeAll({
        pages: Number(a) || 1,
        outPath: b,
        startPage: Number(c) || 1,
        concurrency: Number(d) || 3,
        resume: !noResume,
        onPage: (page, count, completed) => {
          process.stderr.write(
            `halaman ${page}: +${count} (${completed} halaman selesai)\n`,
          );
        },
      });
      console.error(`total ${posts.length} post`);
      return;
    }
    default:
      printUsage();
      process.exitCode = 1;
  }
}

const isMain = require.main === module;

if (isMain) {
  main().catch((err) => {
    console.error(`Gagal: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { listPosts, getDetail, search, scrapeAll, parseFields, getSeries, byCategory, CATEGORIES, getGenres, getGenrePosts, parseGenreResults, getComments, decodeEntities };
