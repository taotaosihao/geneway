import { isAbsolute } from 'node:path';

export function modelGatewayWorkerEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const urlValue = environment.GENEWAY_MODEL_GATEWAY_URL;
  const serviceTokenFile = environment.GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE;
  const gateALiveEnabled = environment.GENEWAY_GATE_A_LIVE_ENABLED;
  if (gateALiveEnabled !== undefined && gateALiveEnabled !== '1') {
    throw new Error('E2E Worker Gate A live flag must be 1 when configured');
  }
  if ((urlValue === undefined) !== (serviceTokenFile === undefined)) {
    throw new Error('E2E Worker Model Gateway URL and service token file must be configured together');
  }
  if (gateALiveEnabled === '1' && (urlValue === undefined || serviceTokenFile === undefined)) {
    throw new Error('E2E Worker Gate A live requires loopback Model Gateway authority');
  }
  if (urlValue === undefined || serviceTokenFile === undefined) return {};
  const url = new URL(urlValue);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('E2E Worker Model Gateway must be an unauthenticated loopback HTTP origin');
  }
  if (!isAbsolute(serviceTokenFile) || serviceTokenFile.includes('\0')) {
    throw new Error('E2E Worker Model Gateway service token file path must be absolute');
  }
  return {
    GENEWAY_MODEL_GATEWAY_URL: urlValue,
    GENEWAY_MODEL_GATEWAY_SERVICE_TOKEN_FILE: serviceTokenFile,
    ...(gateALiveEnabled === '1' ? { GENEWAY_GATE_A_LIVE_ENABLED: '1' } : {}),
  };
}
