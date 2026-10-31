/** Convert checkout line endings to stable LF bytes for generated package hashes. */
export function canonicalSourceBytes(source) {
  if (typeof source !== 'string') throw new TypeError('source must be text');
  return Buffer.from(source.replace(/\r\n/g, '\n'), 'utf8');
}
