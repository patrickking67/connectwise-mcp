// Who is calling, according to Cloudflare Access.
//
// This Worker never speaks OAuth itself. The Access application in front of it
// has Managed OAuth enabled, so Access is the authorization server: it answers
// the 401 with WWW-Authenticate, serves /.well-known/oauth-authorization-server,
// registers MCP clients dynamically, and runs the login against the identity
// provider. By the time a request reaches this code, Access has already decided
// the caller is allowed in. What is left for us is to read WHO they are, so the
// entitlement layer can decide WHAT they may do.
//
// Two ways to read the identity, tried in order:
//
// 1. ctx.access.getIdentity() - present when the Access application targets the
//    Worker itself (destination type "worker"). This is the preferred path: it
//    covers the workers.dev hostname, every custom domain and preview URLs, and
//    carries the full identity including group membership.
// 2. The Cf-Access-Jwt-Assertion header - present when a classic self-hosted
//    Access application fronts the hostname instead. The JWT is verified against
//    the team's JWKS with the audience tag pinned (ACCESS_TEAM_DOMAIN and
//    ACCESS_AUD must be set), and groups are fetched from /cdn-cgi/access/get-identity
//    on a best-effort basis.
//
// Neither present means the Worker is reachable without Access in front of it.
// That is a deployment mistake, and the only safe answer is to refuse: 503, not
// an anonymous session. A Worker that serves tools when its guard is missing is
// exactly the failure mode this file exists to prevent.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/** A group the identity provider reports the user in. */
export interface AccessGroup {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
}

/**
 * The identity Access hands the Worker. Mirrors CloudflareAccessIdentity from
 * the Workers runtime types; declared here so this module compiles against
 * @types/node alone, without the Workers globals.
 */
export interface AccessIdentity {
  readonly email: string;
  readonly name?: string;
  readonly user_uuid?: string;
  readonly groups?: readonly AccessGroup[];
  readonly idp?: { readonly id?: string; readonly type?: string };
  readonly [claim: string]: unknown;
}

/** The slice of the Workers ExecutionContext this module reads. */
export interface AccessContext {
  readonly access?:
    | {
        readonly aud?: string;
        getIdentity(): Promise<AccessIdentity | undefined>;
      }
    | undefined;
}

/** Bindings the fallback path reads. */
export interface AccessEnv {
  readonly ACCESS_TEAM_DOMAIN?: unknown;
  readonly ACCESS_AUD?: unknown;
  readonly [binding: string]: unknown;
}

export type Authentication =
  | {
      readonly ok: true;
      readonly identity: AccessIdentity;
      readonly aud: string | undefined;
      readonly source: 'worker-binding' | 'jwt-assertion';
    }
  | { readonly ok: false; readonly response: Response };

const ASSERTION_HEADER = 'cf-access-jwt-assertion';

/** One JWKS fetcher per team domain for the life of the isolate; jose caches keys inside it. */
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function refuse(status: number, error: string, message: string, service: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (status === 401) headers['www-authenticate'] = `Bearer realm="${service}"`;
  return new Response(JSON.stringify({ error, message }), { status, headers });
}

function stringBinding(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The team domain as an issuer URL. Accepts "divergeit", "divergeit.cloudflareaccess.com"
 * or the full https URL, because operators paste whichever one the dashboard showed them.
 */
export function teamIssuer(teamDomain: string): string {
  const bare = teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const host = bare.includes('.') ? bare : `${bare}.cloudflareaccess.com`;
  return `https://${host}`;
}

async function verifyAssertion(
  token: string,
  issuer: string,
  audience: string,
): Promise<JWTPayload> {
  let jwks = jwksByIssuer.get(issuer);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, audience, algorithms: ['RS256'] });
  return payload;
}

/**
 * Groups and the rest of the identity, from the Access identity endpoint. The
 * JWT alone carries no group membership. Best effort: a failure here degrades
 * to an identity without groups, which the entitlement layer treats as the
 * most restrictive case.
 */
async function fetchIdentity(issuer: string, token: string): Promise<Partial<AccessIdentity> | undefined> {
  try {
    const response = await fetch(`${issuer}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<AccessIdentity>;
    return typeof body === 'object' && body !== null ? body : undefined;
  } catch {
    return undefined;
  }
}

function groupsFrom(value: unknown): readonly AccessGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: AccessGroup[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const name = typeof record['name'] === 'string' ? record['name'] : id;
    if (id === '' && name === '') continue;
    const group: AccessGroup = typeof record['email'] === 'string'
      ? { id, name, email: record['email'] }
      : { id, name };
    groups.push(group);
  }
  return groups;
}

/**
 * Resolve the caller. `service` only labels the WWW-Authenticate realm and the
 * error bodies.
 */
export async function authenticate(
  request: Request,
  env: AccessEnv,
  ctx: AccessContext | undefined,
  service: string,
): Promise<Authentication> {
  // Path 1: Access for Workers.
  const binding = ctx?.access;
  if (binding !== undefined && binding !== null && typeof binding.getIdentity === 'function') {
    const identity = await binding.getIdentity();
    if (identity === undefined || typeof identity.email !== 'string' || identity.email === '') {
      return {
        ok: false,
        response: refuse(
          401,
          'unauthenticated',
          'Cloudflare Access did not authenticate this request. Sign in through the Access application in front of this server.',
          service,
        ),
      };
    }
    return { ok: true, identity, aud: binding.aud, source: 'worker-binding' };
  }

  // Path 2: a classic self-hosted Access application on the hostname.
  const assertion = request.headers.get(ASSERTION_HEADER);
  if (assertion !== null && assertion !== '') {
    const teamDomain = stringBinding(env.ACCESS_TEAM_DOMAIN);
    const aud = stringBinding(env.ACCESS_AUD);
    if (teamDomain === undefined || aud === undefined) {
      return {
        ok: false,
        response: refuse(
          503,
          'misconfigured',
          'An Access assertion arrived but ACCESS_TEAM_DOMAIN and ACCESS_AUD are not both set, so it cannot be verified. Set both vars, or put the Access application on the Worker itself.',
          service,
        ),
      };
    }
    const issuer = teamIssuer(teamDomain);
    let claims: JWTPayload;
    try {
      claims = await verifyAssertion(assertion, issuer, aud);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        response: refuse(401, 'invalid_assertion', `The Access assertion did not verify: ${detail}`, service),
      };
    }
    const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
    if (email === undefined || email === '') {
      return {
        ok: false,
        response: refuse(
          401,
          'no_email',
          'The Access assertion carries no email claim. Service tokens are not accepted by this server.',
          service,
        ),
      };
    }
    const extra = (await fetchIdentity(issuer, assertion)) ?? {};
    const identity: AccessIdentity = {
      ...extra,
      email,
      groups: groupsFrom(extra.groups),
      ...(typeof claims['sub'] === 'string' ? { user_uuid: claims['sub'] } : {}),
    };
    return { ok: true, identity, aud, source: 'jwt-assertion' };
  }

  // Neither: the Worker is exposed without Access. Fail closed.
  return {
    ok: false,
    response: refuse(
      503,
      'not_behind_access',
      'This Worker is not behind Cloudflare Access. Create an Access application for it (scripts/access-app.mjs) before using it; it refuses to serve unauthenticated requests.',
      service,
    ),
  };
}
