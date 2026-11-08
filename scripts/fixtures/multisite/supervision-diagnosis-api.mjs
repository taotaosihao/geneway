import { start } from '../../../src/server.mjs'

const upstream = new URL(process.env.GENEWAY_DIAGNOSIS_FIXTURE_UPSTREAM)
if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.pathname !== '/v1' || upstream.username || upstream.password || upstream.search || upstream.hash) throw Error('Probe model provider must be the explicit loopback /v1 fixture')
await start({ modelGatewayOptions: { upstreamBaseUrl: upstream.href } })
