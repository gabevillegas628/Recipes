import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch, type Response } from 'undici';

/**
 * fetch() for user-supplied URLs. Refuses anything that resolves to a private,
 * loopback or link-local address (so the import endpoint can't be used to poke
 * at Railway's internal network), follows redirects manually so every hop is
 * checked, and caps response size and time.
 */

// An honest User-Agent over HTTP/2 gets through more bot checks than pretending to be
// Chrome: Cloudflare compares a claimed browser against the TLS/HTTP fingerprint, and
// Node's doesn't look like Chrome. (Tested against Allrecipes, Serious Eats, Budget Bytes.)
const USER_AGENT = 'Mozilla/5.0 (compatible; RecipeBox/1.0; personal recipe organizer)';

const dispatcher = new Agent({ allowH2: true });

const MAX_REDIRECTS = 5;

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

function isBlockedIp(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

/** A fetch failure with a message that's safe and useful to show the user. */
export class FetchError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

async function assertPublicHost(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('Only http and https links are supported.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [host]
    : await dns
        .lookup(host, { all: true, verbatim: true })
        .then((r) => r.map((a) => a.address))
        .catch(() => {
          throw new FetchError(`Couldn't find the site ${url.hostname}.`);
        });
  if (addresses.length === 0 || addresses.some(isBlockedIp)) {
    throw new FetchError(`${url.hostname} isn't a public website.`);
  }
}

export interface FetchedResource {
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  body: Buffer;
}

export async function safeFetch(
  input: string,
  { accept, maxBytes, timeoutMs = 15_000 }: { accept: string; maxBytes: number; timeoutMs?: number },
): Promise<FetchedResource> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError("That doesn't look like a valid link.");
  }

  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal,
        dispatcher,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      if (signal.aborted) throw new FetchError(`${url.hostname} took too long to respond.`);
      throw new FetchError(`Couldn't connect to ${url.hostname}.`);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new FetchError(`${url.hostname} sent a broken redirect.`);
      url = new URL(location, url);
      continue;
    }

    if (!res.ok) {
      if ([401, 403, 429, 503].includes(res.status)) {
        throw new FetchError(
          `${url.hostname} blocked the request (HTTP ${res.status}). Try pasting the recipe text instead.`,
          res.status,
        );
      }
      throw new FetchError(`${url.hostname} returned HTTP ${res.status}.`, res.status);
    }

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new FetchError('That page is too large to import.');

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new FetchError('That page is too large to import.');
        }
        chunks.push(value);
      }
    }

    return {
      url: url.toString(),
      contentType: res.headers.get('content-type') ?? '',
      body: Buffer.concat(chunks),
    };
  }

  throw new FetchError(`${url.hostname} redirected too many times.`);
}
