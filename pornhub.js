// scraper by potato
const https = require("node:https");
const zlib = require("node:zlib");
const { writeFile } = require("node:fs/promises");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

function requestOnce(target, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
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

const BASE = "https://www.pornhub.com";
const SITE_COOKIE = { cookie: "age_verified=1; platform=pc" };

const get = (url) => getHTML(url, { headers: SITE_COOKIE });
const json = (url) => getJSON(url, { headers: SITE_COOKIE });

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

function firstMatch(block, patterns) {
  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match) return stripTags(match[1]);
  }
  return undefined;
}

const LISTING_START = 'id="videoSearchResult"';
const LISTING_END = 'id="footer"';

const DROPDOWN_BLOCK =
  /<ul[^>]*class="[^"]*dropdown[^"]*Videos[^"]*"[^>]*>[\s\S]*?<\/ul>/g;

const CARD_OPEN = /<li[^>]*data-video-vkey="([A-Za-z0-9]+)"[^>]*>/g;
const CARD_MAX = 8000;

function sliceListing(html) {
  const start = html.indexOf(LISTING_START);
  if (start !== -1) {
    const end = html.indexOf(LISTING_END, start);
    return end === -1 ? html.slice(start) : html.slice(start, end);
  }
  return html.replace(DROPDOWN_BLOCK, "");
}

function cardBlocks(html) {
  const source = sliceListing(html);
  const starts = [...source.matchAll(CARD_OPEN)];
  return starts.map((match, index) => {
    const from = match.index;
    const nextStart = starts[index + 1]?.index ?? source.length;
    const ulEnd = source.indexOf("</ul>", from);
    const limit = Math.min(
      nextStart,
      ulEnd === -1 ? source.length : ulEnd,
      from + CARD_MAX,
    );
    return { vkey: match[1], block: source.slice(from, limit) };
  });
}

function durationTextToSeconds(text) {
  if (!text) return undefined;
  const parts = text.trim().split(":").map(Number);
  if (parts.some((value) => !Number.isFinite(value))) return undefined;
  return parts.reduce((total, value) => total * 60 + value, 0);
}

function parseVideos(html) {
  const videos = [];
  const seen = new Set();

  for (const { vkey, block } of cardBlocks(html)) {
    if (!vkey || seen.has(vkey)) continue;
    seen.add(vkey);

    const title = firstMatch(block, [
      /<a[^>]*href="\/view_video\.php\?viewkey=[^"]*"[^>]*title="([^"]+)"/s,
      /title="([^"]{3,300})"/s,
    ]);

    const duration = firstMatch(block, [
      /<var[^>]*class="[^"]*\bduration\b[^"]*"[^>]*>([\s\S]*?)<\/var>/,
      /<var class="duration">\s*([^<]+?)\s*<\/var>/,
    ]);

    videos.push({
      vkey,
      title: decodeEntities(title),
      durationSeconds: durationTextToSeconds(duration),
      duration,
      views: firstMatch(block, [
        /<span[^>]*class="[^"]*\bviews\b[^"]*"[^>]*>[\s\S]*?<var>\s*([^<]+?)\s*<\/var>/,
        /<var>\s*([^<]+?)\s*<\/var>\s*views/,
      ]),
      added: firstMatch(block, [/<var class="added">\s*([^<]+?)\s*<\/var>/]),
      rating: firstMatch(block, [
        /class="rating-container[^"]*"[\s\S]{0,600}?<div class="value">\s*(\d{1,3}%)\s*<\/div>/,
        /class="rating-container[^"]*"[\s\S]{0,600}?<span>\s*(\d{1,3}%)\s*<\/span>/,
      ]),
      url: `${BASE}/view_video.php?viewkey=${vkey}`,
      thumb: firstMatch(block, [
        /<img[^>]*\ssrc="([^"]*phncdn[^"]*)"/s,
        /data-image="([^"]*phncdn[^"]*)"/s,
      ]),
    });
  }

  return videos;
}

