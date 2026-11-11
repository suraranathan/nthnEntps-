import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkServerIdentity } from 'node:tls'
import { publicAddress } from '../ai/endpoint-policy.ts'
import { publicHttpsRequest, validatePublicUrl } from './research.ts'

const RELEASE_API = 'https://api.github.com/repos/suraranathan/nthnEntps-/releases/latest'
const RELEASE_ASSETS = 'https://github.com/suraranathan/nthnEntps-/releases/download/'
const MAX_APK_BYTES = 250_000_000

export interface NthnRelease { version: string; apkName: string; apkUrl: string; checksumUrl: string; apkAssetUrl?: string; checksumAssetUrl?: string; size: number }
type DownloadResult = { bytes: number; sha256: string }
type Dependencies = {
  fetchText?: (url: URL) => Promise<string>
  download?: (url: URL, file: string) => Promise<DownloadResult>
  token?: string
}

export function releaseHeaders(url: URL, token?: string): Record<string, string> {
  const assetApi = /^\/repos\/suraranathan\/nthnEntps-\/releases\/assets\/\d+$/.test(url.pathname)
  const trustedApi = url.origin === 'https://api.github.com' &&
    (url.pathname === '/repos/suraranathan/nthnEntps-/releases/latest' || assetApi)
  return {
    Accept: assetApi ? 'application/octet-stream' : 'application/vnd.github+json',
    ...(trustedApi && token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function validAssetUrl(value: unknown, tag: string, name: string): string {
  if (typeof value !== 'string') throw new Error('Release asset URL is missing.')
  const url = validatePublicUrl(value)
  if (url.href !== `${RELEASE_ASSETS}${tag}/${name}`) throw new Error('Release asset URL is not trusted.')
  return url.href
}

function validAssetApiUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Invalid GitHub asset API URL.')
  const url = validatePublicUrl(value)
  if (url.origin !== 'https://api.github.com' || !/^\/repos\/suraranathan\/nthnEntps-\/releases\/assets\/\d+$/.test(url.pathname) || url.search) throw new Error('Invalid GitHub asset API URL.')
  return url.href
}

export function parseRelease(input: unknown): NthnRelease {
  if (!input || typeof input !== 'object') throw new Error('Invalid release metadata.')
  const data = input as Record<string, unknown>
  const tag = data.tag_name
  if (typeof tag !== 'string' || !/^v\d+(?:\.\d+){0,2}$/.test(tag)) throw new Error('Invalid NTHN release tag.')
  if (!Array.isArray(data.assets)) throw new Error('Release assets are missing.')
  const version = tag.slice(1), apkName = `nthn-V${version}.apk`, checksumName = `nthn-V${version}.sha256`
  const apk = data.assets.find((asset: any) => asset?.name === apkName) as Record<string, unknown> | undefined
  const checksum = data.assets.find((asset: any) => asset?.name === checksumName) as Record<string, unknown> | undefined
  if (!apk || !checksum || !Number.isInteger(apk.size) || Number(apk.size) < 1 || Number(apk.size) > MAX_APK_BYTES ||
    !Number.isInteger(checksum.size) || Number(checksum.size) < 1 || Number(checksum.size) > 1024) throw new Error('Release APK or checksum is missing or too large.')
  const apkAssetUrl = validAssetApiUrl(apk.url), checksumAssetUrl = validAssetApiUrl(checksum.url)
  return { version, apkName, apkUrl: validAssetUrl(apk.browser_download_url, tag, apkName),
    checksumUrl: validAssetUrl(checksum.browser_download_url, tag, checksumName),
    ...(apkAssetUrl ? { apkAssetUrl } : {}), ...(checksumAssetUrl ? { checksumAssetUrl } : {}), size: Number(apk.size) }
}

export function parseChecksum(value: string, apkName: string): string {
  const lines = value.trim().split(/\r?\n/)
  if (lines.length !== 1) throw new Error('Invalid APK checksum file.')
  const match = /^([a-f0-9]{64})\s+\*?([^\s]+)$/i.exec(lines[0])
  if (!match || match[2] !== apkName) throw new Error('APK checksum filename does not match the release.')
  return match[1].toLowerCase()
}

function newer(candidate: string, current: string): boolean {
  const parts = (value: string) => value.split('.').map(Number)
  if (!/^\d+(?:\.\d+){0,2}$/.test(current)) throw new Error('Current NTHN version is invalid.')
  const a = parts(candidate), b = parts(current)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta) return delta > 0
  }
  return false
}

