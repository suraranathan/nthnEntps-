import { constants, openSync, readFileSync, closeSync, fstatSync, writeFileSync, fsyncSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ManagementError } from './management-types.ts'

export function readPrivateFile(path: string): Buffer {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (stat.size !== 32 || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('unsafe file')
    return readFileSync(fd)
  } catch { throw new ManagementError('KEY_UNAVAILABLE') }
  finally { if (fd !== undefined) closeSync(fd) }
}
export function createPrivateFile(path: string, data: Buffer) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
}
export class CredentialVault {
  #key: Buffer
  constructor(key: Buffer) {
    if (key.length !== 32) throw new ManagementError('KEY_UNAVAILABLE')
    this.#key = Buffer.from(key)
  }
  seal(value: string, context: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    cipher.setAAD(Buffer.from(`nthn-provider-v1:${context}`))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
  }
  open(sealed: string, context: string): string {
    try {
      const data = JSON.parse(sealed)
      if (data.version !== 1) throw new Error('unsupported cipher')
      const iv = Buffer.from(data.iv, 'base64'), tag = Buffer.from(data.tag, 'base64')
      if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid cipher')
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv)
      decipher.setAAD(Buffer.from(`nthn-provider-v1:${context}`)); decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8')
    } catch { throw new ManagementError('DECRYPT_FAILED') }
  }
  destroy() { this.#key.fill(0) }
}
