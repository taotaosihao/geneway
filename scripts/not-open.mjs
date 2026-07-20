const message = process.argv[2] ?? 'This gate is not open';
console.error(`NOT_OPEN: ${message}`);
process.exit(64);
