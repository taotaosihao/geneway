"""Independent AWiki owner signing and read-only Host facts; no Geneway adapter import."""
import base64
import json
import sqlite3
import sys
import time
import urllib.parse
from pathlib import Path
import jcs
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from awiki_open_server.service_identity import content_digest

command = json.loads(sys.stdin.read())
config = json.loads(Path(command['peerConfigPath']).read_text())
if command['operation'] == 'seal':
    handle = command['handle']
    assert handle.replace('-', '').isalnum()
    member = Path(config['root']) / 'members' / handle
    identity = json.loads((member / 'identity.json').read_text())
    key = load_pem_private_key((member / 'key.pem').read_bytes(), password=None)
    method, body, operation_id = command['method'], command['body'], command['operationId']
    meta = {'profile':'anp.group.base.v2','security_profile':'transport-protected','sender_did':identity['did'],
            'target':{'kind':'service' if method == 'group.create' else 'group','did':command['target']},
            'operation_id':operation_id,'content_type':'application/json'}
    original = command.get('originalRequest')
    if original:
        assert original['method'] == method
        assert original['params']['body'] == body
        assert original['params']['meta']['sender_did'] == identity['did']
        assert original['params']['meta']['operation_id'] == operation_id
        assert original['params']['meta']['target'] == meta['target']
        meta = original['params']['meta']
    digest = content_digest(jcs.canonicalize({'method':method,'meta':meta,'body':body}))
    if original: assert digest == original['params']['auth']['origin_proof']['contentDigest']
    created = int(time.time())
    signature_input = f'sig1=("@method" "@target-uri" "content-digest");created={created};expires={created+300};keyid="{identity["did"]}#key-1"'
    target = meta['target']
    value = '\n'.join([f'"@method": {method}',f'"@target-uri": anp://{target["kind"]}/{urllib.parse.quote(target["did"],safe="-._~")}',f'"content-digest": {digest}',f'"@signature-params": {signature_input.split("=",1)[1]}']).encode()
    proof = {'contentDigest':digest,'signatureInput':signature_input,'signature':'sig1=:'+base64.b64encode(key.sign(value)).decode()+':'}
    envelope = {'jsonrpc':'2.0','id':original['id'] if original else operation_id,'method':method,'params':{'meta':meta,'body':body,'auth':{'scheme':'anp-rfc9421-origin-proof-v1','origin_proof':proof}}}
    print(json.dumps({'request':envelope,'body':json.dumps(envelope,separators=(',',':'),ensure_ascii=False),'actorDid':identity['did']}))
elif command['operation'] == 'snapshot':
    database = Path(config['root']) / 'data' / 'awiki-open-server.sqlite3'
    connection = sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True)
    connection.row_factory = sqlite3.Row
    group = command['groupDid']
    members = [dict(row) for row in connection.execute('SELECT agent_did,role,status,joined_at FROM hosted_group_members WHERE group_did=? ORDER BY agent_did',(group,))]
    deliveries = [dict(row) for row in connection.execute('SELECT delivery_id,group_event_seq,target_did,target_service_did,method,status,attempt_count,next_attempt_at,created_at,updated_at FROM group_delivery_outbox WHERE group_did=? ORDER BY group_event_seq,target_did,method',(group,))]
    row = connection.execute('SELECT group_did,host_service_did,group_state_version,group_event_seq FROM hosted_groups WHERE group_did=?',(group,)).fetchone()
    print(json.dumps({'database':str(database),'source':'actual-read-only-Host-SQLite','signed':False,'group':dict(row) if row else None,'members':members,'deliveries':deliveries}))
    connection.close()
else:
    raise ValueError('Unsupported independent control operation')