function parsePagination(html, fallbackPage = 1) {
  const index = html.indexOf('class="pagination3');
  if (index === -1) {
    return { currentPage: fallbackPage, hasNext: null, lastVisiblePage: fallbackPage };
  }

  const block = html.slice(index, index + 12_000);
  const currentPage = Number.parseInt(
    block.match(/<li\s+class="page_current[^"]*"\s*>\s*<span[^>]*>\s*(\d+)/)?.[1] ?? "",
    10,
  );
  const pageOf = (href) => {
    const match = decodeEntities(href).match(/[?&]page=(\d+)/);
    return match ? Number(match[1]) : null;
  };
  const numbers = [
    ...block.matchAll(
      /<li\s+class="page_number[^"]*"\s*>\s*<a[^>]*href="([^"]*)"/g,
    ),
  ]
    .map((match) => pageOf(match[1]))
    .filter((value) => value != null);
  const nextHref = decodeEntities(
    block.match(/<li\s+class="page_next[^"]*"\s*>\s*<a[^>]*href="([^"]*)"/)?.[1] ?? "",
  );

  return {
    currentPage: Number.isFinite(currentPage) ? currentPage : fallbackPage,
    hasNext: /[?&]page=\d+/.test(nextHref),
    lastVisiblePage: numbers.length
      ? Math.max(...numbers, Number.isFinite(currentPage) ? currentPage : 0)
      : Number.isFinite(currentPage)
        ? currentPage
        : fallbackPage,
  };
}

function parseLdJson(html) {
  const match = html.match(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) return null;
  try {
    const data = JSON.parse(match[1].trim());
    if (Array.isArray(data)) {
      return data.find((item) => item?.["@type"] === "VideoObject") ?? data[0];
    }
    return data;
  } catch {
    return null;
  }
}

function isoDurationToSeconds(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso ?? "");
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Math.round(Number(seconds ?? 0))
  );
}

