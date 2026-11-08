"""Download using only this independent peer actor's real ANP02 HTTP signature."""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from anp.authentication import generate_http_signature_headers

config = json.loads(sys.stdin.read())
peer = json.loads(Path(config['peerConfigPath']).read_text())
handle = config['handle']
assert handle.replace('-', '').isalnum()
member = Path(peer['root']) / 'members' / handle
identity = json.loads((member / 'identity.json').read_text())
key = load_pem_private_key((member / 'key.pem').read_bytes(), password=None)
url = config['url']
headers = generate_http_signature_headers(identity['document'], url, 'GET', lambda value, _: key.sign(value))
# Redirects would change the signed target and must not forward the actor signature.
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None
with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url, headers=headers, method='GET'), timeout=30) as response:
    content = response.read()
    status = response.status
    response_headers = dict(response.headers)
Path(config['downloadFile']).write_bytes(content)
print(json.dumps({'url':url,'file':config['downloadFile'],'status':status,'sizeBytes':len(content),'sha256':hashlib.sha256(content).hexdigest(),'actorDid':identity['did'],'requestHeaders':headers,'responseHeaders':response_headers}))
