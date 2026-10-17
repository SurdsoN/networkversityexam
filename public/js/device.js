// Device identification for the attempt limit.
//   Device.id()          the device ID the server issued, kept in localStorage
//                        (the server also keeps it in an HttpOnly cookie)
//   Device.fingerprint() a hash of stable browser, screen and hardware traits,
//                        so a device can still be recognised on the same
//                        network after its storage was cleared
window.Device = (() => {
  const KEY = 'nv_device_id';

  function id() {
    try { return localStorage.getItem(KEY); } catch { return null; }
  }

  function remember(deviceId) {
    try { if (deviceId) localStorage.setItem(KEY, deviceId); } catch { /* private mode */ }
  }

  // 2 x 32-bit string hash (cyrb53-style), returned as 16 hex characters.
  function hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function canvasTrait() {
    try {
      const c = document.createElement('canvas');
      c.width = 220;
      c.height = 40;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '16px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(100, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Networkversity ✓ 2026', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('Networkversity ✓ 2026', 4, 17);
      return hash(c.toDataURL());
    } catch {
      return '';
    }
  }

  function webglTrait() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext
        ? `${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}|${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}`
        : `${gl.getParameter(gl.VENDOR)}|${gl.getParameter(gl.RENDERER)}`;
    } catch {
      return '';
    }
  }

  let cached;
  function fingerprint() {
    if (cached) return cached;
    const n = navigator;
    const s = window.screen || {};
    const traits = [
      // Keep only major browser versions so routine updates don't change it.
      (n.userAgent || '').replace(/(\d+)(\.\d+)+/g, '$1'),
      n.language,
      (n.languages || []).join(','),
      n.platform,
      n.hardwareConcurrency,
      n.deviceMemory,
      n.maxTouchPoints,
      [s.width, s.height].sort((a, b) => a - b).join('x'), // same either way the phone is held
      s.colorDepth,
      window.devicePixelRatio,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      canvasTrait(),
      webglTrait(),
    ];
    cached = hash(traits.join('||'));
    return cached;
  }

  function headers() {
    const h = { 'X-Device-Fp': fingerprint() };
    const d = id();
    if (d) h['X-Device-Id'] = d;
    return h;
  }

  return { id, remember, fingerprint, headers };
})();
