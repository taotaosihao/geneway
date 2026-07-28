export function servedTaskTerminalFailure(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  if (snapshot.status === 'canceled') return Object.freeze({ status: 'canceled', code: 'TASK_CANCELED' });
  if (snapshot.status !== 'failed' || snapshot.result === null || typeof snapshot.result !== 'object'
    || Array.isArray(snapshot.result) || snapshot.result.kind !== 'failed'
    || typeof snapshot.result.code !== 'string' || snapshot.result.code.length === 0) return null;
  return Object.freeze({ status: 'failed', code: snapshot.result.code });
}

export function gateA3TaskSqlLiteral(taskId) {
  if (typeof taskId !== 'string' || !/^task_[A-Za-z0-9._:-]+$/u.test(taskId)) {
    throw new Error('Gate A.3 database oracle task ID is invalid');
  }
  return `'${taskId}'`;
}

export function assertNoSensitiveWorkOrderProjection({ visibleText, serializedDom }) {
  if (typeof visibleText !== 'string' || typeof serializedDom !== 'string') {
    throw new Error('Gate A.3 public projection surfaces are invalid');
  }
  const visibleMaterial = [
    ['endpoint', /\bendpoint\b/iu],
    ['profile', /\bprofile\b/iu],
    ['credential', /\bcredential\b/iu],
    ['receipt', /\breceipt\b/iu],
    ['raw receipt', /raw[\s_-]*receipt/iu],
    ['internal connector', /internal[\s_-]*connector/iu],
    ['connector invocation', /connector[\s_-]*invocation/iu],
    ['Connector Gateway', /connector[\s_-]*gateway/iu],
  ];
  const serializedMaterial = [
    ['GearJob endpoint', /\/api\/method\/gearjob/iu],
    ['Bearer credential', /bearer(?:\s|&nbsp;|&#x20;)+[A-Za-z0-9._~+/-]{8,}/iu],
    ['API credential assignment', /api[\s_-]*(?:key|secret)(?:\s|&nbsp;|&#x20;)*(?::|=)(?:\s|&nbsp;|&#x20;)*[^\s<"']+/iu],
    ['Authorization assignment', /authorization(?:\s|&nbsp;|&#x20;)*(?::|=)(?:\s|&nbsp;|&#x20;)*[^\s<"']+/iu],
  ];
  const observed = [
    ...visibleMaterial.filter(([, pattern]) => pattern.test(visibleText)).map(([label]) => label),
    ...serializedMaterial.filter(([, pattern]) => pattern.test(serializedDom)).map(([label]) => label),
  ];
  if (observed.length > 0) {
    throw new Error(`served Work Order projection exposed forbidden internal material: ${observed.join(', ')}`);
  }
}
