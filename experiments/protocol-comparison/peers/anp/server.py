"""Boot the pinned independent AWiki server without importing any Geneway adapter."""
import json
import os
import sys
from pathlib import Path

config = json.loads(Path(sys.argv[1]).read_text())
root = Path(config['root'])
root.mkdir(parents=True, exist_ok=True)
from awiki_open_server.service_identity import generate_ed25519_private_key_pem
key = root / 'service-key.pem'
if not key.exists():
    key.write_text(generate_ed25519_private_key_pem())
    key.chmod(0o600)
os.environ.update({
    'AWIKI_DATA_DIR': str(root / 'data'),
    'AWIKI_PUBLIC_BASE_URL': config['origin'],
    'AWIKI_DID_DOMAIN': config['didDomain'],
    'AWIKI_SERVICE_DID': 'did:wba:' + config['didDomain'],
    'AWIKI_SERVICE_PRIVATE_KEY_PATH': str(key),
    'AWIKI_ALLOW_UNSIGNED_PEER_DEV': '0',
    'AWIKI_ENABLE_CONTACT_VERIFICATION_COMPAT': '0',
    'AWIKI_DID_RESOLVER_BASE_URLS': json.dumps(config['resolverBaseUrls']),
})
from awiki_open_server.app.main import create_app
import uvicorn

app = create_app()
class WireLog:
    def __init__(self, wrapped): self.wrapped = wrapped
    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.wrapped(scope, receive, send)
        request_chunks, response_chunks = [], []
        status = None
        async def incoming():
            message = await receive()
            if message['type'] == 'http.request': request_chunks.append(message.get('body', b''))
            return message
        async def outgoing(message):
            nonlocal status
            if message['type'] == 'http.response.start': status = message['status']
            if message['type'] == 'http.response.body': response_chunks.append(message.get('body', b''))
            await send(message)
        try:
            await self.wrapped(scope, incoming, outgoing)
        finally:
            import datetime
            row = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'method': scope['method'],
                   'path': scope['path'], 'query': scope.get('query_string', b'').decode(),
                   'headers': [[k.decode(), '[redacted]' if k.lower() in (b'authorization', b'cookie') else v.decode()] for k, v in scope['headers']],
                   'requestBody': b''.join(request_chunks).decode('utf8', errors='replace'),
                   'status': status, 'responseBody': b''.join(response_chunks).decode('utf8', errors='replace')}
            with (root / 'wire.jsonl').open('a') as log: log.write(json.dumps(row, ensure_ascii=False) + '\n')
uvicorn.run(WireLog(app), host=config['host'], port=config['port'], log_level='warning', access_log=False)