async function fetchReleaseText(url: URL, token?: string): Promise<string> {
  let current = validatePublicUrl(url.href)
  for (let index = 0; index < 4; index += 1) {
    const response = await publicHttpsRequest(current, new AbortController().signal, releaseHeaders(current, token))
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) throw new Error('Release redirect has no destination.')
      current = validatePublicUrl(new URL(response.headers.location, current).href)
      continue
    }
    if (response.status === 404 && !token) throw new Error('Private NTHN releases require a GitHub read token.')
    if (response.status !== 200) throw new Error(`Release request failed (HTTP ${response.status}).`)
    return response.body
  }
  throw new Error('Too many release redirects.')
}

async function downloadOnce(url: URL, file: string, token?: string): Promise<DownloadResult | { redirect: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Release download address is not public.')
  const address = addresses[0]
  return await new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: address.address, family: address.family, port: 443, path: url.pathname + url.search,
      method: 'GET', agent: false, maxHeaderSize: 16_384, rejectUnauthorized: true,
      ...(isIP(host) ? {} : { servername: host }), checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
      headers: { Host: url.host, ...releaseHeaders(url, token), 'Accept-Encoding': 'identity', 'User-Agent': 'NTHN-Jef/1.9' },
    }, response => {
      const status = response.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location
        response.resume()
        if (!location) reject(new Error('Release redirect has no destination.'))
        else resolve({ redirect: location })
        return
      }
      if (status !== 200) { response.resume(); reject(new Error(`APK download failed (HTTP ${status}).`)); return }
      let bytes = 0
      const hash = createHash('sha256')
      const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > MAX_APK_BYTES) { callback(new Error('APK download exceeds size limit.')); return }
        hash.update(chunk)
        callback(null, chunk)
      } })
      void pipeline(response, guard, createWriteStream(file, { mode: 0o600, flags: 'wx' }))
        .then(() => resolve({ bytes, sha256: hash.digest('hex') })).catch(reject)
    })
    req.setTimeout(30_000, () => req.destroy(new Error('APK download timed out.')))
    req.on('error', reject)
    req.end()
  })
}

export async function downloadPublicApk(url: URL, file: string, token?: string): Promise<DownloadResult> {
  let current = validatePublicUrl(url.href)
  for (let index = 0; index < 4; index += 1) {
    const result = await downloadOnce(current, file, token)
    if ('redirect' in result) { current = validatePublicUrl(new URL(result.redirect, current).href); continue }
    return result
  }
  throw new Error('Too many APK download redirects.')
}

export class ReleaseUpdateService {
  private readonly fetchText: (url: URL) => Promise<string>
  private readonly downloadFile: (url: URL, file: string) => Promise<DownloadResult>
  private readonly token?: string

  constructor(dependencies: Dependencies = {}) {
    this.token = dependencies.token
    this.fetchText = dependencies.fetchText ?? (url => fetchReleaseText(url, this.token))
    this.downloadFile = dependencies.download ?? ((url, file) => downloadPublicApk(url, file, this.token))
  }

  async check(currentVersion: string): Promise<NthnRelease | null> {
    const raw = await this.fetchText(new URL(RELEASE_API))
    let metadata: unknown
    try { metadata = JSON.parse(raw) } catch { throw new Error('Release service returned invalid JSON.') }
    const release = parseRelease(metadata)
    return newer(release.version, currentVersion) ? release : null
  }

  async download(release: NthnRelease, directory: string): Promise<{ path: string; sha256: string; bytes: number }> {
    const validated = parseRelease({ tag_name: `v${release.version}`, assets: [
      { name: release.apkName, browser_download_url: release.apkUrl, url: release.apkAssetUrl, size: release.size },
      { name: `nthn-V${release.version}.sha256`, browser_download_url: release.checksumUrl, url: release.checksumAssetUrl, size: 80 },
    ] })
    const checksum = parseChecksum(await this.fetchText(new URL(this.token && validated.checksumAssetUrl ? validated.checksumAssetUrl : validated.checksumUrl)), validated.apkName)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${validated.apkName}.${randomUUID()}.tmp`)
    const target = join(directory, validated.apkName)
    try {
      const result = await this.downloadFile(new URL(this.token && validated.apkAssetUrl ? validated.apkAssetUrl : validated.apkUrl), temporary)
      if (result.bytes !== validated.size || result.sha256.toLowerCase() !== checksum) throw new Error('Downloaded APK size or SHA-256 does not match the release.')
      await rename(temporary, target)
      return { path: target, sha256: checksum, bytes: result.bytes }
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
  }
}
