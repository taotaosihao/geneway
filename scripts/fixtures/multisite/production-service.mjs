import { start } from '../../../src/server.mjs'
await start({ modelGatewayOptions: { upstreamBaseUrl: process.env.GENEWAY_FIXTURE_UPSTREAM } })
