"""Generate/sign only this independent peer's own actor and call actual HTTP routes."""
import base64
import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
import jcs
import base58
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, PrivateFormat, NoEncryption, load_pem_private_key
from awiki_open_server.service_identity import _sign_did_document, content_digest
from awiki_open_server.protocol.anp_adapter import ed25519_root_fingerprint

config = json.loads(Path(sys.argv[1]).read_text())
command = json.loads(sys.stdin.read())
root = Path(config['root'])
def rpc(path, method, params, token=None):
    data = json.dumps({'jsonrpc':'2.0','id':command.get('id','peer-control'),'method':method,'params':params}, separators=(',', ':'), ensure_ascii=False).encode()
    headers = {'content-type':'application/json'}
    if token: headers['authorization'] = 'Bearer ' + token
    request = urllib.request.Request(config['origin'] + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response: result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        result = json.loads(exc.read())
    if 'error' in result: raise RuntimeError(json.dumps(result))
    return result['result']
def proof(method, meta, body, key):
    digest = content_digest(jcs.canonicalize({'method':method,'meta':meta,'body':body}))
    created = int(time.time())
    signature_input = f'sig1=("@method" "@target-uri" "content-digest");created={created};expires={created+300};keyid="{meta["sender_did"]}#key-1"'
    target = meta['target']
    raw = '\n'.join([f'"@method": {method}', f'"@target-uri": anp://{target["kind"]}/{urllib.parse.quote(target["did"],safe="-._~")}', f'"content-digest": {digest}', f'"@signature-params": {signature_input.split("=",1)[1]}']).encode()
    return {'contentDigest':digest,'signatureInput':signature_input,'signature':'sig1=:' + base64.b64encode(key.sign(raw)).decode() + ':'}
handle = command.get('handle', 'independent-peer-owner')
assert handle.replace('-', '').isalnum()
member_root = root / 'members' / handle
member_root.mkdir(parents=True, exist_ok=True)
private_path = member_root / 'key.pem'
identity_path = member_root / 'identity.json'
if identity_path.exists():
    identity = json.loads(identity_path.read_text())
    key = load_pem_private_key(private_path.read_bytes(), password=None)
else:
    key = ed25519.Ed25519PrivateKey.generate()
    did = f'did:wba:{config["didDomain"]}:users:{handle}:e1_{ed25519_root_fingerprint(key.public_key())}'
    kid = did + '#key-1'
    public = 'z' + base58.b58encode(b'\xed\x01' + key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    document = {'id':did,'verificationMethod':[{'id':kid,'type':'Multikey','controller':did,'publicKeyMultibase':public}],
                'authentication':[kid],'assertionMethod':[kid],
                'service':[{'id':did+'#message','type':'ANPMessageService','serviceDid':'did:wba:'+config['didDomain'],
                            'serviceEndpoint':config['origin']+'/anp-im/rpc',
                            'profiles':['anp.direct.base.v1','anp.group.base.v2'],'securityProfiles':['transport-protected']}]}
    document = _sign_did_document(document, key, kid)
    identity = rpc('/did-auth/rpc','register',{'handle':handle,'did_document':document})
    identity['document'] = document
    private_path.write_bytes(key.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption())); private_path.chmod(0o600)
    identity_path.write_text(json.dumps(identity,indent=2));identity_path.chmod(0o600)
if command['operation'] == 'identity': result = {'did':identity['did'],'document':identity['document'],'privateKeyFile':str(private_path),'identityFile':str(identity_path)}
else:
    method = command['method']
    if method in ['inbox.get', 'group.list_messages']:
        result = rpc('/im/rpc', method, command.get('parameters', {}), identity['token'])
    else:
        target = command.get('target', 'did:wba:'+config['didDomain'])
        meta = {'profile':'anp.group.base.v2','security_profile':'transport-protected','sender_did':identity['did'],
                'target':{'kind':'service' if method=='group.create' else 'group','did':target},
                'operation_id':command['operationId'],'content_type':'application/json'}
        if method == 'group.send': meta['message_id'] = command.get('messageId','message-'+command['operationId'])
        body = command.get('body', {})
        result = rpc('/im/rpc', method, {'meta':meta,'body':body,'auth':{'scheme':'anp-rfc9421-origin-proof-v1','origin_proof':proof(method,meta,body,key)}}, identity['token'])
print(json.dumps(result,ensure_ascii=False))
