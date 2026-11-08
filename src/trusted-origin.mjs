// One configured public origin governs browser authority; forwarded headers do not.
export function normalizeTrustedOrigin(value) {
  if (typeof value !== 'string' || /\s/.test(value) || !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(value)) throw new Error('GENEWAY_TRUSTED_ORIGIN 必须是无路径、凭据或查询的可信入口')
  let url
  try { url = new URL(value) } catch { throw new Error('GENEWAY_TRUSTED_ORIGIN URL 无效') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || value.slice(value.indexOf('://') + 3).includes('@') || url.pathname !== '/' || url.search || url.hash || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('GENEWAY_TRUSTED_ORIGIN 仅支持 HTTPS 或 loopback HTTP 根入口')
  return url.origin
}
