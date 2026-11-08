// Same D4 driver and wire experiments, now starting at the real independent peer.
process.env.GENEWAY_PROTOCOL_BUSINESS_ENTRY='1';
await import('./normal-flow.mjs');
