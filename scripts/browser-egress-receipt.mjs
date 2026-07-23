import { createHash } from 'node:crypto';

const identityKey = (pid, startTicks) => `${String(pid)}:${startTicks}`;

export function browserEgressPolicyHash(runId, webPort, guardLibrarySha256, browserExecutables) {
  return createHash('sha256').update(JSON.stringify({
    runId, webPort, browserGuardLibrarySha256: guardLibrarySha256, browserExecutables,
  })).digest('hex');
}

export function parseBrowserEgressReceipt(rawText, expected) {
  const lines = rawText.trim().split('\n').filter(Boolean);
  const starts = new Map();
  const kernels = new Map();
  const children = new Map();
  const events = [];
  const unknownLines = [];
  const identityConflicts = [];
  const storeIdentity = (map, key, value, line) => {
    const previous = map.get(key);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) identityConflicts.push(line);
    else map.set(key, value);
  };
  for (const line of lines) {
    const start = line.match(/^START pid=([1-9][0-9]*) startTicks=([1-9][0-9]*) hostname=([A-Za-z0-9._-]+)$/u);
    if (start !== null) {
      const value = { pid: Number(start[1]), startTicks: start[2], hostname: start[3] };
      storeIdentity(starts, identityKey(value.pid, value.startTicks), value, line);
      continue;
    }
    const kernel = line.match(/^BROWSER_KERNEL pid=([1-9][0-9]*) ppid=([1-9][0-9]*) startTicks=([1-9][0-9]*) policyHash=([a-f0-9]{64}) exeDev=([1-9][0-9]*) exeIno=([1-9][0-9]*) guardDev=([1-9][0-9]*) guardIno=([1-9][0-9]*) status=ENFORCED landlockAbi=([4-9]|[1-9][0-9]+) tcp=allowlisted udp=blocked$/u);
    if (kernel !== null) {
      const value = {
        pid: Number(kernel[1]), ppid: Number(kernel[2]), startTicks: kernel[3], policyHash: kernel[4],
        executableDevice: Number(kernel[5]), executableInode: Number(kernel[6]),
        guardDevice: Number(kernel[7]), guardInode: Number(kernel[8]), landlockAbi: Number(kernel[9]),
      };
      storeIdentity(kernels, identityKey(value.pid, value.startTicks), value, line);
      continue;
    }
    const child = line.match(/^BROWSER_CHILD pid=([1-9][0-9]*) ppid=([1-9][0-9]*) startTicks=([1-9][0-9]*) inheritedFrom=([1-9][0-9]*) inheritedFromStartTicks=([1-9][0-9]*) kernel=inherited policyHash=([a-f0-9]{64})$/u);
    if (child !== null) {
      const value = {
        pid: Number(child[1]), ppid: Number(child[2]), startTicks: child[3], inheritedFrom: Number(child[4]),
        inheritedFromStartTicks: child[5], policyHash: child[6],
      };
      storeIdentity(children, identityKey(value.pid, value.startTicks), value, line);
      continue;
    }
    const event = line.match(/^BROWSER_EVENT pid=([1-9][0-9]*) ppid=([1-9][0-9]*) startTicks=([1-9][0-9]*) policyHash=([a-f0-9]{64}) fd=([0-9]+) (ALLOW|DENY) call=(connect|sendto|sendmsg|sendmmsg) (.+)$/u);
    if (event !== null) {
      const detail = event[8];
      const inet = detail.match(/^family=(2|10) address=([^ ]+) port=([0-9]+)(?: reason=[a-z-]+)?$/u);
      events.push({
        line, pid: Number(event[1]), ppid: Number(event[2]), startTicks: event[3], policyHash: event[4], fd: Number(event[5]),
        decision: event[6], call: event[7], detail, family: inet === null ? null : Number(inet[1]),
        address: inet?.[2] ?? null, port: inet === null ? null : Number(inet[3]),
      });
      continue;
    }
    unknownLines.push(line);
  }

  const kernelIdentityMatches = (kernel) => kernel.policyHash === expected.policyHash
    && expected.browserExecutableIdentities.some((identity) => identity.device === kernel.executableDevice
      && identity.inode === kernel.executableInode)
    && kernel.guardDevice === expected.guardLibraryDevice
    && kernel.guardInode === expected.guardLibraryInode
    && starts.has(identityKey(kernel.pid, kernel.startTicks));
  const enforcedIdentities = new Set([...kernels.values()].filter(kernelIdentityMatches)
    .map((kernel) => identityKey(kernel.pid, kernel.startTicks)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of children.values()) {
      const parentKey = identityKey(child.inheritedFrom, child.inheritedFromStartTicks);
      const childKey = identityKey(child.pid, child.startTicks);
      if (child.policyHash === expected.policyHash && child.ppid === child.inheritedFrom
        && enforcedIdentities.has(parentKey) && !enforcedIdentities.has(childKey)) {
        enforcedIdentities.add(childKey);
        changed = true;
      }
    }
  }
  const allowedAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const allowedNetworkEvents = events.filter((event) => event.decision === 'ALLOW' && event.port !== null);
  const unexpectedAllows = events.filter((event) => event.decision === 'ALLOW'
    && !(event.port === expected.webPort && allowedAddresses.has(event.address))
    && event.detail !== 'family=CONNECTED reason=kernel-guarded');
  const webAllows = allowedNetworkEvents.filter((event) => event.port === expected.webPort && allowedAddresses.has(event.address));
  const forbiddenDenials = events.filter((event) => event.decision === 'DENY' && event.call === 'connect'
    && event.port !== null && allowedAddresses.has(event.address));
  const deniedPorts = new Set(forbiddenDenials.map((event) => event.port));
  const missingDeniedPorts = expected.forbiddenPorts.filter((port) => !deniedPorts.has(port));
  const unboundEvents = events.filter((event) => event.policyHash !== expected.policyHash
    || !enforcedIdentities.has(identityKey(event.pid, event.startTicks)));
  const startsWithoutKernel = [...starts.values()].filter((start) => {
    const kernel = kernels.get(identityKey(start.pid, start.startTicks));
    return kernel === undefined || kernel.policyHash !== expected.policyHash;
  });
  const invalidKernelIdentities = [...kernels.values()].filter((kernel) => !kernelIdentityMatches(kernel));
  const orphanChildIdentities = [...children.values()].filter((child) => !enforcedIdentities.has(identityKey(child.pid, child.startTicks)));
  const sharedNetworkIdentities = [...new Set(webAllows.map((event) => identityKey(event.pid, event.startTicks)))]
    .filter((key) => {
      const [pid, startTicks] = key.split(':');
      return expected.forbiddenPorts.every((port) => forbiddenDenials.some((event) => event.pid === Number(pid)
        && event.startTicks === startTicks && event.port === port));
    });
  const conformancePassed = missingDeniedPorts.length === 0 && sharedNetworkIdentities.length > 0;
  const passed = lines.length > 0 && unknownLines.length === 0 && identityConflicts.length === 0
    && starts.size > 0 && startsWithoutKernel.length === 0 && invalidKernelIdentities.length === 0
    && orphanChildIdentities.length === 0
    && events.length > 0 && unboundEvents.length === 0 && unexpectedAllows.length === 0 && webAllows.length > 0
    && (expected.requireForbiddenDenials !== true || conformancePassed);
  return {
    schemaVersion: 'geneway-browser-egress-boundary/1',
    checked: true,
    passed,
    policyHash: expected.policyHash,
    lineCount: lines.length,
    rawSha256: createHash('sha256').update(rawText).digest('hex'),
    startIdentities: [...starts.values()],
    kernelIdentities: [...kernels.values()],
    childIdentities: [...children.values()],
    eventCount: events.length,
    webAllowCount: webAllows.length,
    deniedPorts: [...deniedPorts].sort((left, right) => left - right),
    missingDeniedPorts,
    unexpectedAllows: unexpectedAllows.map((event) => event.line),
    unboundEvents: unboundEvents.map((event) => event.line),
    startsWithoutKernel,
    invalidKernelIdentities,
    orphanChildIdentities,
    sharedNetworkIdentities,
    conformanceRequired: expected.requireForbiddenDenials === true,
    conformancePassed,
    unknownLines,
    identityConflicts,
  };
}
