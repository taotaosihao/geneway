const fullDockerIdPattern = /^[a-f0-9]{64}$/u;
const decimalNanoPattern = /^(?:0|[1-9][0-9]*)$/u;
const containerActions = new Set(['create', 'start', 'die', 'destroy']);
const networkActions = new Set(['create', 'connect', 'disconnect', 'destroy']);

function rejected(reason) {
  return Object.freeze({
    schemaVersion: 'geneway-gate02b-docker-teardown-proof/1',
    checked: true,
    passed: false,
    reason,
  });
}

function fullDockerId(value) {
  return typeof value === 'string' && fullDockerIdPattern.test(value);
}

function exactDecimalNano(value) {
  return typeof value === 'string' && decimalNanoPattern.test(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sameTarget(binding, container, targetNetwork) {
  return binding !== null && typeof binding === 'object'
    && binding.containerId === container.id
    && binding.project === container.project
    && binding.service === container.service
    && binding.networkId === targetNetwork.id
    && binding.networkName === targetNetwork.name;
}

function validateProxyReceipt(proxyReceipt, container, targetNetwork) {
  if (proxyReceipt === null || typeof proxyReceipt !== 'object'
    || proxyReceipt.intrinsicValid !== true
    || !sameTarget(proxyReceipt.target, container, targetNetwork)
    || !sameTarget(proxyReceipt.finalBinding, container, targetNetwork)
    || proxyReceipt.finalBinding.running !== true) return false;
  const rawGuard = proxyReceipt.rawGuard;
  return rawGuard !== null && typeof rawGuard === 'object' && rawGuard.passed === true
    && Array.isArray(rawGuard.unexpected) && rawGuard.unexpected.length === 0
    && Array.isArray(rawGuard.unknownLines) && rawGuard.unknownLines.length === 0;
}

function validateManifest(manifest, container) {
  if (manifest?.schemaVersion === 'geneway-gate02b-backup-invocation/1') {
    if (!Array.isArray(manifest.projects) || !Array.isArray(manifest.networks)
      || manifest.projects.length !== 2 || manifest.networks.length !== 2
      || !['postgres', 'versitygw'].includes(container.service)) return null;
    const matches = manifest.projects.flatMap((project, index) => project === container.project
      && manifest.networks[index] === `${project}_default` ? [manifest.networks[index]] : []);
    if (matches.length !== 1 || new Set(manifest.projects).size !== 2 || new Set(manifest.networks).size !== 2) return null;
    return { allowedNetworkNames: new Set(manifest.networks), targetNetworkName: matches[0] };
  }
  if (manifest === null || typeof manifest !== 'object'
    || manifest.schemaVersion !== 'geneway-gate02b-storage-invocation/1'
    || manifest.project !== container.project
    || manifest.networks === null || typeof manifest.networks !== 'object' || Array.isArray(manifest.networks)
    || !Array.isArray(manifest.services)) return null;

  const networkEntries = Object.entries(manifest.networks);
  if (networkEntries.length === 0 || networkEntries.some(([alias, name]) => !nonEmptyString(alias) || !nonEmptyString(name))) return null;
  const networkNames = networkEntries.map(([, name]) => name);
  if (new Set(networkNames).size !== networkNames.length) return null;

  const services = manifest.services.filter((service) => service !== null && typeof service === 'object'
    && service.name === container.service);
  const runtimeServices = Array.isArray(manifest.runtimeServices) ? manifest.runtimeServices.filter((service) =>
    service !== null && typeof service === 'object' && service.name === container.service) : [];
  if (services.length > 1 || runtimeServices.length > 1 || (services.length === 0 && runtimeServices.length === 0)) return null;
  const service = services[0] ?? runtimeServices[0];
  if (!nonEmptyString(service.network) || !Object.hasOwn(manifest.networks, service.network)
    || (services.length === 1 && service.stem !== `${container.project}-${container.service}`)) return null;
  return {
    allowedNetworkNames: new Set(networkNames),
    targetNetworkName: manifest.networks[service.network],
  };
}

function validateEventShape(event) {
  if (event === null || typeof event !== 'object'
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1
    || !exactDecimalNano(event.timeNano)
    || !['container', 'network'].includes(event.type)) return false;
  if (event.type === 'container') {
    return containerActions.has(event.action) && fullDockerId(event.actorId)
      && event.containerId === event.actorId && nonEmptyString(event.containerName)
      && nonEmptyString(event.project);
  }
  if (!networkActions.has(event.action) || !fullDockerId(event.actorId)
    || event.networkId !== event.actorId || !nonEmptyString(event.networkName)) return false;
  if (['connect', 'disconnect'].includes(event.action)) {
    return fullDockerId(event.containerId)
      && (event.containerName === null || nonEmptyString(event.containerName))
      && (event.project === null || nonEmptyString(event.project));
  }
  return event.containerId === null && event.containerName === null
    && (event.project === null || nonEmptyString(event.project));
}

function strictEventOrder(events) {
  for (let index = 0; index < events.length; index += 1) {
    if (!validateEventShape(events[index])) return false;
    if (index > 0 && events[index - 1].sequence >= events[index].sequence) return false;
  }
  return true;
}

function strictSequenceOrder(events) {
  return events.every((event, index) => Number.isSafeInteger(event?.sequence) && event.sequence >= 1
    && (index === 0 || events[index - 1].sequence < event.sequence));
}

function relevantToContainer(event, container) {
  return event.containerId === container.id;
}

function eventIdentityConflicts(event, container) {
  if (event.type === 'container') {
    const claimsIdentity = event.containerId === container.id || event.containerName === container.name;
    if (!claimsIdentity) return false;
    return event.containerId !== container.id || event.containerName !== container.name
      || event.project !== container.project;
  }
  if (event.containerId !== container.id && event.containerName !== container.name) return false;
  return event.containerId !== container.id
    || (event.containerName !== null && event.containerName !== container.name)
    || (event.project !== null && event.project !== container.project);
}

/**
 * Builds a fail-closed receipt from already captured Docker evidence. The function
 * performs no I/O and treats the invocation manifest only as an allowlist; it is
 * never a substitute for a disconnect event plus an inspected network.
 */
export function dockerTeardownProofReceipt(input) {
  if (input === null || typeof input !== 'object') return rejected('INPUT_INVALID');
  const { container, lifecycleEvents, inspectedNetworks, invocationManifest } = input;
  if (container === null || typeof container !== 'object' || !fullDockerId(container.id)
    || !nonEmptyString(container.name) || !nonEmptyString(container.project) || !nonEmptyString(container.service)) {
    return rejected('CONTAINER_IDENTITY_INVALID');
  }

  const manifest = validateManifest(invocationManifest, container);
  if (manifest === null) return rejected('INVOCATION_MANIFEST_INVALID');
  if (!Array.isArray(lifecycleEvents) || lifecycleEvents.length === 0) return rejected('LIFECYCLE_EVENTS_MISSING');
  if (!strictSequenceOrder(lifecycleEvents)) return rejected('LIFECYCLE_EVENT_ORDER_INVALID');
  if (lifecycleEvents.some((event) => eventIdentityConflicts(event, container))) {
    return rejected('CONTAINER_EVENT_IDENTITY_CONFLICT');
  }

  const events = lifecycleEvents.filter((event) => relevantToContainer(event, container));
  if (!strictEventOrder(events)) return rejected('LIFECYCLE_EVENT_SHAPE_INVALID');
  if (events.some((event, index) => index > 0
    && BigInt(events[index - 1].timeNano) >= BigInt(event.timeNano))) {
    return rejected('CONTAINER_EVENT_TIME_ORDER_INVALID');
  }
  const disconnects = events.filter((event) => event.type === 'network' && event.action === 'disconnect');
  const dies = events.filter((event) => event.type === 'container' && event.action === 'die');
  const destroys = events.filter((event) => event.type === 'container' && event.action === 'destroy');
  if (disconnects.length === 0) return rejected('DISCONNECT_EVENT_MISSING');
  if (dies.length !== 1) return rejected('DIE_EVENT_CARDINALITY_INVALID');
  if (destroys.length !== 1) return rejected('DESTROY_EVENT_CARDINALITY_INVALID');

  const die = dies[0];
  const destroy = destroys[0];
  if (disconnects.some((event) => event.sequence >= die.sequence || BigInt(event.timeNano) >= BigInt(die.timeNano))) {
    return rejected('DISCONNECT_NOT_BEFORE_DIE');
  }
  if (die.sequence >= destroy.sequence || BigInt(die.timeNano) >= BigInt(destroy.timeNano)) {
    return rejected('DIE_NOT_BEFORE_DESTROY');
  }
  const firstDisconnect = disconnects[0];
  if (events.some((event) => event.type === 'network' && event.action === 'connect'
    && event.sequence > firstDisconnect.sequence && event.sequence < destroy.sequence)) {
    return rejected('RECONNECT_DURING_TEARDOWN');
  }
  if (events.some((event) => event.sequence > destroy.sequence)) return rejected('POST_DESTROY_ACTIVITY');

  if (!Array.isArray(inspectedNetworks)) return rejected('INSPECTED_NETWORKS_MISSING');
  const disconnectedNetworks = [];
  for (const event of disconnects) {
    if (!manifest.allowedNetworkNames.has(event.networkName)) return rejected('DISCONNECT_NETWORK_NOT_IN_MANIFEST');
    const matches = inspectedNetworks.filter((network) => network !== null && typeof network === 'object'
      && network.id === event.networkId && network.name === event.networkName);
    if (matches.length !== 1) return rejected('DISCONNECT_NETWORK_INSPECT_MISSING_OR_CONFLICTING');
    const network = matches[0];
    if (!fullDockerId(network.id) || (network.inspectObserved !== true && network.artifactProofObserved !== true)
      || network.internal !== true
      || network.driver !== 'bridge' || network.project !== container.project || network.identityConflict !== false) {
      return rejected('DISCONNECT_NETWORK_NOT_EXACT_INTERNAL_BRIDGE');
    }
    disconnectedNetworks.push({ id: network.id, name: network.name });
  }

  const targetMatches = disconnectedNetworks.filter((network) => network.name === manifest.targetNetworkName);
  if (targetMatches.length === 0) return rejected('TARGET_NETWORK_DISCONNECT_MISSING');
  const targetIds = new Set(targetMatches.map((network) => network.id));
  if (targetIds.size !== 1) return rejected('TARGET_NETWORK_IDENTITY_CONFLICT');
  const targetNetwork = { id: targetMatches[0].id, name: manifest.targetNetworkName };

  const proxyBacked = input.proxyBacked === true;
  if (input.proxyBacked !== undefined && typeof input.proxyBacked !== 'boolean') return rejected('PROXY_MODE_INVALID');
  if (proxyBacked && !validateProxyReceipt(input.proxyReceipt, container, targetNetwork)) {
    return rejected('PROXY_RECEIPT_INVALID');
  }
  if (!proxyBacked && input.proxyReceipt !== undefined && input.proxyReceipt !== null) {
    return rejected('PROXY_RECEIPT_UNEXPECTED');
  }

  return Object.freeze({
    schemaVersion: 'geneway-gate02b-docker-teardown-proof/1',
    checked: true,
    passed: true,
    reason: 'ORDERED_DOCKER_TEARDOWN_PROVEN',
    container: Object.freeze({ id: container.id, name: container.name, project: container.project, service: container.service }),
    targetNetwork: Object.freeze(targetNetwork),
    disconnectedNetworks: Object.freeze(disconnectedNetworks.map((network) => Object.freeze(network))),
    eventOrder: Object.freeze({
      disconnects: Object.freeze(disconnects.map((event) => Object.freeze({ sequence: event.sequence, timeNano: event.timeNano,
        networkId: event.networkId, networkName: event.networkName }))),
      die: Object.freeze({ sequence: die.sequence, timeNano: die.timeNano }),
      destroy: Object.freeze({ sequence: destroy.sequence, timeNano: destroy.timeNano }),
    }),
    proxyBacked,
  });
}
