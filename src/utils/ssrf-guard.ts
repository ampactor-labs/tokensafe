import dns from "node:dns/promises";

const PRIVATE_RANGES_V4 = [
  // loopback
  { prefix: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8
  // RFC 1918
  { prefix: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { prefix: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { prefix: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
  // link-local
  { prefix: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 (AWS metadata)
  // CGNAT
  { prefix: 0x64400000, mask: 0xffc00000 }, // 100.64.0.0/10
  // "this" network
  { prefix: 0x00000000, mask: 0xff000000 }, // 0.0.0.0/8
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  return (
    parts.reduce((acc, octet) => {
      const n = parseInt(octet, 10);
      if (n < 0 || n > 255 || isNaN(n)) return -1;
      return (acc << 8) | n;
    }, 0) >>> 0
  );
}

export function isPrivateIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === "::1") return true;
  // IPv6 unique local (fc00::/7)
  if (/^f[cd]/i.test(ip)) return true;
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab]/i.test(ip)) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  let v4 = ip;
  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) {
    v4 = mappedMatch[1];
  } else if (ip.includes(":")) {
    // Other IPv6 — conservatively allow (non-private ranges)
    return false;
  }

  const num = ipv4ToInt(v4);
  if (num < 0) return false;

  for (const range of PRIVATE_RANGES_V4) {
    if ((num & range.mask) === range.prefix) return true;
  }
  return false;
}

/**
 * Resolve a hostname and check all resolved IPs against the private IP blocklist.
 * Throws if any resolved IP is private or DNS resolution fails.
 */
export async function resolveAndCheckIps(hostname: string): Promise<void> {
  const ips: string[] = [];

  try {
    const v4 = await dns.resolve4(hostname);
    ips.push(...v4);
  } catch {
    // No A records — not necessarily an error
  }

  try {
    const v6 = await dns.resolve6(hostname);
    ips.push(...v6);
  } catch {
    // No AAAA records — not necessarily an error
  }

  if (ips.length === 0) {
    throw new Error(
      `DNS resolution failed for ${hostname} — no A or AAAA records`,
    );
  }

  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(
        `Resolved IP ${ip} for ${hostname} is in a private/reserved range`,
      );
    }
  }
}

/**
 * Validate a webhook callback URL against SSRF attacks.
 * - Parses URL
 * - Enforces HTTPS in production (HTTP allowed in dev)
 * - Resolves DNS and blocks private IPs
 */
export async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Malformed URL");
  }

  // Scheme allowlist
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && parsed.protocol !== "https:") {
    throw new Error("Only HTTPS callback URLs are allowed in production");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  // Resolve DNS and check IPs
  await resolveAndCheckIps(parsed.hostname);
}
