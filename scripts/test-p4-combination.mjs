for (const script of ['test-p4-channel.mjs', 'test-p4-channel-work.mjs', 'test-p4-http-ui.mjs']) {
  await import(new URL(script, import.meta.url))
}

console.log('P4 local combination gate passed; real channel adapters and phone HTTPS remain external gates')
