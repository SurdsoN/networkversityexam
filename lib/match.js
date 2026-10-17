// A student is recognised by their browser's device ID or, if that was
// cleared, by the same IP address together with the same device fingerprint.
// IP alone never matches: many phones share one public IP on mobile networks.
// (lib/store-pg.js has the same rule as SQL.)
export function matchesStudent(attempt, { ip, deviceId, fingerprint }) {
  if (deviceId && attempt.deviceId === deviceId) return true;
  return Boolean(fingerprint && attempt.fingerprint === fingerprint && attempt.ip === ip);
}

// An attempt without its question snapshot and answers.
export function summaryOf(attempt) {
  const { questions, answers, currentIndex, ...summary } = attempt;
  return summary;
}