function formatSeconds(total) {
  if (total == null) return undefined;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.round(total % 60);
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

function interactionCount(stats, typeSuffix) {
  if (!Array.isArray(stats)) return undefined;
  const item = stats.find((entry) =>
    String(entry?.interactionType ?? "").endsWith(typeSuffix),
  );
  return item?.userInteractionCount;
}

function parseFlashvars(html) {
  const match = html.match(/flashvars_\d+\s*=\s*(\{.+?\});/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractRating(html) {
  const index = html.indexOf('class="rating-container');
  if (index === -1) return undefined;
  const match = html
    .slice(index, index + 800)
    .match(/<div class="value">\s*([^<]+?)\s*<\/div>/);
  return match ? decodeEntities(match[1].trim()) : undefined;
}

function uploaderType(href) {
  if (href.startsWith("/channels/")) return "channel";
  if (href.startsWith("/pornstar/")) return "pornstar";
  if (href.startsWith("/model/")) return "model";
  if (href.startsWith("/users/")) return "user";
  return "unknown";
}

function extractUploader(html) {
  const index = html.indexOf("videoUploaderBlock");
  if (index === -1) return undefined;
  const match = html
    .slice(index, index + 1500)
    .match(
      /<div class="usernameWrap">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/,
    );
  if (!match) return undefined;
  const href = decodeEntities(match[1]);
  return {
    name: decodeEntities(stripTags(match[2])),
    url: `${BASE}${href}`,
    type: uploaderType(href),
  };
}

function sliceInfoRow(html, marker, maxLength = 6000) {
  const index = html.indexOf(marker);
  if (index === -1) return null;
  const region = html.slice(index, index + maxLength);
  const end = region.indexOf("video-info-row");
  return end === -1 ? region : region.slice(0, end);
}

function extractTags(html) {
  const body = sliceInfoRow(html, "tagsWrapper");
  if (!body) return [];
  return [
    ...body.matchAll(
      /class="[^"]*item isTag"[^>]*href="([^"]+)"[^>]*><span>([\s\S]{0,120}?)<\/span>/g,
    ),
  ].map((match) => {
    const url = `${BASE}${decodeEntities(match[1])}`;
    const params = new URL(url).searchParams;
    return {
      name: decodeEntities(stripTags(match[2])),
      slug: params.get("search") ?? url.split("/").pop(),
      url,
    };
  });
}

function extractCategories(html) {
  const body = sliceInfoRow(html, "categoriesWrapper", 4000);
  if (!body) return [];
  return [
    ...body.matchAll(
      /<a[^>]*data-label="category"[^>]*href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g,
    ),
  ].map((match) => {
    const href = decodeEntities(match[1]);
    return {
      name: decodeEntities(stripTags(match[2])),
      slug: new URL(`${BASE}${href}`).searchParams.get("c") ?? href,
      url: `${BASE}${href}`,
    };
  });
}

function extractPerformers(html) {
  const body = sliceInfoRow(html, "pornstarsWrapper", 4000);
  if (!body) return [];
  return [
    ...body.matchAll(
      /<a[^>]*href="\/(pornstar|model)\/([^"\/]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g,
    ),
  ].map((match) => ({
    name: decodeEntities(stripTags(match[3])),
    slug: match[2],
    type: match[1],
    url: `${BASE}/${match[1]}/${match[2]}`,
  }));
}

function parseVideoDetail(html, viewkey) {
  const ld = parseLdJson(html) ?? {};
  const flashvars = parseFlashvars(html);
  const durationSeconds =
    isoDurationToSeconds(ld.duration) ?? flashvars?.video_duration ?? undefined;

  const viewsText = html.match(/<span class="count">([\d,.]+[KM]?)<\/span>\s*Views/)?.[1];

  return {
    viewkey,
    title: decodeEntities(ld.name) ?? decodeEntities(flashvars?.video_title),
    duration: formatSeconds(durationSeconds),
    durationIso: ld.duration,
    durationSeconds,
    views: interactionCount(ld.interactionStatistic, "WatchAction"),
    viewsText,
    likes: interactionCount(ld.interactionStatistic, "LikeAction"),
    rating: extractRating(html),
    uploadDate: ld.uploadDate,
    uploaded: html.match(/<div class="videoInfo">([^<]+)<\/div>/)?.[1]?.trim(),
    description: decodeEntities(ld.description),
    uploader: extractUploader(html),
    performers: extractPerformers(html),
    tags: extractTags(html),
    categories: extractCategories(html),
    thumbnail: ld.thumbnailUrl ?? flashvars?.image_url,
    url: `${BASE}/view_video.php?viewkey=${viewkey}`,
    embedUrl: `${BASE}/embed/${viewkey}`,
  };
}

async function getVideoDetail(viewkey) {
  const html = await get(
    `${BASE}/view_video.php?viewkey=${encodeURIComponent(viewkey)}`,
  );
  const detail = parseVideoDetail(html, viewkey);

  const flashvars = parseFlashvars(html);
  const streams = (flashvars?.mediaDefinitions ?? [])
    .filter((entry) => entry.videoUrl)
    .map((entry) => ({
      quality: entry.quality || "auto",
      format: entry.format,
      url: entry.videoUrl,
    }));

  let related = [];
  const relatedId = flashvars?.video_id || flashvars?.playbackTracking?.video_id;
  if (relatedId) {
    try {
      const payload = await json(
        `${BASE}/api/v1/video/player_related_datas?id=${relatedId}`,
      );
      const raw = payload.mostViewed ?? payload.related ?? [];
      related = raw.map((video) =>
        Array.isArray(video)
          ? {
              thumb: video[0],
              title: video[1],
              duration: video[2],
              url: video[4],
              views: video[5],
            }
          : video,
      );
    } catch {
      related = [];
    }
  }

  return { ...detail, streams, related };
}

async function scrapePageRaw(path, page = 1) {
  const separator = path.includes("?") ? "&" : "?";
  let html;
  try {
    html = await get(`${BASE}${path}${separator}page=${page}`);
  } catch (err) {
    if (err.statusCode === 404) {
      return {
        videos: [],
        pagination: { currentPage: page, hasNext: false, lastVisiblePage: page },
      };
    }
    throw err;
  }
  return { videos: parseVideos(html), pagination: parsePagination(html, page) };
}

async function scrapePage(path, page = 1) {
  const { videos } = await scrapePageRaw(path, page);
  return videos;
}

const scrapeSearch = (query, page = 1) =>
  scrapePage(`/video/search?search=${encodeURIComponent(query)}`, page);

const scrapeCategory = (category, page = 1) =>
  scrapePage(`/video?category=${encodeURIComponent(category)}`, page);

const scrapeTag = (tag, page = 1) =>
  scrapePage(`/video?tag=${encodeURIComponent(tag)}`, page);

const scrapePornstar = (name, page = 1) =>
  scrapePage(`/pornstar/${encodeURIComponent(name)}`, page);

const scrapeModel = (name, page = 1) =>
  scrapePage(`/model/${encodeURIComponent(name)}`, page);

const scrapeChannel = (name, page = 1) =>
  scrapePage(`/channels/${encodeURIComponent(name)}`, page);

function parseCategoriesIndex(html) {
  const parts = html.split(/class="category-wrapper\b/).slice(1);
  const seen = new Map();

  for (const part of parts) {
    const block = part.slice(0, 1200);
    const idMatch = block.match(/href="\/video\?c=(\d+)"/);
    const slugMatch = block.match(/href="\/categories\/([a-z0-9-]+)"/);
    if (!idMatch && !slugMatch) continue;

    const strong = block.match(/<strong>([\s\S]{0,80}?)<\/strong>/);
    let rawName = strong?.[1];
    if (!rawName) {
      const anchor = block.match(/<a[^>]*>([\s\S]{0,160}?)<\/a>/);
      rawName = anchor?.[1].split(/<span/i)[0];
    }
    const name = decodeEntities(stripTags(rawName));
    if (!name) continue;

    const countMatch =
      block.match(/<var>\s*([\d.,]+)\s*<\/var>/) ??
      block.match(/<span[^>]*>\s*([\d.,]+)\s*<\/span>/);
    const count = countMatch
      ? Number.parseInt(countMatch[1].replace(/[.,]/g, ""), 10)
      : undefined;

    const id = idMatch?.[1];
    const slug = slugMatch?.[1];
    const key = id ?? slug ?? name.toLowerCase();
    if (seen.has(key)) continue;

    seen.set(key, {
      ...(id ? { id } : {}),
      ...(slug ? { slug } : {}),
      name,
      ...(Number.isFinite(count) ? { count } : {}),
      url: id ? `${BASE}/video?c=${id}` : `${BASE}/categories/${slug}`,
    });
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parsePornstarsIndex(html) {
  const parts = html.split(/\bperformerCard\b/).slice(1);
  const seen = new Map();

  for (const part of parts) {
    const block = part.slice(0, 6000);
    const link = block.match(/href="\/(pornstar|model)\/([^"\/]+)"/);
    if (!link) continue;
    const [, type, slug] = link;
    if (seen.has(slug)) continue;

    const nameSpan = block.match(
      /<span[^>]*class="[^"]*performerCardName[^"]*"[^>]*>([\s\S]*?)<\/span>/,
    );
    let name = decodeEntities(stripTags(nameSpan?.[1]));
    if (!name) {
      const anchorText = block.match(
        /<a[^>]*href="\/(?:pornstar|model)\/[^"\/]+"[^>]*>([^<]{1,120})/,
      );
      name = decodeEntities(stripTags(anchorText?.[1]));
    }
    if (!name) continue;

    const countMatch = block.match(
      /class="[^"]*performerCount[^"]*"[^>]*>([\s\S]{0,80}?)<\/span>/,
    );
    const countDigits = countMatch?.[1].replace(/[^\d]/g, "");
    const count = countDigits ? Number.parseInt(countDigits, 10) : undefined;

    seen.set(slug, {
      type,
      slug,
      name,
      ...(count ? { count } : {}),
      url: `${BASE}/${type}/${slug}`,
    });
  }

  return [...seen.values()];
}

async function scrapeCategoriesIndex() {
  return parseCategoriesIndex(await get(`${BASE}/categories`));
}

async function scrapePornstarsIndex(page = 1) {
  return parsePornstarsIndex(await get(`${BASE}/pornstars?page=${page}`));
}

const LISTING_PATHS = {
  search: (value) => `/video/search?search=${encodeURIComponent(value)}`,
  category: (value) => `/video?category=${encodeURIComponent(value)}`,
  tag: (value) => `/video?tag=${encodeURIComponent(value)}`,
  pornstar: (value) => `/pornstar/${encodeURIComponent(value)}`,
  model: (value) => `/model/${encodeURIComponent(value)}`,
  channel: (value) => `/channels/${encodeURIComponent(value)}`,
};

async function scrapeMany(mode, value, firstPage = 1, pageCount = 1, options = {}) {
  const buildPath = LISTING_PATHS[mode];
  if (!buildPath) throw new Error(`mode listing tidak dikenal: ${mode}`);

  const { concurrency = 3, onPage } = options;
  const path = buildPath(value);
  const queue = Array.from({ length: pageCount }, (_, index) => firstPage + index);
  const results = new Map();
  let cursor = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      const page = queue[cursor++];
      const startedAt = performance.now();
      const { videos, pagination } = await scrapePageRaw(path, page);
      const elapsedMs = Math.round(performance.now() - startedAt);
      results.set(page, { videos, pagination, elapsedMs });
      onPage?.(page, videos, elapsedMs, pagination);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker),
  );

  const emptyPages = [...results]
    .filter(([, result]) => result.videos.length === 0)
    .map(([page]) => page);
  const naturalLast = [...results]
    .filter(([, result]) => result.videos.length > 0 && result.pagination.hasNext === false)
    .map(([page]) => page);

  const stopAfter = Math.min(
    emptyPages.length ? Math.min(...emptyPages) - 1 : Infinity,
    naturalLast.length ? Math.min(...naturalLast) : Infinity,
  );

  const pages = {};
  let total = 0;
  for (const page of queue) {
    if (page > stopAfter) continue;
    const result = results.get(page);
    if (!result) continue;
    pages[`page${page}`] = result.videos;
    total += result.videos.length;
  }

  const lastPage =
    stopAfter === Infinity
      ? Math.max(...queue)
      : Math.max(firstPage, stopAfter);

  return { pages, total, firstPage, lastPage, requested: pageCount };
}

const LISTING_MODES = Object.keys(LISTING_PATHS);

function printUsage() {
  console.error(
    [
      "scraper by potato",
      "  node pornhub.js <search|category|tag|pornstar|model|channel> <nilai> [halaman] [jumlah-halaman] [--json file] [--concurrency N]",
      "  node pornhub.js video <viewkey> [--json file]",
      "  node pornhub.js categories [--json file]",
      "  node pornhub.js pornstars [halaman] [--json file]",
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
  const concurrencyArg = takeFlag("--concurrency");
  const pagesFlag = takeFlag("--pages");
  const [mode, value, pageArg, countArg] = args;

  if (!mode) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const startedAt = performance.now();

  if (mode === "video") {
    if (!value) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const detail = await getVideoDetail(value);
    console.log(`${detail.title} [${detail.duration ?? "?"}]`);
    console.log(
      `${detail.views ?? "?"} views | ${detail.likes ?? "?"} likes | rating ${detail.rating ?? "?"} | ${detail.uploadDate ?? "?"}`,
    );
    if (detail.uploader) {
      console.log(`Uploader: ${detail.uploader.name} (${detail.uploader.type})`);
    }
    if (detail.performers.length) {
      console.log(`Performer: ${detail.performers.map((p) => p.name).join(", ")}`);
    }
    if (detail.categories.length) {
      console.log(`Kategori: ${detail.categories.map((c) => c.name).join(", ")}`);
    }
    if (detail.tags.length) {
      console.log(`Tag: ${detail.tags.map((t) => t.name).join(", ")}`);
    }
    console.log(`Embed resmi: ${detail.embedUrl}`);
    await writeJson(jsonPath, detail);
    return;
  }

  if (mode === "categories") {
    const categories = await scrapeCategoriesIndex();
    console.log(`${categories.length} kategori:`);
    for (const category of categories) {
      const count = category.count != null ? ` (${category.count} video)` : "";
      console.log(`- ${category.name}${count} :: ${category.url}`);
    }
    await writeJson(jsonPath, { mode, categories });
    return;
  }

  if (mode === "pornstars") {
    const page = Number.parseInt(value ?? "1", 10) || 1;
    const pornstars = await scrapePornstarsIndex(page);
    console.log(`${pornstars.length} performer dari halaman ${page}:`);
    for (const performer of pornstars) {
      const count = performer.count != null ? ` ${performer.count} video` : "";
      console.log(`- ${performer.name} (${performer.type}${count}) :: ${performer.url}`);
    }
    await writeJson(jsonPath, { mode, page, pornstars });
    return;
  }

  if (!LISTING_MODES.includes(mode) || !value) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const firstPage = Number.parseInt(pageArg ?? "1", 10) || 1;
  const pageCount =
    Number.parseInt(pagesFlag ?? countArg ?? "1", 10) || 1;
  const concurrency = Math.max(1, Number.parseInt(concurrencyArg ?? "3", 10) || 3);

  const result = await scrapeMany(mode, value, firstPage, pageCount, {
    concurrency,
    onPage: (page, videos, elapsedMs, pagination) => {
      const tail = pagination.hasNext === false ? " (halaman terakhir)" : "";
      process.stderr.write(
        `[halaman ${page}] ${videos.length} video (${elapsedMs}ms)${tail}\n`,
      );
    },
  });

  for (const [pageKey, videos] of Object.entries(result.pages)) {
    const page = pageKey.replace("page", "");
    console.log(`${videos.length} video dari halaman ${page}:`);
    for (const video of videos) {
      console.log(
        `- [${video.duration ?? "?"}] ${video.title} ` +
          `(${video.views ?? "?"} views, ${video.rating ?? "?"}) :: ${video.url}`,
      );
    }
  }

  await writeJson(jsonPath, {
    mode,
    query: value,
    total: result.total,
    firstPage: result.firstPage,
    lastPage: result.lastPage,
    pages: result.pages,
    scrapedAt: new Date().toISOString(),
  });

  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  console.error(
    `\nSelesai ${result.total} video dari halaman ${result.firstPage}-${result.lastPage} dalam ${seconds}s (paralel ${concurrency}).`,
  );
}

const isMain = require.main === module;

if (isMain) {
  main().catch((err) => {
    console.error(`Gagal: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseVideos, parsePagination, parseVideoDetail, getVideoDetail, scrapePage, scrapeSearch, scrapeCategory, scrapeTag, scrapePornstar, scrapeModel, scrapeChannel, parseCategoriesIndex, parsePornstarsIndex, scrapeCategoriesIndex, scrapePornstarsIndex, scrapeMany };
