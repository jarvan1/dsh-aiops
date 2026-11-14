/**
 * Server-issued agent token generation and hashing.
 *
 * A token is 32 random bytes in base64url behind a fixed `dsha_` prefix. The
 * server persists only its SHA-256 digest and the last four characters; the
 * plaintext leaves the process exactly once, in the creation response. A token
 * identifies one cluster and has no rotation schedule — revoke and re-issue.
 *
 * @module @deepseek-ai/dsh-aiops-agents/src/tokens
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AGENT_TOKEN_PREFIX, isAgentToken } from './types.ts'

/** Generate one token and the two values the registry durably keeps. */
export function issueAgentToken(): { token: string; hash: string; last4: string } {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, hash: hashAgentToken(token), last4: token.slice(-4) }
}

/** SHA-256 hex digest of a presented token. */
export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Compare a presented digest with the stored one in constant time. A malformed
 * token never reaches this function with a surprising length, but the guard
 * keeps the comparison defined.
 */
export function digestMatches(presented: string, stored: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(presented) || !/^[a-f0-9]{64}$/.test(stored)) return false
  return timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(stored, 'hex'))
}

/** Extract a bearer token from an Authorization header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  return token !== undefined && isAgentToken(token) ? token : undefined
}
